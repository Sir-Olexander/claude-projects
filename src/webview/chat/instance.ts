import { createContext } from 'preact';
import { useCallback, useContext, useState } from 'preact/hooks';
import type { ChatToExtMessage } from '../../shared/protocol';
import { ChatStore } from './store';

/**
 * UI-only state of one chat that survives the webview being destroyed and
 * recreated: message draft, expanded blocks, scroll position.
 */
export interface ChatUiData {
  draft?: string;
  expanded?: Record<string, boolean>;
  scrollTop?: number;
  /** Whether the list was scrolled to the bottom. */
  atBottom?: boolean;
}

/** Holds a chat's UI state and writes it back (debounced) through `save`. */
export class ChatUi {
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly data: ChatUiData;

  constructor(
    initial: ChatUiData | undefined,
    private readonly save: (data: ChatUiData) => void,
  ) {
    this.data = { ...initial, expanded: { ...(initial?.expanded ?? {}) } };
  }

  private persistSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  /** Writes pending changes now. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const exp = this.data.expanded ?? {};
    const keys = Object.keys(exp);
    if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete exp[k];
    this.save(this.data);
  }

  getDraft = (): string => this.data.draft ?? '';

  saveDraft = (text: string): void => {
    if (this.data.draft === text) return;
    this.data.draft = text;
    this.persistSoon();
  };

  getScroll = (): { scrollTop?: number; atBottom?: boolean } => ({ scrollTop: this.data.scrollTop, atBottom: this.data.atBottom });

  saveScroll = (scrollTop: number, atBottom: boolean): void => {
    this.data.scrollTop = Math.round(scrollTop);
    this.data.atBottom = atBottom;
    this.persistSoon();
  };

  isExpanded(id: string, fallback: boolean): boolean {
    const v = this.data.expanded?.[id];
    return v === undefined ? fallback : v;
  }

  setExpanded(id: string, value: boolean): void {
    this.data.expanded ??= {};
    this.data.expanded[id] = value;
    this.persistSoon();
  }
}

/**
 * One chat shown in a webview: its store, its UI state and the way it talks
 * to the extension. A chat tab has one; the sessions hub has one per pane.
 */
export class ChatInstance {
  readonly store = new ChatStore();

  constructor(
    private readonly post: (m: ChatToExtMessage) => void,
    readonly ui: ChatUi,
  ) {}

  send = (msg: ChatToExtMessage): void => this.post(msg);

  openFile = (path: string, line?: number): void => this.send({ type: 'open-file', path, line });

  openDiff = (toolUseId: string): void => this.send({ type: 'open-diff', toolUseId });

  openUrl = (url: string): void => this.send({ type: 'open-url', url });

  copyText = (text: string): void => {
    this.send({ type: 'copy', text });
    // Also try the browser clipboard (works in recent VS Code webviews); the extension copy is the fallback.
    try {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    } catch {
      // ignore
    }
  };
}

export const ChatInstanceContext = createContext<ChatInstance | undefined>(undefined);

/** The chat the calling component belongs to. */
export function useChat(): ChatInstance {
  const chat = useContext(ChatInstanceContext);
  if (!chat) throw new Error('useChat outside a ChatInstanceContext');
  return chat;
}

/** Collapsible state for a block, remembered across webview reloads. */
export function useExpanded(id: string, fallback: boolean): [boolean, (v?: boolean) => void] {
  const { ui } = useChat();
  const [open, setOpen] = useState(() => ui.isExpanded(id, fallback));
  const toggle = useCallback(
    (v?: boolean) => {
      setOpen((cur) => {
        const next = v === undefined ? !cur : v;
        ui.setExpanded(id, next);
        return next;
      });
    },
    [id, ui],
  );
  return [open, toggle];
}
