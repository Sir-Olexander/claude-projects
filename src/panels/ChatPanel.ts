import * as vscode from 'vscode';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatItem, ChatToExtMessage, ExtToChatMessage, ImageAttachment } from '../shared/protocol';
import type { ManagedSession } from '../sessions/ManagedSession';
import type { Logger } from '../util/log';
import { errorMessage } from '../util/log';
import { clip } from '../sessions/toolText';
import { webviewHtml } from './webviewHtml';
import { openToolDiff, type ProposedContentProvider } from './diffs';
import { fileSuggestions } from './fileSuggestions';

export const CHAT_VIEW_TYPE = 'claudeProjects.chat';

export interface ChatPanelHost {
  extensionUri: vscode.Uri;
  imageDir: vscode.Uri;
  log: Logger;
  proposed: ProposedContentProvider;
  openInClaudeExtension(session: ManagedSession): Promise<void>;
  newSession(cwd: string): void;
  /** Opens a fork of a session from one of its replies. */
  fork(session: ManagedSession, itemId: string): void;
  onActive(session: ManagedSession): void;
  onDispose(panel: ChatPanel): void;
}

/** One editor tab showing a session (the "Open here" chat). */
export class ChatPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private queue: ExtToChatMessage[] = [];
  private wasVisible = false;
  private disposed = false;
  /** Item to scroll to once the webview has its state. */
  private pendingScroll: string | undefined;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly session: ManagedSession,
    private readonly host: ChatPanelHost,
  ) {
    panel.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(host.extensionUri, 'dist', 'webview'), host.imageDir],
    };
    panel.iconPath = {
      light: vscode.Uri.joinPath(host.extensionUri, 'media', 'icons', 'claude-light.svg'),
      dark: vscode.Uri.joinPath(host.extensionUri, 'media', 'icons', 'claude-dark.svg'),
    };
    panel.webview.html = webviewHtml(panel.webview, host.extensionUri, 'chat', session.title);
    this.updateTitle();

    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: ChatToExtMessage) => void this.onMessage(m)),
      panel.onDidChangeViewState(() => this.onViewState()),
      panel.onDidDispose(() => this.dispose()),
      vscode.window.onDidChangeWindowState(() => this.onViewState()),
    );
    this.disposables.push({ dispose: session.onUiMessage((m) => this.post(m)).dispose });
    this.disposables.push({ dispose: session.onDidChange(() => this.updateTitle()).dispose });
    this.onViewState();
  }

  private updateTitle(): void {
    if (this.disposed) return;
    const s = this.session;
    const marker = s.status === 'waiting' || s.pendingRequests.length ? '● ' : s.status === 'error' ? '⚠ ' : s.unread ? '• ' : '';
    this.panel.title = `${marker}${clip(s.title, 42)}`;
  }

  private onViewState(): void {
    if (this.disposed) return;
    const visible = this.panel.visible;
    if (visible !== this.wasVisible) {
      this.session.visibleCount += visible ? 1 : -1;
      this.wasVisible = visible;
    }
    this.session.focused = this.panel.active && vscode.window.state.focused;
    if (this.panel.active) {
      this.host.onActive(this.session);
      if (vscode.window.state.focused) this.session.markSeen();
    }
  }

  reveal(preserveFocus = false): void {
    this.panel.reveal(undefined, preserveFocus);
  }

  /** Posts a message, converting cached image file URLs to webview URLs. */
  post(m: ExtToChatMessage): void {
    if (this.disposed) return;
    if (!this.ready && m.type !== 'state') {
      // Until the webview asked for state, only the snapshot matters.
      return;
    }
    void this.panel.webview.postMessage(this.mapImages(m));
  }

  private mapImages(m: ExtToChatMessage): ExtToChatMessage {
    const fix = (imgs: ImageAttachment[] | undefined) => imgs?.map((img) => (img.url?.startsWith('file:') ? { ...img, url: this.panel.webview.asWebviewUri(vscode.Uri.file(fileURLToPath(img.url))).toString() } : img));
    const fixItem = (it: ChatItem): ChatItem => {
      if (it.kind === 'user' && it.images?.length) return { ...it, images: fix(it.images) };
      if (it.kind === 'tool' && it.result?.images?.length) return { ...it, result: { ...it.result, images: fix(it.result.images) } };
      return it;
    };
    if (m.type === 'state') return { ...m, state: { ...m.state, items: m.state.items.map(fixItem) } };
    if (m.type === 'items') return { ...m, items: m.items.map(fixItem) };
    return m;
  }

  private async sendState(): Promise<void> {
    await this.session.ensureHistory();
    this.ready = true;
    this.post({ type: 'state', state: this.session.getState() });
    if (this.pendingScroll) {
      const itemId = this.pendingScroll;
      this.pendingScroll = undefined;
      this.post({ type: 'scroll-to', itemId });
    }
  }

  /** Scrolls the chat to an item (used by "Go to Bookmarked Message"). */
  scrollTo(itemId: string): void {
    if (this.ready) this.post({ type: 'scroll-to', itemId });
    else this.pendingScroll = itemId;
  }

  private async onMessage(m: ChatToExtMessage): Promise<void> {
    const s = this.session;
    try {
      switch (m.type) {
        case 'ready':
          await this.sendState();
          break;
        case 'send': {
          if (s.liveElsewhere && !(await this.confirmFork())) return;
          await s.send(m.text, m.images ?? []);
          break;
        }
        case 'interrupt':
          await s.interrupt();
          break;
        case 'set-mode':
          await s.setMode(m.mode);
          break;
        case 'set-model':
          await s.setModel(m.model);
          break;
        case 'set-effort':
          await s.setEffort(m.effort);
          break;
        case 'elicitation-response': {
          const problem = s.respondElicitation(m.requestId, m.action, m.content);
          if (problem) void vscode.window.showWarningMessage(problem);
          break;
        }
        case 'toggle-bookmark':
          s.toggleBookmark(m.itemId);
          break;
        case 'set-auto-continue':
          s.setAutoContinue(m.on);
          break;
        case 'permission-response':
          s.respondPermission(m.requestId, m.optionId, m.feedback);
          break;
        case 'question-response':
          s.respondQuestion(m.requestId, m.answers, m.cancelled);
          break;
        case 'plan-response':
          s.respondPlan(m.requestId, m.decision, m.feedback);
          break;
        case 'open-file':
          await this.openFile(m.path, m.line);
          break;
        case 'open-diff': {
          const tool = s.toolInfo(m.toolUseId);
          if (tool) await openToolDiff(this.host.proposed, s.cwd, tool);
          break;
        }
        case 'open-url':
          await this.openUrl(m.url);
          break;
        case 'open-in-claude-extension':
          await this.host.openInClaudeExtension(s);
          break;
        case 'new-session':
          this.host.newSession(s.cwd);
          break;
        case 'fork':
          this.host.fork(s, m.itemId);
          break;
        case 'remote-control':
          await s.setRemoteControl(m.on);
          break;
        case 'set-shared-env':
          await s.setSharedEnv(m.names);
          break;
        case 'open-global-env':
          await vscode.commands.executeCommand('claudeProjects.openGlobalEnv');
          break;
        case 'restart':
          await s.restart();
          break;
        case 'file-suggestions': {
          const items = await fileSuggestions(s.cwd, m.query).catch(() => []);
          this.post({ type: 'file-suggestions', requestId: m.requestId, items });
          break;
        }
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          break;
        case 'seen':
          s.markSeen();
          break;
        case 'load-full-history':
          s.loadFullHistory();
          break;
        default:
          break;
      }
    } catch (err) {
      this.host.log.error(`chat message ${m.type} failed: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Claude Projects: ${errorMessage(err)}`);
    }
  }

  private async confirmFork(): Promise<boolean> {
    const where = this.session.liveElsewhere?.source ?? 'another window';
    const pick = await vscode.window.showWarningMessage(
      `This session is still open in ${where}. Two processes writing the same session can mix up its history.`,
      { modal: true, detail: 'Continue here as a copy (a new session with the same history), or open it where it is running.' },
      'Continue Here as a Copy',
      'Open in Claude Extension',
    );
    if (pick === 'Continue Here as a Copy') {
      this.session.forkNextStart();
      this.session.setLiveElsewhere(undefined);
      return true;
    }
    if (pick === 'Open in Claude Extension') await this.host.openInClaudeExtension(this.session);
    return false;
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const clean = path.replace(/^file:\/\//, '').replace(/#L?(\d+).*$/, '');
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(clean);
    const filePath = m ? m[1] : clean;
    const ln = line ?? (m ? Number(m[2]) : undefined);
    const abs = isAbsolute(filePath) ? filePath : join(this.session.cwd, filePath);
    const uri = vscode.Uri.file(abs);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
        return;
      }
    } catch {
      void vscode.window.showWarningMessage(`File not found: ${filePath}`);
      return;
    }
    const opts: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.Active };
    if (ln && ln > 0) opts.selection = new vscode.Range(ln - 1, 0, ln - 1, 0);
    await vscode.window.showTextDocument(uri, opts);
  }

  private async openUrl(url: string): Promise<void> {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    await this.openFile(url);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.wasVisible) this.session.visibleCount = Math.max(0, this.session.visibleCount - 1);
    this.session.focused = false;
    for (const d of this.disposables) d.dispose();
    this.host.onDispose(this);
    this.panel.dispose();
  }
}
