import * as vscode from 'vscode';
import type { LiveEntry, LiveRegistry } from '../claude/LiveRegistry';
import type { SessionIndex } from '../claude/SessionIndex';
import type { Notifier } from '../notify/Notifier';
import type { WindowPresence } from '../notify/WindowPresence';
import type { ProjectStore } from '../projects/ProjectStore';
import type { AttentionState, LiveSessionView } from '../shared/protocol';
import { Emitter, debounce } from '../util/events';
import type { Logger } from '../util/log';
import { folderName, isSameOrInside } from '../util/paths';
import type { AttentionReason, ManagedSession } from './ManagedSession';
import type { SessionManager } from './SessionManager';
import { sourceOf } from './sources';
import { clip, describeToolTarget } from './toolText';

const RANK: Record<AttentionState, number> = { 'needs-input': 0, error: 1, done: 2, running: 3, idle: 4 };

export interface AttentionDeps {
  store: ProjectStore;
  sessions: SessionManager;
  registry: LiveRegistry;
  index: SessionIndex;
  notifier: Notifier;
  /** Coordination with this extension in other VS Code windows. */
  presence: WindowPresence;
  log: Logger;
  /** Folder our own utility processes run in (ignored in the dashboard). */
  utilityCwd: string;
  /** Opens a managed session's panel (for toast "Open" buttons). */
  reveal(key: string): void;
}

interface ExternalTrack {
  status?: string;
  /** Turn finished while we were watching and the user has not dismissed it. */
  done: boolean;
  doneAt?: number;
}

/**
 * Everything the dashboard, the badge and notifications need: one list of
 * live sessions across all projects (ours and those running in terminals,
 * other VS Code windows or the Claude app), sorted by who needs the user.
 */
export class AttentionService implements vscode.Disposable {
  private views: LiveSessionView[] = [];
  private readonly external = new Map<number, ExternalTrack>();
  private readonly dismissed = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private firstRegistryRead = true;

  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly recompute = debounce(() => this.compute(), 80);

  constructor(private readonly deps: AttentionDeps) {
    const sub = (e: (l: () => void) => { dispose(): void }) => this.disposables.push({ dispose: e(() => this.recompute()).dispose });
    sub((l) => deps.sessions.onDidChange(l));
    sub((l) => deps.store.onDidChangeProjects(l));
    sub((l) => deps.index.onDidChange(l));
    this.disposables.push({ dispose: deps.registry.onDidChange(() => this.onRegistryChange()).dispose });
    this.disposables.push({ dispose: deps.sessions.onNeedsAttention((a) => void this.onManagedAttention(a.session, a.reason, a.detail)).dispose });
    this.compute();
  }

  get sessions(): readonly LiveSessionView[] {
    return this.views;
  }

  /** Sessions that need the user (badge count). */
  get attentionCount(): number {
    return this.views.filter((v) => v.attention === 'needs-input' || v.attention === 'done' || v.attention === 'error').length;
  }

  /** Attention state of a session (by session id) for the Projects tree. */
  bySessionId(sessionId: string): LiveSessionView | undefined {
    return this.views.find((v) => v.sessionId === sessionId);
  }

  dismiss(key: string): void {
    const managed = this.deps.sessions.get(key);
    if (managed) managed.markSeen();
    if (key.startsWith('pid:')) {
      const t = this.external.get(Number(key.slice(4)));
      if (t) t.done = false;
    }
    this.dismissed.add(key);
    this.compute();
  }

  private onRegistryChange(): void {
    const own = this.deps.sessions.ownPids();
    const seen = new Set<number>();
    for (const e of this.deps.registry.entries) {
      seen.add(e.pid);
      if (own.has(e.pid) || this.isUtility(e)) continue;
      const prev = this.external.get(e.pid);
      const track: ExternalTrack = prev ?? { done: false };
      if (!this.firstRegistryRead && prev && prev.status !== e.status) {
        if (e.status === 'waiting') void this.onExternalAttention(e, 'waiting');
        if (prev.status === 'busy' && e.status === 'idle') {
          track.done = true;
          track.doneAt = Date.now();
          this.dismissed.delete(`pid:${e.pid}`);
          void this.onExternalAttention(e, 'done');
        }
        if (e.status === 'busy') track.done = false;
      }
      track.status = e.status;
      this.external.set(e.pid, track);
    }
    for (const pid of [...this.external.keys()]) if (!seen.has(pid)) this.external.delete(pid);
    this.firstRegistryRead = false;
    this.recompute();
  }

  private isUtility(e: LiveEntry): boolean {
    return isSameOrInside(e.cwd, this.deps.utilityCwd);
  }

  private compute(): void {
    const views: LiveSessionView[] = [];
    const managedIds = new Set<string>();
    const showAll = vscode.workspace.getConfiguration('claudeProjects').get<boolean>('dashboard.showAllProjects', true);

    for (const s of this.deps.sessions.all) {
      managedIds.add(s.sessionId);
      const v = this.viewForManaged(s);
      if (v) views.push(v);
    }

    const own = this.deps.sessions.ownPids();
    const otherWindows = this.deps.presence.otherWindowsClaudePids();
    for (const e of this.deps.registry.entries) {
      if (own.has(e.pid) || this.isUtility(e)) continue;
      if (e.sessionId && managedIds.has(e.sessionId)) continue;
      const place = this.place(e.cwd);
      if (!place.projectId && !showAll) continue;
      const track = this.external.get(e.pid);
      const key = `pid:${e.pid}`;
      let attention: AttentionState = e.status === 'waiting' ? 'needs-input' : e.status === 'busy' ? 'running' : 'idle';
      if (attention === 'idle' && track?.done && !this.dismissed.has(key)) attention = 'done';
      const info = e.sessionId ? this.deps.index.get(e.sessionId) : undefined;
      const source = otherWindows.has(e.pid) ? 'other-window' : sourceOf(e.entrypoint, e.kind).source;
      views.push({
        key,
        sessionId: e.sessionId,
        cwd: e.cwd,
        projectName: place.projectName,
        projectId: place.projectId,
        branch: info?.gitBranch && info.gitBranch !== 'HEAD' ? info.gitBranch : undefined,
        isWorktree: place.isWorktree,
        title: info?.title ?? (e.name && e.nameSource !== 'derived' ? e.name : info?.firstPrompt ?? e.name ?? 'Claude session'),
        source,
        managed: false,
        pid: e.pid,
        attention,
        waitingFor: e.status === 'waiting' ? capitalize(e.waitingFor ?? 'input needed') : undefined,
        since: (attention === 'done' ? track?.doneAt : undefined) ?? e.statusUpdatedAt ?? e.updatedAt ?? e.startedAt ?? Date.now(),
      });
    }

    views.sort((a, b) => RANK[a.attention] - RANK[b.attention] || (a.attention === 'needs-input' || a.attention === 'error' ? a.since - b.since : b.since - a.since));
    const changed = JSON.stringify(views) !== JSON.stringify(this.views);
    this.views = views;
    if (changed) this._onDidChange.fire();
  }

  private viewForManaged(s: ManagedSession): LiveSessionView | undefined {
    const pending = s.pendingRequests[0];
    let attention: AttentionState;
    if (s.status === 'error') attention = 'error';
    else if (pending || s.status === 'waiting') attention = 'needs-input';
    else if (s.status === 'running' || s.status === 'starting') attention = 'running';
    else if (s.unread && !this.dismissed.has(s.key)) attention = 'done';
    else attention = 'idle';
    // Sessions that are only being read (no process, nothing pending) are not "running".
    if (attention === 'idle' && !s.processAlive) return undefined;
    if (s.status === 'new' && !s.processAlive) return undefined;

    let waitingFor: string | undefined;
    let detail: string | undefined;
    let quickPermission: LiveSessionView['quickPermission'];
    if (pending?.kind === 'permission') {
      waitingFor = `Permission: ${pending.displayName ?? pending.toolName}`;
      detail = describeToolTarget(pending.toolName, pending.input, s.cwd) ?? pending.description;
      if (pending.options[0]?.id === 'allow') quickPermission = { requestId: pending.requestId, allowOptionId: 'allow' };
    } else if (pending?.kind === 'question') {
      waitingFor = 'Question';
      detail = pending.questions[0]?.question;
    } else if (pending?.kind === 'plan') {
      waitingFor = 'Plan review';
      detail = clip(pending.plan.replace(/^#+\s*/gm, ''), 140);
    } else if (pending?.kind === 'elicitation') {
      waitingFor = `Input for ${pending.title ?? pending.serverName}`;
      detail = pending.message;
    } else if (attention === 'error') {
      detail = s.error;
    } else if (attention === 'done') {
      waitingFor = 'Finished';
      detail = s.lastAssistantText ? clip(s.lastAssistantText, 140) : undefined;
    }
    const place = this.place(s.cwd);
    return {
      key: s.key,
      sessionId: s.sessionId,
      cwd: s.cwd,
      projectName: place.projectName,
      projectId: place.projectId,
      branch: s.branch,
      isWorktree: place.isWorktree,
      title: s.title,
      source: 'here',
      managed: true,
      pid: s.pid,
      attention,
      waitingFor,
      detail,
      activity: attention === 'running' ? s.activity : undefined,
      since: pending?.createdAt ?? s.statusSince,
      quickPermission,
    };
  }

  private place(cwd: string): { projectName: string; projectId?: string; isWorktree?: boolean } {
    const project = this.deps.store.findContaining(cwd);
    if (project) {
      const sub = cwd === project.path ? undefined : folderName(cwd);
      return { projectName: sub ? `${project.name} · ${sub}` : project.name, projectId: project.id, isWorktree: !!sub && /\/\.claude\/worktrees\/|worktree/i.test(cwd) };
    }
    // Worktrees of a registered repo often live outside it; match by any project whose name prefixes the folder.
    return { projectName: folderName(cwd) };
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  private config() {
    const c = vscode.workspace.getConfiguration('claudeProjects.notifications');
    return {
      enabled: c.get<boolean>('enabled', true),
      onlyWhenUnfocused: c.get<boolean>('onlyWhenUnfocused', true),
      onTurnComplete: c.get<boolean>('onTurnComplete', true),
      external: c.get<boolean>('externalSessions', true),
      sound: c.get<boolean>('sound', true),
      toasts: c.get<boolean>('inAppToasts', true),
    };
  }

  private async onManagedAttention(s: ManagedSession, reason: AttentionReason, detail?: string): Promise<void> {
    this.dismissed.delete(s.key);
    const cfg = this.config();
    if (!cfg.enabled) return;
    if (reason === 'done' && !cfg.onTurnComplete) return;
    const windowFocused = vscode.window.state.focused;
    if (windowFocused && s.focused) return; // the user is looking at it
    const place = this.place(s.cwd).projectName;
    const headline =
      reason === 'permission'
        ? 'Claude needs your permission'
        : reason === 'question'
          ? 'Claude has a question'
          : reason === 'plan'
            ? 'Plan ready for review'
            : reason === 'input'
              ? 'An MCP server needs your input'
              : reason === 'error'
                ? 'Claude stopped'
                : 'Claude finished';
    if (!windowFocused || !cfg.onlyWhenUnfocused) {
      await this.deps.notifier.notify({
        title: `${headline} · ${place}`,
        subtitle: clip(s.title, 80),
        message: detail ? clip(detail, 180) : reason === 'done' ? 'Waiting for your next message.' : 'Open the session to respond.',
        group: s.key,
        openPath: `/session?key=${encodeURIComponent(s.key)}`,
        sound: cfg.sound && reason !== 'done',
      });
      return;
    }
    if (cfg.toasts && reason !== 'done') {
      const pick = await vscode.window.showInformationMessage(`${headline} in ${place}: ${clip(detail ?? s.title, 120)}`, 'Open');
      if (pick === 'Open') this.deps.reveal(s.key);
    }
  }

  private async onExternalAttention(e: LiveEntry, kind: 'waiting' | 'done'): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.external) return;
    if (kind === 'done' && !cfg.onTurnComplete) return;
    const place = this.place(e.cwd);
    if (!place.projectId) return; // only for the user's projects
    // Sessions run by Claude Projects in another window are announced by that window.
    if (this.deps.presence.otherWindowsClaudePids().has(e.pid)) return;
    // While you're in VS Code the badge and dashboard cover it.
    if (cfg.onlyWhenUnfocused && (vscode.window.state.focused || this.deps.presence.anotherWindowFocused())) return;
    // Every window sees the same event; only one of them notifies.
    if (!this.deps.presence.claim(`${e.pid}:${kind}:${e.statusUpdatedAt ?? ''}`)) return;
    const { label } = sourceOf(e.entrypoint, e.kind);
    const info = e.sessionId ? this.deps.index.get(e.sessionId) : undefined;
    await this.deps.notifier.notify({
      title: `${kind === 'waiting' ? 'Claude is waiting for you' : 'Claude finished'} · ${place.projectName}`,
      subtitle: clip(info?.title ?? e.name ?? 'Claude session', 80),
      message: kind === 'waiting' ? `${capitalize(e.waitingFor ?? 'input needed')} (${label})` : `Waiting for your next message (${label}).`,
      group: `pid-${e.pid}`,
      openPath: `/dashboard`,
      sound: cfg.sound && kind === 'waiting',
    });
  }

  dispose(): void {
    this.recompute.cancel();
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
