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
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', 'activity.svg');
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

  dispose(): void {
    this.push.cancel();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
