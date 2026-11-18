import * as vscode from 'vscode';
import type { AttentionService } from '../sessions/AttentionService';
import type { ManagedSession } from '../sessions/ManagedSession';
import type { SessionManager } from '../sessions/SessionManager';
import type { SessionFlags } from '../sessions/flags';
import type { ProjectStore } from '../projects/ProjectStore';
import type {
  ExtToHubMessage,
  HubPersisted,
  HubPersistedSession,
  HubRepoView,
  HubSessionView,
  HubState,
  HubToExtMessage,
} from '../shared/protocol';
import { Emitter, debounce } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import { folderName } from '../util/paths';
import { ChatBridge, type ChatHost } from './ChatBridge';
import { webviewHtml } from './webviewHtml';

export const HUB_VIEW_TYPE = 'claudeProjects.hub';
export const HUB_TITLE = 'Claude Chats';
export const MAX_PANES = 3;
/** Number of colours in the hub's palette (see hub.css). */
const PALETTE_SIZE = 8;

export interface SessionHubDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  sessions: SessionManager;
  attention: AttentionService;
  store: ProjectStore;
  flags: SessionFlags;
  chatHost: ChatHost;
  imageDir: vscode.Uri;
  /** Reopens the sessions of a restored hub (keys of new sessions change). */
  restoreSession(s: HubPersistedSession): Promise<ManagedSession | undefined>;
  /** The focused pane's session became the active chat. */
  onActive(session: ManagedSession): void;
  popOut(session: ManagedSession): void;
  newSession(cwd: string): void;
  deleteSessions(sessions: { sessionId: string; cwd: string; title: string }[]): Promise<void>;
}

/**
 * The sessions hub: one editor tab that holds every "Open here" session of
 * this window. A two-row strip picks a project, then one of its sessions;
 * up to three chats show side by side.
 */
export class SessionHub implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelSubs: vscode.Disposable[] = [];
  /** Open sessions, in the order they were opened. */
  private open: string[] = [];
  private panes: (string | null)[] = [null];
  private focusedPane = 0;
  private followSeq = 0;
  private readonly bridges = new Map<string, ChatBridge>();
  /** Sessions whose visibleCount this hub has raised. */
  private readonly counted = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pushSoon = debounce(() => this.pushState(), 50);

  private readonly _onDidChange = new Emitter<void>();
  /** Sessions were added to or removed from the hub. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly deps: SessionHubDeps) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(HUB_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: { hub?: HubPersisted } | undefined) => this.restore(panel, state?.hub),
      }),
      vscode.window.onDidChangeWindowState(() => this.syncFocus()),
    );
    const sub = (e: (l: () => void) => { dispose(): void }) => this.disposables.push({ dispose: e(() => this.pushSoon()).dispose });
    sub((l) => deps.attention.onDidChange(l));
    sub((l) => deps.flags.onDidChange(l));
    sub((l) => deps.store.onDidChangeProjects(l));
    this.disposables.push({ dispose: deps.sessions.onDidChange(() => this.prune()).dispose });
  }

  // ---------------------------------------------------------------------------
  // Queries

  has(key: string): boolean {
    return this.open.includes(key);
  }

  get keys(): readonly string[] {
    return this.open;
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** What the strip shows (for tests). */
  get snapshot(): HubState {
    return this.state();
  }

  /** The chat of a session shown in a pane has loaded its state (for tests). */
  chatReady(key: string): boolean {
    return !!this.bridges.get(key)?.isReady;
  }

  /** The hub's editor tab (for tests). */
  get webviewPanel(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  /** The focused pane's session, while the hub is the active editor. */
  get activeSession(): ManagedSession | undefined {
    if (!this.panel?.active) return undefined;
    const key = this.panes[this.focusedPane];
    return key ? this.deps.sessions.get(key) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Actions

  /** Opens the hub (empty when nothing is open yet). */
  reveal(preserveFocus = false): void {
    if (this.panel) this.panel.reveal(undefined, preserveFocus);
    else this.createPanel(preserveFocus);
  }

  /**
   * Adds a session to the hub and shows it: in the pane that already shows it,
   * else in `pane`, else in the focused pane.
   */
  show(session: ManagedSession, opts: { preserveFocus?: boolean; pane?: number } = {}): void {
    const key = session.key;
    this.enteredAt.set(key, Date.now());
    if (!this.open.includes(key)) {
      this.open.push(key);
      this._onDidChange.fire();
    }
    const at = this.panes.indexOf(key);
    if (at >= 0) this.focusedPane = at;
    else {
      const pane = opts.pane !== undefined && opts.pane >= 0 && opts.pane < this.panes.length ? opts.pane : this.focusedPane;
      this.panes[pane] = key;
      this.focusedPane = pane;
    }
    this.followSeq++;
    this.reveal(opts.preserveFocus);
    this.changed();
  }

  /** Scrolls a session's chat to one of its messages (bookmarks). */
  scrollTo(session: ManagedSession, itemId: string): void {
    this.show(session);
    this.bridges.get(session.key)?.scrollTo(itemId);
  }

  /** Takes sessions off the hub. */
  close(keys: string[]): void {
    let removed = false;
    for (const key of keys) {
      const i = this.open.indexOf(key);
      if (i < 0) continue;
      this.open.splice(i, 1);
      this.enteredAt.delete(key);
      removed = true;
      this.panes = this.panes.map((k) => (k === key ? null : k));
    }
    if (!removed) return;
    this._onDidChange.fire();
    this.changed();
  }

  private setPaneCount(count: number): void {
    const n = Math.max(1, Math.min(MAX_PANES, Math.round(count)));
    if (n === this.panes.length) return;
    if (n > this.panes.length) {
      // New panes start with open sessions that aren't shown yet, if any.
      const spare = this.open.filter((k) => !this.panes.includes(k));
      while (this.panes.length < n) this.panes.push(spare.shift() ?? null);
    } else {
      // Drop empty panes first, then the last ones.
      let panes = [...this.panes];
      while (panes.length > n) {
        const empty = panes.lastIndexOf(null);
        panes.splice(empty >= 0 ? empty : panes.length - 1, 1);
      }
      const focusedKey = this.panes[this.focusedPane];
      this.panes = panes;
      const at = focusedKey ? panes.indexOf(focusedKey) : -1;
      this.focusedPane = at >= 0 ? at : Math.min(this.focusedPane, n - 1);
    }
    this.changed();
  }

  private closePane(pane: number): void {
    if (pane < 0 || pane >= this.panes.length) return;
    if (this.panes.length === 1) this.panes = [null];
    else {
      this.panes.splice(pane, 1);
      if (this.focusedPane >= this.panes.length || this.focusedPane > pane) this.focusedPane = Math.max(0, this.focusedPane - 1);
    }
    this.followSeq++;
    this.changed();
  }

  private focusPane(pane: number): void {
    if (pane < 0 || pane >= this.panes.length || pane === this.focusedPane) return;
    this.focusedPane = pane;
    this.followSeq++;
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Panel

  private createPanel(preserveFocus = false): void {
    const { context, imageDir } = this.deps;
    const panel = vscode.window.createWebviewPanel(
      HUB_VIEW_TYPE,
      HUB_TITLE,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), imageDir],
      },
    );
    this.attach(panel);
  }

  private attach(panel: vscode.WebviewPanel): void {
    const { context, imageDir } = this.deps;
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), imageDir],
    };
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', 'claude-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', 'claude-dark.svg'),
    };
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, 'hub', HUB_TITLE);
    this.panelSubs = [
      panel.webview.onDidReceiveMessage((m: HubToExtMessage) => void this.onMessage(m)),
      panel.onDidChangeViewState(() => this.syncFocus()),
      panel.onDidDispose(() => this.onPanelDisposed()),
    ];
    this.updateTitle();
    this.syncBridges();
  }

  private async restore(panel: vscode.WebviewPanel, saved: HubPersisted | undefined): Promise<void> {
    if (this.panel) {
      // Already opened (a session was shown before VS Code restored the tab).
      panel.dispose();
      this.panel.reveal(undefined, true);
      return;
    }
    this.repoOrder = [...(saved?.repoOrder ?? [])];
    const keyMap = new Map<string, string>();
    for (const s of saved?.sessions ?? []) {
      try {
        const session = await this.deps.restoreSession(s);
        if (!session) continue;
        keyMap.set(s.key, session.key);
        if (s.enteredAt) this.enteredAt.set(session.key, s.enteredAt);
        if (!this.open.includes(session.key)) this.open.push(session.key);
      } catch (err) {
        this.deps.log.warn(`could not reopen hub session ${s.sessionId}: ${errorMessage(err)}`);
      }
    }
    // Sessions shown while the tab was being restored come first in the panes.
    const restoredPanes = (saved?.panes ?? [null]).slice(0, MAX_PANES).map((k) => (k ? keyMap.get(k) ?? null : null));
    const current = this.panes.filter((k): k is string => !!k);
    this.panes = restoredPanes.length ? restoredPanes : [null];
    for (const k of current) if (!this.panes.includes(k)) this.panes[this.focusedPane] = k;
    this.focusedPane = Math.max(0, Math.min(saved?.focusedPane ?? 0, this.panes.length - 1));
    this.followSeq++;
    this._onDidChange.fire();
    this.attach(panel);
    this.changed();
  }

  private onPanelDisposed(): void {
    for (const d of this.panelSubs) d.dispose();
    this.panelSubs = [];
    this.panel = undefined;
    // Closing the hub closes its chats, like closing their tabs.
    this.open = [];
    this.panes = [null];
    this.focusedPane = 0;
    this.syncBridges();
    this._onDidChange.fire();
  }

  private updateTitle(): void {
    if (!this.panel) return;
    let needs = 0;
    for (const key of this.open) {
      const s = this.deps.sessions.get(key);
      if (s && (s.status === 'waiting' || s.pendingRequests.length)) needs++;
    }
    const title = needs ? `${HUB_TITLE} (${needs})` : HUB_TITLE;
    if (this.panel.title !== title) this.panel.title = title;
  }

  // ---------------------------------------------------------------------------
  // Messages

  private post(m: ExtToHubMessage): void {
    if (this.panel) void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: HubToExtMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.pushState();
          break;
        case 'chat': {
          const bridge = this.bridges.get(m.key);
          if (bridge) await bridge.receive(m.msg);
          break;
        }
        case 'show': {
          const s = this.deps.sessions.get(m.key);
          if (s) this.show(s, { pane: m.pane });
          break;
        }
        case 'focus-pane':
          this.focusPane(m.pane);
          break;
        case 'set-pane-count':
          this.setPaneCount(m.count);
          break;
        case 'close-pane':
          this.closePane(m.pane);
          break;
        case 'close-sessions':
          this.close(m.keys);
          break;
        case 'pop-out': {
          const s = this.deps.sessions.get(m.key);
          if (!s) break;
          this.close([m.key]);
          this.deps.popOut(s);
          break;
        }
        case 'set-flag': {
          const s = this.deps.sessions.get(m.key);
          if (!s) break;
          this.deps.flags.set(s.sessionId, m.flag);
          break;
        }
        case 'reorder-repos': {
          const known = new Set(this.repoOrder);
          const ids = m.ids.filter((id) => known.has(id));
          this.repoOrder = [...ids, ...this.repoOrder.filter((id) => !ids.includes(id))];
          this.pushState();
          break;
        }
        case 'reorder-sessions':
          this.reorderSessions(m.keys);
          this.pushState();
          break;
        case 'delete-trashed': {
          const targets = this.open
            .map((k) => this.deps.sessions.get(k))
            .filter((s): s is ManagedSession => !!s && this.repoOf(s.cwd).id === m.repoId && this.deps.flags.get(s.sessionId) === 'trash');
          if (targets.length) await this.deps.deleteSessions(targets.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title })));
          break;
        }
        case 'new-session': {
          const repo = m.repoId ? this.reposFor().find((r) => r.id === m.repoId) : undefined;
          if (repo) this.deps.newSession(repo.path);
          else await vscode.commands.executeCommand('claudeProjects.newSession');
          break;
        }
        case 'open-dashboard':
          await vscode.commands.executeCommand('claudeProjects.openDashboard');
          break;
        case 'open-session-picker':
          await vscode.commands.executeCommand('claudeProjects.searchProjects');
          break;
        case 'reveal-in-projects': {
          const s = this.deps.sessions.get(m.key);
          if (s) await vscode.commands.executeCommand('claudeProjects.revealInProjects', s.cwd);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.deps.log.error(`hub message ${m.type} failed: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Claude Projects: ${errorMessage(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // State

  /** Something about the open sessions or panes changed. */
  private changed(): void {
    this.syncBridges();
    this.syncFocus();
    this.pushState();
  }

  /** Drops sessions that were closed elsewhere (deleted, stopped…). */
  private prune(): void {
    const gone = this.open.filter((k) => !this.deps.sessions.get(k));
    if (gone.length) this.close(gone);
    else this.pushSoon();
    this.updateTitle();
  }

  /** One bridge per session shown in a pane; visibility counts for the reaper and unread marks. */
  private syncBridges(): void {
    const shown = new Set(this.panel ? this.panes.filter((k): k is string => !!k) : []);
    for (const [key, bridge] of this.bridges) {
      if (shown.has(key)) continue;
      bridge.dispose();
      this.bridges.delete(key);
      if (this.engagedKey === key) this.engagedKey = undefined;
    }
    const panel = this.panel;
    if (panel) {
      for (const key of shown) {
        if (this.bridges.has(key)) continue;
        const session = this.deps.sessions.get(key);
        if (!session) continue;
        this.bridges.set(
          key,
          new ChatBridge(session, this.deps.chatHost, {
            post: (msg) => this.post({ type: 'chat', key, msg }),
            asWebviewUri: (uri) => panel.webview.asWebviewUri(uri),
            onEngaged: (on) => this.setEngaged(key, on),
          }),
        );
      }
    }
    const visible = new Set(this.panel?.visible ? shown : []);
    for (const key of [...this.counted]) {
      if (visible.has(key)) continue;
      const s = this.deps.sessions.get(key);
      if (s) s.visibleCount = Math.max(0, s.visibleCount - 1);
      this.counted.delete(key);
    }
    for (const key of visible) {
      if (this.counted.has(key)) continue;
      const s = this.deps.sessions.get(key);
      if (!s) continue;
      s.visibleCount++;
      this.counted.add(key);
    }
  }

  private lastFocusedKey: string | undefined;
  /** The chat the user is working in (clicked or typed in its pane), as reported by the webview. */
  private engagedKey: string | undefined;
  /** When each open chat was last opened or worked in (the strip shows the latest first). */
  private readonly enteredAt = new Map<string, number>();

  private setEngaged(key: string, on: boolean): void {
    if (on) {
      this.engagedKey = key;
      this.enteredAt.set(key, Date.now());
      this.pushSoon();
    }
    else if (this.engagedKey === key) this.engagedKey = undefined;
    this.syncFocus();
  }

  /**
   * A chat counts as looked at (no "Finished" mark, no notification) only while
   * the user works in it: its pane is focused, they clicked or typed in it, the
   * hub is the active editor and the window has focus. Merely being on screen
   * isn't enough: you may be browsing other projects in the strip meanwhile.
   */
  private syncFocus(): void {
    if (this.panel) this.syncBridges();
    const active = !!this.panel?.active;
    const paneKey = active ? this.panes[this.focusedPane] ?? undefined : undefined;
    const key = paneKey && paneKey === this.engagedKey ? paneKey : undefined;
    if (this.lastFocusedKey && this.lastFocusedKey !== key) {
      const prev = this.deps.sessions.get(this.lastFocusedKey);
      if (prev) prev.focused = false;
    }
    this.lastFocusedKey = key;
    // Source Control and Files follow the focused pane either way.
    const shown = paneKey ? this.deps.sessions.get(paneKey) : undefined;
    if (shown) this.deps.onActive(shown);
    const session = key ? this.deps.sessions.get(key) : undefined;
    if (!session) return;
    session.focused = vscode.window.state.focused;
    if (vscode.window.state.focused) session.markSeen();
  }

  /**
   * Puts the chats of one project in the given order. Their places in the open
   * list are kept, so other projects' chats don't move.
   */
  private reorderSessions(keys: string[]): void {
    const wanted = keys.filter((k, i) => this.open.includes(k) && keys.indexOf(k) === i);
    if (wanted.length < 2) return;
    const set = new Set(wanted);
    const slots = this.open.map((k, i) => (set.has(k) ? i : -1)).filter((i) => i >= 0);
    const next = [...this.open];
    slots.forEach((slot, i) => (next[slot] = wanted[i]));
    this.open = next;
  }

  private repoOf(cwd: string): { id: string; name: string; path: string } {
    const project = this.deps.store.findContaining(cwd);
    return project ? { id: project.id, name: project.name, path: project.path } : { id: `folder:${cwd}`, name: folderName(cwd), path: cwd };
  }

  /** Projects in the order their tabs were added to the strip; a new one goes at the end. */
  private repoOrder: string[] = [];

  /** Projects with open sessions, in the strip's order. */
  private reposFor(): HubRepoView[] {
    const seen = new Map<string, HubRepoView>();
    for (const key of this.open) {
      const s = this.deps.sessions.get(key);
      if (!s) continue;
      const r = this.repoOf(s.cwd);
      if (!seen.has(r.id)) seen.set(r.id, { ...r, color: colorIndex(r.id) });
    }
    // Keep known projects where they are, drop the ones without chats, add new ones at the end.
    this.repoOrder = [...this.repoOrder.filter((id) => seen.has(id)), ...[...seen.keys()].filter((id) => !this.repoOrder.includes(id))];
    const repos = this.repoOrder.map((id) => seen.get(id)!);
    // Each project keeps its own colour; when two share one, the later takes the next free colour.
    const taken = new Set<number>();
    for (const r of repos) {
      for (let i = 0; i < PALETTE_SIZE && taken.has(r.color); i++) r.color = (r.color + 1) % PALETTE_SIZE;
      taken.add(r.color);
    }
    return repos;
  }

  private state(): HubState {
    const views = new Map(this.deps.attention.sessions.map((v) => [v.key, v]));
    const sessions: HubSessionView[] = [];
    const persisted: HubPersistedSession[] = [];
    for (const key of this.open) {
      const s = this.deps.sessions.get(key);
      if (!s) continue;
      const v = views.get(key);
      const attention = v?.attention ?? (s.status === 'error' ? 'error' : s.status === 'waiting' || s.pendingRequests.length ? 'needs-input' : s.status === 'running' || s.status === 'starting' ? 'running' : s.unread ? 'done' : 'idle');
      sessions.push({
        key,
        sessionId: s.sessionId,
        repoId: this.repoOf(s.cwd).id,
        title: s.title,
        cwd: s.cwd,
        branch: s.branch,
        isWorktree: v?.isWorktree ?? s.isWorktree,
        attention,
        waitingFor: v?.waitingFor,
        activity: v?.activity,
        since: v?.since ?? Date.now(),
        flag: this.deps.flags.get(s.sessionId),
        enteredAt: this.enteredAt.get(key),
      });
      const fork = s.unstartedForkSource;
      persisted.push({ key, sessionId: s.sessionId, cwd: s.cwd, title: s.title, isNew: s.isNew && !fork ? true : undefined, forkFrom: fork ? { ...fork } : undefined, enteredAt: this.enteredAt.get(key) });
    }
    return {
      repos: this.reposFor(),
      sessions,
      panes: [...this.panes],
      focusedPane: this.focusedPane,
      followSeq: this.followSeq,
      persist: { sessions: persisted, panes: [...this.panes], focusedPane: this.focusedPane, repoOrder: [...this.repoOrder] },
    };
  }

  private pushState(): void {
    this.pushSoon.cancel();
    this.updateTitle();
    if (this.panel) this.post({ type: 'hub', state: this.state() });
  }

  dispose(): void {
    this.pushSoon.cancel();
    for (const b of this.bridges.values()) b.dispose();
    this.bridges.clear();
    for (const d of this.panelSubs) d.dispose();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}

/** A stable colour per project. */
export function colorIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE_SIZE;
}
