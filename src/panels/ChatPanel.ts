import * as vscode from 'vscode';
import type { ChatToExtMessage, ExtToChatMessage } from '../shared/protocol';
import type { ManagedSession } from '../sessions/ManagedSession';
import { clip } from '../sessions/toolText';
import { webviewHtml } from './webviewHtml';
import { ChatBridge, type ChatHost } from './ChatBridge';

export const CHAT_VIEW_TYPE = 'claudeProjects.chat';

/** Setting: chat tabs show only their icon (and status marker), not the session name. */
export const ICON_ONLY_TABS_SETTING = 'chat.iconOnlyTabs';

function iconOnlyTabs(): boolean {
  return vscode.workspace.getConfiguration('claudeProjects').get<boolean>(ICON_ONLY_TABS_SETTING, false);
}

export interface ChatPanelHost extends ChatHost {
  onActive(session: ManagedSession): void;
  onDispose(panel: ChatPanel): void;
}

/** One editor tab showing a session (the "Open here" chat). */
export class ChatPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly bridge: ChatBridge;
  private wasVisible = false;
  private disposed = false;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly session: ManagedSession,
    private readonly host: ChatPanelHost,
    /** Invisible, fixed end of this panel's tab title; how its tab is found (see unloadedTabs). */
    readonly tag: string,
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
    this.bridge = new ChatBridge(session, host, {
      post: (m) => void panel.webview.postMessage(m),
      asWebviewUri: (uri) => panel.webview.asWebviewUri(uri),
    });
    panel.webview.html = webviewHtml(panel.webview, host.extensionUri, 'chat', session.title);
    this.updateTitle();

    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: ChatToExtMessage) => void this.bridge.receive(m)),
      panel.onDidChangeViewState(() => this.onViewState()),
      panel.onDidDispose(() => this.dispose()),
      vscode.window.onDidChangeWindowState(() => this.onViewState()),
    );
    this.disposables.push({ dispose: session.onDidChange(() => this.updateTitle()).dispose });
    this.onViewState();
  }

  /** Position among this window's chat tabs; shown as the tab title in icon-only mode. */
  private tabNumber: number | undefined;

  get number(): number | undefined {
    return this.tabNumber;
  }

  setNumber(n: number | undefined): void {
    if (n === this.tabNumber) return;
    this.tabNumber = n;
    this.updateTitle();
  }

  updateTitle(): void {
    if (this.disposed) return;
    const s = this.session;
    const marker = s.status === 'waiting' || s.pendingRequests.length ? '●' : s.status === 'error' ? '⚠' : s.unread ? '•' : '';
    // Icon-only tabs show the tab's number and status marker; the name still shows everywhere else.
    const shown = iconOnlyTabs()
      ? [this.tabNumber === undefined ? '' : String(this.tabNumber), marker].filter(Boolean).join(' ')
      : `${marker ? marker + ' ' : ''}${clip(s.title, 42)}`;
    const title = shown + this.tag;
    if (this.panel.title !== title) this.panel.title = title;
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

  post(m: ExtToChatMessage): void {
    this.bridge.post(m);
  }

  /** Scrolls the chat to an item (used by "Go to Bookmarked Message"). */
  scrollTo(itemId: string): void {
    this.bridge.scrollTo(itemId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.wasVisible) this.session.visibleCount = Math.max(0, this.session.visibleCount - 1);
    this.session.focused = false;
    for (const d of this.disposables) d.dispose();
    this.bridge.dispose();
    this.host.onDispose(this);
    this.panel.dispose();
  }
}
