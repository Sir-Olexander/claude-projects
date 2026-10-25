import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import type { HandoffService } from '../handoff/Handoff';
import type { ProjectStore } from '../projects/ProjectStore';
import type { SessionIndex } from '../claude/SessionIndex';
import type { ManagedSession } from '../sessions/ManagedSession';
import type { SessionManager } from '../sessions/SessionManager';
import { getCurrentBranch } from '../git/gitCli';
import type { Logger } from '../util/log';
import { folderName } from '../util/paths';
import { CHAT_VIEW_TYPE, ChatPanel } from './ChatPanel';
import { PROPOSED_SCHEME, ProposedContentProvider } from './diffs';

interface PersistedPanelState {
  session?: { key?: string; sessionId?: string; cwd?: string; title?: string };
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

  constructor(private readonly deps: ChatPanelManagerDeps) {
    this.disposables.push(this.proposed, vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this.proposed));
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: PersistedPanelState | undefined) => this.restore(panel, state),
      }),
    );
  }

  private get host() {
    const { context, log } = this.deps;
    return {
      extensionUri: context.extensionUri,
      imageDir: vscode.Uri.joinPath(context.globalStorageUri, 'images'),
      log,
      proposed: this.proposed,
      openInClaudeExtension: (s: ManagedSession) => this.openInClaudeExtension(s),
      newSession: (cwd: string) => void this.newSession(cwd),
      onActive: (s: ManagedSession) => this.onActive(s),
      onDispose: (p: ChatPanel) => {
        if (this.panels.get(p.session.key) === p) this.panels.delete(p.session.key);
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
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    );
    return this.attach(panel, session);
  }

  private attach(panel: vscode.WebviewPanel, session: ManagedSession): ChatPanel {
    const cp = new ChatPanel(panel, session, this.host);
    this.panels.set(session.key, cp);
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
  }
}
