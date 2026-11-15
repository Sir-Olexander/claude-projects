import * as vscode from 'vscode';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatItem, ChatToExtMessage, ExtToChatMessage, ImageAttachment } from '../shared/protocol';
import type { ManagedSession } from '../sessions/ManagedSession';
import type { Logger } from '../util/log';
import { errorMessage } from '../util/log';
import { openToolDiff, type ProposedContentProvider } from './diffs';
import { fileSuggestions } from './fileSuggestions';

/** What a chat needs from the window: shared services and actions that open other chats. */
export interface ChatHost {
  extensionUri: vscode.Uri;
  imageDir: vscode.Uri;
  log: Logger;
  proposed: ProposedContentProvider;
  openInClaudeExtension(session: ManagedSession): Promise<void>;
  newSession(cwd: string): void;
  /** Opens a fork of a session from one of its replies. */
  fork(session: ManagedSession, itemId: string): void;
  /** Moves a chat from its own tab into the sessions hub. */
  moveToHub?(session: ManagedSession): void;
}

/** Where a chat's messages go: a chat tab's webview, or one pane of the sessions hub. */
export interface ChatSink {
  post(m: ExtToChatMessage): void;
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

/**
 * Connects one session to one chat UI: answers the chat's messages (send,
 * permission answers, bookmarks, shared env, remote control…) and forwards the
 * session's updates to it.
 */
export class ChatBridge implements vscode.Disposable {
  private ready = false;
  private disposed = false;
  /** Item to scroll to once the webview has its state. */
  private pendingScroll: string | undefined;
  private readonly sub: { dispose(): void };

  constructor(
    readonly session: ManagedSession,
    private readonly host: ChatHost,
    private readonly sink: ChatSink,
  ) {
    this.sub = session.onUiMessage((m) => this.post(m));
  }

  /** The chat UI was (re)created: it asks for the state again. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Posts a message, converting cached image file URLs to webview URLs. */
  post(m: ExtToChatMessage): void {
    if (this.disposed) return;
    if (!this.ready && m.type !== 'state') {
      // Until the webview asked for state, only the snapshot matters.
      return;
    }
    this.sink.post(this.mapImages(m));
  }

  private mapImages(m: ExtToChatMessage): ExtToChatMessage {
    const fix = (imgs: ImageAttachment[] | undefined) => imgs?.map((img) => (img.url?.startsWith('file:') ? { ...img, url: this.sink.asWebviewUri(vscode.Uri.file(fileURLToPath(img.url))).toString() } : img));
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

  async receive(m: ChatToExtMessage): Promise<void> {
    if (this.disposed) return;
    const s = this.session;
    try {
      switch (m.type) {
        case 'ready':
          this.ready = false;
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
        case 'rename':
          await vscode.commands.executeCommand('claudeProjects.renameSession', { sessionId: s.sessionId, cwd: s.cwd, title: s.title }, m.title);
          break;
        case 'reveal-project':
          await vscode.commands.executeCommand('claudeProjects.revealInProjects', s.cwd);
          break;
        case 'new-session':
          this.host.newSession(s.cwd);
          break;
        case 'delete-session':
          await vscode.commands.executeCommand('claudeProjects.deleteSession', { sessionId: s.sessionId, cwd: s.cwd, title: s.title });
          break;
        case 'fork':
          this.host.fork(s, m.itemId);
          break;
        case 'move-to-hub':
          this.host.moveToHub?.(s);
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
    // file:///C:/x leaves "/C:/x"; drop that slash.
    const clean = path.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1').replace(/#L?(\d+).*$/, '');
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
    this.sub.dispose();
  }
}
