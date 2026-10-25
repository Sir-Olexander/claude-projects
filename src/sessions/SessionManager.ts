import * as vscode from 'vscode';
import { join } from 'node:path';
import { childPath, locateClaude } from '../claude/cliLocator';
import type { LiveRegistry } from '../claude/LiveRegistry';
import type { SessionIndex } from '../claude/SessionIndex';
import type { InitializeResponse, ModelInfo, SdkRateLimitEvent, SlashCommand } from '../claude/sdkTypes';
import { transcriptPathFor } from '../claude/paths';
import type { PermissionMode, PromptPreset } from '../shared/protocol';
import { Emitter } from '../util/events';
import type { Logger } from '../util/log';
import { ImageCache } from './imageCache';
import { ManagedSession, asEffort, type AttentionReason, type ManagedSessionInit, type ProbedDefaults, type SessionServices, type SessionSettings } from './ManagedSession';
import { ClaudeProcess } from '../claude/ClaudeProcess';
import type { BookmarkStore, StoredBookmark } from './bookmarks';
import { sourceOf } from './sources';

export interface SessionManagerDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  index: SessionIndex;
  registry: LiveRegistry;
  onRateLimit(e: SdkRateLimitEvent): void;
}

/** All sessions opened "here" in this window. */
export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly _onDidChange = new Emitter<ManagedSession | undefined>();
  /** A session was added/removed or changed status, title, pending requests… */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onNeedsAttention = new Emitter<{ session: ManagedSession; reason: AttentionReason; detail?: string }>();
  readonly onNeedsAttention = this._onNeedsAttention.event;

  private readonly services: SessionServices;
  /** Message bookmarks of every session (shared by all windows through global state). */
  readonly bookmarkStore: BookmarkStore & { all(): Record<string, StoredBookmark[]> };
  private readonly sharedInit: { models?: ModelInfo[]; commands?: SlashCommand[] };
  private cliPath: Promise<string | undefined> | undefined;
  private pathEnv: Promise<string> | undefined;
  private readonly reaper: ReturnType<typeof setInterval>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: SessionManagerDeps) {
    const { context, log, index } = deps;
    const imageCache = new ImageCache(join(context.globalStorageUri.fsPath, 'images'));
    this.sharedInit = context.globalState.get<{ models?: ModelInfo[]; commands?: SlashCommand[] }>('claudeProjects.sharedInit', {});
    this.bookmarkStore = globalStateBookmarks(context);
    this.services = {
      log,
      getCliPath: () => this.getCliPath(),
      getPathEnv: () => (this.pathEnv ??= childPath()),
      settings: () => readSettings(),
      imageSink: imageCache.externalize,
      sharedInit: this.sharedInit,
      onInitialized: (init: InitializeResponse) => {
        let changed = false;
        if (init.models?.length) {
          this.sharedInit.models = init.models;
          changed = true;
        }
        if (init.commands?.length) {
          this.sharedInit.commands = init.commands;
          changed = true;
        }
        if (changed) void context.globalState.update('claudeProjects.sharedInit', this.sharedInit);
      },
      onRateLimit: (e) => deps.onRateLimit(e),
      onTranscriptActivity: (sessionId, cwd) => index.touch(transcriptPathFor(cwd, sessionId)),
      bookmarks: this.bookmarkStore,
      probeDefaults: (cwd) => this.probeDefaults(cwd),
    };

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeProjects.claudePath')) this.cliPath = undefined;
        if (e.affectsConfiguration('claudeProjects.chat')) for (const s of this.sessions.values()) s.settingsChanged();
      }),
    );
    this.disposables.push({ dispose: index.onDidChange(() => this.syncTitles()).dispose });
    this.disposables.push({ dispose: deps.registry.onDidChange(() => this.syncLiveElsewhere()).dispose });
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
  }

  private readonly defaultsCache = new Map<string, { at: number; value: Promise<ProbedDefaults | undefined> }>();

  /**
   * Asks Claude Code which model and effort it would use in `cwd`, without a
   * model call: a safe-mode CLI process (no hooks, plugins or MCP servers, no
   * transcript) answers initialize + get_settings and exits. Cached per folder.
   */
  probeDefaults(cwd: string): Promise<ProbedDefaults | undefined> {
    const hit = this.defaultsCache.get(cwd);
    if (hit && Date.now() - hit.at < 120_000) return hit.value;
    const value = (async (): Promise<ProbedDefaults | undefined> => {
      const cliPath = await this.getCliPath();
      if (!cliPath) return undefined;
      const proc = new ClaudeProcess({
        cliPath,
        cwd,
        noSessionPersistence: true,
        safeMode: true,
        strictMcpConfig: true,
        includePartialMessages: false,
        pathEnv: await this.services.getPathEnv(),
        log: this.deps.log,
      });
      proc.start();
      try {
        const init = await proc.initialize();
        const s = await proc.request<{ applied?: { model?: string; effort?: string | null } }>({ subtype: 'get_settings' }, 15_000);
        return { model: s.applied?.model, effort: s.applied?.effort, models: init.models };
      } catch (err) {
        this.deps.log.debug(`probing defaults in ${cwd} failed: ${(err as Error).message}`);
        return undefined;
      } finally {
        void proc.close(1000);
      }
    })();
    this.defaultsCache.set(cwd, { at: Date.now(), value });
    return value;
  }

  getCliPath(): Promise<string | undefined> {
    if (!this.cliPath) {
      const configured = vscode.workspace.getConfiguration('claudeProjects').get<string>('claudePath');
      this.cliPath = locateClaude(configured).then((loc) => {
        if (loc) this.deps.log.info(`claude CLI: ${loc.path} (${loc.source})`);
        else this.deps.log.warn('claude CLI not found');
        return loc?.path;
      });
    }
    return this.cliPath;
  }

  get all(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  get(key: string): ManagedSession | undefined {
    return this.sessions.get(key);
  }

  findBySessionId(sessionId: string): ManagedSession | undefined {
    for (const s of this.sessions.values()) if (s.sessionId === sessionId || s.key === sessionId) return s;
    return undefined;
  }

  /** Opens (or returns) the managed session for an existing transcript. */
  openExisting(init: ManagedSessionInit & { sessionId: string }): ManagedSession {
    const existing = this.findBySessionId(init.sessionId);
    if (existing) return existing;
    return this.add(new ManagedSession(init, this.services));
  }

  createNew(init: Omit<ManagedSessionInit, 'sessionId'>): ManagedSession {
    return this.add(new ManagedSession(init, this.services));
  }

  private add(session: ManagedSession): ManagedSession {
    this.sessions.set(session.key, session);
    void session.loadDefaults();
    session.onDidChange(() => this._onDidChange.fire(session));
    session.onNeedsAttention((a) => this._onNeedsAttention.fire({ session, ...a }));
    this.syncLiveElsewhere();
    this._onDidChange.fire(session);
    return session;
  }

  /** Stops the process and forgets the session (its transcript stays on disk). */
  async close(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    await s.stopProcess();
    s.dispose();
    this._onDidChange.fire(undefined);
  }

  /** Our own Claude processes (so the live registry can tell them apart from other windows'). */
  ownPids(): Set<number> {
    const pids = new Set<number>();
    for (const s of this.sessions.values()) if (s.pid) pids.add(s.pid);
    return pids;
  }

  private syncTitles(): void {
    for (const s of this.sessions.values()) {
      const info = this.deps.index.get(s.sessionId);
      if (!info) continue;
      if (info.customTitle) s.setTitle(info.customTitle, true);
      else if (info.aiTitle) s.setTitle(info.aiTitle, false);
    }
  }

  private syncLiveElsewhere(): void {
    const own = this.ownPids();
    for (const s of this.sessions.values()) {
      const other = this.deps.registry.bySessionId(s.sessionId).find((e) => !own.has(e.pid));
      s.setLiveElsewhere(other ? { source: sourceOf(other.entrypoint, other.kind).label, pid: other.pid, status: other.status } : undefined);
    }
  }

  private reapIdle(): void {
    const minutes = vscode.workspace.getConfiguration('claudeProjects').get<number>('sessions.idleProcessTimeoutMinutes', 30);
    if (!minutes || minutes <= 0) return;
    const cutoff = Date.now() - minutes * 60_000;
    for (const s of this.sessions.values()) {
      if (!s.processAlive || s.visibleCount > 0) continue;
      if (s.status !== 'idle' || s.pendingRequests.length > 0) continue;
      if (s.lastActivityAt > cutoff) continue;
      this.deps.log.info(`stopping idle Claude process for ${s.sessionId}`);
      void s.stopProcess();
    }
  }

  async disposeAsync(): Promise<void> {
    await Promise.all(this.all.map((s) => s.stopProcess().catch(() => {})));
  }

  dispose(): void {
    clearInterval(this.reaper);
    for (const d of this.disposables) d.dispose();
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this._onDidChange.dispose();
    this._onNeedsAttention.dispose();
  }
}

export function readSettings(): SessionSettings {
  const c = vscode.workspace.getConfiguration('claudeProjects');
  return {
    defaultPermissionMode: c.get<PermissionMode>('chat.defaultPermissionMode', 'default'),
    defaultModel: c.get<string>('chat.defaultModel', ''),
    allowBypass: c.get<boolean>('chat.allowBypassPermissions', false),
    showThinking: c.get<boolean>('chat.showThinking', true),
    defaultEffort: asEffort(c.get<string>('chat.defaultEffort', '')) ?? '',
    promptPresets: (c.get<unknown[]>('chat.promptPresets', []) ?? [])
      .filter((p): p is PromptPreset => !!p && typeof (p as PromptPreset).label === 'string' && typeof (p as PromptPreset).prompt === 'string' && !!(p as PromptPreset).label.trim()),
  };
}

const BOOKMARKS_KEY = 'claudeProjects.bookmarks.v1';

function globalStateBookmarks(context: vscode.ExtensionContext): BookmarkStore & { all(): Record<string, StoredBookmark[]> } {
  const all = () => context.globalState.get<Record<string, StoredBookmark[]>>(BOOKMARKS_KEY, {});
  return {
    all,
    load: (sessionId) => [...(all()[sessionId] ?? [])],
    save: (sessionId, list) => {
      const next = { ...all() };
      if (list.length) next[sessionId] = list;
      else delete next[sessionId];
      void context.globalState.update(BOOKMARKS_KEY, next);
    },
  };
}
