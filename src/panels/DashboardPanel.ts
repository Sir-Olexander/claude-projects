import * as vscode from 'vscode';
import type { DashboardState, DashboardToExtMessage, LiveSessionView } from '../shared/protocol';
import type { AttentionService } from '../sessions/AttentionService';
import type { SessionManager } from '../sessions/SessionManager';
import type { UsageService } from '../usage/UsageService';
import type { ProjectStore } from '../projects/ProjectStore';
import type { HandoffService } from '../handoff/Handoff';
import { debounce } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import { webviewHtml } from './webviewHtml';

export const DASHBOARD_VIEW_TYPE = 'claudeProjects.dashboard';

export interface DashboardDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  attention: AttentionService;
  sessions: SessionManager;
  usage: UsageService;
  store: ProjectStore;
  handoff: HandoffService;
  revealSession(key: string): void;
  closeTab(key: string): void;
  closeUnloadedTab(key: string): Promise<void>;
  showUnloadedTab(key: string): Promise<void>;
  openExternal(view: LiveSessionView): Promise<void>;
}

/** The central "who needs me" panel (one per window). */
export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly push = debounce(() => this.postState(), 60);

  constructor(private readonly deps: DashboardDeps) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(DASHBOARD_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => this.attach(panel),
      }),
    );
    this.disposables.push({ dispose: deps.attention.onDidChange(() => this.push()).dispose });
    this.disposables.push({ dispose: deps.usage.onDidChange(() => this.push()).dispose });
    this.disposables.push({ dispose: deps.store.onDidChangeProjects(() => this.push()).dispose });
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(DASHBOARD_VIEW_TYPE, 'Claude Sessions', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.attach(panel);
  }

  private attach(panel: vscode.WebviewPanel): void {
    const { context } = this.deps;
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')] };
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', 'dashboard-tab.svg');
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, 'dashboard', 'Claude Sessions');
    const subs = [
      panel.webview.onDidReceiveMessage((m: DashboardToExtMessage) => void this.onMessage(m)),
      panel.onDidDispose(() => {
        this.panel = undefined;
        for (const s of subs) s.dispose();
      }),
    ];
    this.updateTitle();
  }

  private state(): DashboardState {
    return { sessions: [...this.deps.attention.sessions], recent: [...this.deps.attention.recent], usage: this.deps.usage.current, projectCount: this.deps.store.projects.length };
  }

  private updateTitle(): void {
    if (!this.panel) return;
    const n = this.deps.attention.attentionCount;
    this.panel.title = n ? `Claude Sessions (${n})` : 'Claude Sessions';
  }

  private postState(): void {
    if (!this.panel) return;
    this.updateTitle();
    void this.panel.webview.postMessage({ type: 'state', state: this.state() });
  }

  private async onMessage(m: DashboardToExtMessage): Promise<void> {
    const { sessions, attention } = this.deps;
    try {
      switch (m.type) {
        case 'ready':
          this.postState();
          break;
        case 'open': {
          if (m.key.startsWith('tab:')) {
            await this.deps.showUnloadedTab(m.key);
            break;
          }
          const view = attention.sessions.find((v) => v.key === m.key);
          if (!view) break;
          if (view.managed) this.deps.revealSession(view.key);
          else await this.deps.openExternal(view);
          break;
        }
        case 'open-in-claude-extension': {
          const view = attention.sessions.find((v) => v.key === m.key);
          if (view) await this.deps.handoff.openInClaudeExtension(view.cwd, view.sessionId);
          break;
        }
        case 'open-recent': {
          const info = attention.recent.find((r) => r.sessionId === m.sessionId);
          const arg = { sessionId: m.sessionId, cwd: m.cwd, title: info?.title };
          await vscode.commands.executeCommand(m.inClaudeExtension ? 'claudeProjects.openSessionInClaudeExtension' : 'claudeProjects.openSession', arg);
          break;
        }
        case 'allow':
          sessions.get(m.key)?.respondPermission(m.requestId, m.optionId);
          break;
        case 'deny':
          sessions.get(m.key)?.respondPermission(m.requestId, 'deny');
          break;
        case 'stop': {
          const s = sessions.get(m.key);
          if (!s) break;
          if (s.status === 'running' || s.status === 'waiting') await s.interrupt();
          else await s.stopProcess();
          break;
        }
        case 'dismiss':
          attention.dismiss(m.key);
          break;
        case 'delete':
          await vscode.commands.executeCommand('claudeProjects.deleteSession', { sessionId: m.sessionId, cwd: m.cwd, title: m.title });
          break;
        case 'close':
          await this.closeSessions(m.keys);
          break;
        case 'new-session':
          await vscode.commands.executeCommand('claudeProjects.newSession');
          break;
        case 'refresh-usage':
          await this.deps.usage.refresh(true);
          break;
        case 'add-project':
          await vscode.commands.executeCommand('claudeProjects.addProject');
          break;
      }
    } catch (err) {
      this.deps.log.error(`dashboard ${m.type} failed: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Claude Projects: ${errorMessage(err)}`);
    }
  }

  /**
   * Sessions of this window: the tab closes and the Claude process stops, unless
   * a turn is in progress (then it keeps running in the background).
   * Idle terminal sessions: their CLI process is ended after a confirm.
   * `skipConfirm` is for tests only (the dialog is modal).
   */
  async closeSessions(keys: string[], opts?: { skipConfirm?: boolean }): Promise<void> {
    const { sessions, attention } = this.deps;
    const external: LiveSessionView[] = [];
    const stops: Promise<void>[] = [];
    // Indexes of unloaded tabs shift as tabs close: close from the last one.
    const unloaded = keys.filter((k) => k.startsWith('tab:')).sort((a, b) => Number(b.split(':')[2]) - Number(a.split(':')[2]));
    for (const key of unloaded) await this.deps.closeUnloadedTab(key);
    for (const key of keys) {
      if (key.startsWith('tab:')) continue;
      const s = sessions.get(key);
      if (s) {
        const busy = s.status === 'running' || s.status === 'waiting' || s.status === 'starting' || s.pendingRequests.length > 0;
        this.deps.closeTab(key);
        if (!busy) {
          // A session stopped at a usage limit stays listed (and would auto-continue) until this is cleared.
          s.dismissLimitStop();
          stops.push(s.stopProcess());
        }
        continue;
      }
      const v = attention.sessions.find((x) => x.key === key);
      if (v && !v.managed && v.closable && v.attention === 'idle' && v.pid) external.push(v);
    }
    await Promise.all(stops);
    if (stops.length) sessions.syncAutoContinue();
    if (!external.length) return;
    const what = external.length === 1 ? `"${external[0].title}"` : `${external.length} sessions`;
    const pick = opts?.skipConfirm
      ? 'End Session'
      : await vscode.window.showWarningMessage(
      `End ${what} running in a terminal?`,
      { modal: true, detail: 'This stops the Claude process in that terminal. You can resume the conversation later from Recent.' },
      'End Session',
    );
    if (pick !== 'End Session') return;
    for (const v of external) {
      // The registry may have changed while the dialog was open (pid gone or reused).
      const still = attention.sessions.find((x) => x.key === v.key);
      if (!still || still.pid !== v.pid || still.attention !== 'idle') continue;
      try {
        process.kill(v.pid!, 'SIGTERM');
        this.deps.log.info(`ended idle terminal session pid ${v.pid}`);
      } catch (err) {
        this.deps.log.warn(`could not end pid ${v.pid}: ${errorMessage(err)}`);
      }
    }
  }

  dispose(): void {
    this.push.cancel();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
