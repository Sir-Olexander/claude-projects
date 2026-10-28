import * as vscode from 'vscode';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { HandoffService } from '../handoff/Handoff';
import type { ProjectStore } from '../projects/ProjectStore';
import type { SessionIndex } from '../claude/SessionIndex';
import { forkTitle, type ForkSource, type ManagedSession } from '../sessions/ManagedSession';
import type { SessionManager } from '../sessions/SessionManager';
import { getCurrentBranch } from '../git/gitCli';
import { Emitter } from '../util/events';
import type { Logger } from '../util/log';
import { folderName } from '../util/paths';
import { CHAT_VIEW_TYPE, ChatPanel } from './ChatPanel';
import { PROPOSED_SCHEME, ProposedContentProvider } from './diffs';
import { mapChatTabs, type UnloadedTab } from './unloadedTabs';

/**
 * Folder of cached chat images as a plain file: URI. globalStorageUri can use
 * VS Code's own vscode-userdata: scheme, which never matches the file: URLs the
 * images are served from, so webviews would refuse them (HTTP 401).
 */
function imageCacheUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.file(join(context.globalStorageUri.fsPath, 'images'));
}

interface PersistedPanelState {
  session?: { key?: string; sessionId?: string; cwd?: string; title?: string; forkFrom?: ForkSource };
}

export interface ChatPanelManagerDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  sessions: SessionManager;
  store: ProjectStore;
  index: SessionIndex;
  handoff: HandoffService;
}

/** Creates, reveals and restores chat tabs; one tab per session. */
export class ChatPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, ChatPanel>();
  private readonly proposed = new ProposedContentProvider();
  private readonly disposables: vscode.Disposable[] = [];
  private activeKey: string | undefined;

  private readonly _onDidChangeTabs = new Emitter<void>();
  /** A chat tab was opened or closed. */
  readonly onDidChangeTabs = this._onDidChangeTabs.event;

  constructor(private readonly deps: ChatPanelManagerDeps) {
    this.disposables.push(this.proposed, vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this.proposed));
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: PersistedPanelState | undefined) => this.restore(panel, state),
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this._onDidChangeTabs.fire()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this._onDidChangeTabs.fire()),
      this._onDidChangeTabs.event(() => this.renumber()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeProjects.chat.numberTabs')) this.renumber();
      }),
    );
  }

  private get host() {
    const { context, log } = this.deps;
    return {
      extensionUri: context.extensionUri,
      imageDir: imageCacheUri(context),
      log,
      proposed: this.proposed,
      openInClaudeExtension: (s: ManagedSession) => this.openInClaudeExtension(s),
      newSession: (cwd: string) => void this.newSession(cwd),
      fork: (s: ManagedSession, itemId: string) => void this.fork(s, itemId),
      onActive: (s: ManagedSession) => this.onActive(s),
      onDispose: (p: ChatPanel) => {
        if (this.panels.get(p.session.key) === p) {
          this.panels.delete(p.session.key);
          this._onDidChangeTabs.fire();
        }
      },
    };
  }

  get activeSession(): ManagedSession | undefined {
    const key = this.activeKey;
    const p = key ? this.panels.get(key) : undefined;
    return p?.panel.active ? p.session : undefined;
  }

  hasPanel(key: string): boolean {
    return this.panels.has(key);
  }

  /** Closes a session's tab, if it has one. */
  closeTab(key: string): void {
    this.panels.get(key)?.panel.dispose();
  }

  private mapTabs(): { unloaded: UnloadedTab[]; numbers: Map<ChatPanel, number | undefined> } {
    const groups = vscode.window.tabGroups.all.map((g) => ({
      viewColumn: g.viewColumn,
      tabs: g.tabs.map((t) => ({ label: t.label, viewType: t.input instanceof vscode.TabInputWebview ? t.input.viewType : undefined })),
    }));
    const panels = [...this.panels.values()];
    const map = mapChatTabs(groups, panels.map((p) => ({ viewColumn: p.panel.viewColumn, title: p.panel.title })), CHAT_VIEW_TYPE);
    return { unloaded: map.unloaded, numbers: new Map(panels.map((p, i) => [p, map.panelNumbers[i]])) };
  }

  /** Chat tabs restored from the last session that VS Code hasn't loaded yet (it does on first show). */
  unloadedTabs(): UnloadedTab[] {
    return this.mapTabs().unloaded;
  }

  /** Number shown on a session's tab (0, 1, 2… left to right), if numbering is on. */
  tabNumber(key: string): number | undefined {
    return this.panels.get(key)?.number;
  }

  get numberingOn(): boolean {
    return vscode.workspace.getConfiguration('claudeProjects').get<boolean>('chat.numberTabs', true);
  }

  /** Puts each chat tab's number at the start of its title. */
  private renumber(): void {
    const on = this.numberingOn;
    const { numbers } = this.mapTabs();
    // A tab VS Code hasn't reported yet keeps its number until the next tab event.
    for (const [p, n] of numbers) p.setNumber(on ? (n ?? p.number) : undefined);
  }

  private unloadedTab(key: string): { info: UnloadedTab; tab: vscode.Tab } | undefined {
    const info = this.unloadedTabs().find((t) => t.key === key);
    const tab = info && vscode.window.tabGroups.all.find((g) => g.viewColumn === info.viewColumn)?.tabs[info.index];
    return info && tab ? { info, tab } : undefined;
  }

  async closeUnloadedTab(key: string): Promise<void> {
    const t = this.unloadedTab(key);
    if (t) await vscode.window.tabGroups.close(t.tab, true);
  }

  /** Shows an unloaded tab, which makes VS Code load it. */
  async showUnloadedTab(key: string): Promise<void> {
    const t = this.unloadedTab(key);
    if (!t) return;
    const groups = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
    const group = groups[t.info.viewColumn - 1];
    if (group) await vscode.commands.executeCommand(`workbench.action.focus${group}EditorGroup`);
    await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', t.info.index);
  }

  /** Shows a session in its tab (creating the tab if needed). */
  show(session: ManagedSession, opts: { preserveFocus?: boolean; viewColumn?: vscode.ViewColumn } = {}): ChatPanel {
    const existing = this.panels.get(session.key);
    if (existing) {
      existing.reveal(opts.preserveFocus);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      session.title,
      { viewColumn: opts.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
        // Set here, not only later: the folders a webview may load files from (bundle + cached images).
        localResourceRoots: [vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'webview'), imageCacheUri(this.deps.context)],
      },
    );
    return this.attach(panel, session);
  }

  private attach(panel: vscode.WebviewPanel, session: ManagedSession): ChatPanel {
    const cp = new ChatPanel(panel, session, this.host);
    this.panels.set(session.key, cp);
    this._onDidChangeTabs.fire();
    return cp;
  }

  private async restore(panel: vscode.WebviewPanel, state: PersistedPanelState | undefined): Promise<void> {
    const s = state?.session;
    if (!s?.cwd || !existsSync(s.cwd)) {
      panel.dispose();
      return;
    }
    const project = this.deps.store.findContaining(s.cwd);
    const branch = await getCurrentBranch(s.cwd).catch(() => undefined);
    let session: ManagedSession;
    if (s.sessionId) {
      session = this.deps.sessions.openExisting({
        sessionId: s.sessionId,
        cwd: s.cwd,
        projectName: project?.name ?? folderName(s.cwd),
        branch,
        isWorktree: !!project && project.path !== s.cwd,
        title: this.deps.index.get(s.sessionId)?.title ?? s.title,
      });
    } else if (s.forkFrom?.sessionId && s.forkFrom.at) {
      session = this.deps.sessions.createNew({ cwd: s.cwd, projectName: project?.name ?? folderName(s.cwd), branch, isWorktree: !!project && project.path !== s.cwd, forkFrom: s.forkFrom, title: s.title });
    } else {
      session = this.deps.sessions.createNew({ cwd: s.cwd, projectName: project?.name ?? folderName(s.cwd), branch, isWorktree: !!project && project.path !== s.cwd });
    }
    if (this.panels.has(session.key)) {
      panel.dispose();
      return;
    }
    this.attach(panel, session);
  }

  /** Starts a new session in `cwd` and shows it. */
  async newSession(cwd: string): Promise<ManagedSession> {
    const project = this.deps.store.findContaining(cwd);
    const branch = await getCurrentBranch(cwd).catch(() => undefined);
    const session = this.deps.sessions.createNew({ cwd, projectName: project?.name ?? folderName(cwd), branch, isWorktree: !!project && project.path !== cwd });
    this.show(session);
    return session;
  }

  /**
   * Opens a new chat that continues `source`'s conversation from one of its
   * replies (that reply included). The original session is left untouched.
   */
  fork(source: ManagedSession, itemId: string): ManagedSession | undefined {
    const from = source.forkPoint(itemId);
    if (!from) {
      void vscode.window.showWarningMessage("Can't fork from this message: it isn't saved in the session yet.");
      return undefined;
    }
    const taken = [...this.deps.index.sessionsFor(source.cwd).map((i) => i.title), ...this.deps.sessions.all.map((s) => s.title)];
    const session = this.deps.sessions.createNew({
      cwd: source.cwd,
      projectName: source.projectName,
      branch: source.branch,
      isWorktree: source.isWorktree,
      permissionMode: source.permissionMode,
      model: source.modelValue,
      forkFrom: from,
      title: forkTitle(from.title, taken),
      sharedEnv: [...source.sharedEnvNames],
    });
    // The fork's file will carry its original's name: the fork's own name wins from the start.
    this.deps.index.rememberTitle(session.sessionId, session.title);
    this.show(session);
    return session;
  }

  /** Opens an existing session by id in its tab. */
  async openExisting(sessionId: string, cwd: string, title?: string): Promise<ManagedSession> {
    const project = this.deps.store.findContaining(cwd);
    const branch = await getCurrentBranch(cwd).catch(() => undefined);
    const session = this.deps.sessions.openExisting({
      sessionId,
      cwd,
      projectName: project?.name ?? folderName(cwd),
      branch,
      isWorktree: !!project && project.path !== cwd,
      title: title ?? this.deps.index.get(sessionId)?.title,
    });
    this.show(session);
    return session;
  }

  /** Opens a session's tab and scrolls to one of its messages. */
  async revealItem(sessionId: string, cwd: string, itemId: string): Promise<void> {
    const managed = this.deps.sessions.findBySessionId(sessionId) ?? (await this.openExisting(sessionId, cwd));
    const panel = this.show(managed);
    panel.scrollTo(itemId);
  }

  reveal(key: string): boolean {
    const session = this.deps.sessions.get(key);
    if (!session) return false;
    this.show(session);
    return true;
  }

  async openInClaudeExtension(session: ManagedSession): Promise<void> {
    if (session.processAlive) {
      if (session.status === 'running' || session.status === 'waiting') {
        const pick = await vscode.window.showWarningMessage(
          'Claude is working on this session here. Stop it here and continue in the Claude extension?',
          { modal: true },
          'Stop Here and Open There',
        );
        if (pick !== 'Stop Here and Open There') return;
      }
      await session.stopProcess();
    }
    const panel = this.panels.get(session.key);
    await this.deps.handoff.openInClaudeExtension(session.cwd, session.isNew ? undefined : session.sessionId);
    panel?.dispose();
  }

  private onActive(session: ManagedSession): void {
    this.activeKey = session.key;
    if (!vscode.workspace.getConfiguration('claudeProjects').get<boolean>('followActiveSession', true)) return;
    const project = this.deps.store.findContaining(session.cwd);
    if (project) this.deps.store.select(project.id, session.cwd);
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) p.dispose();
    this.panels.clear();
    for (const d of this.disposables) d.dispose();
    this._onDidChangeTabs.dispose();
  }
}
