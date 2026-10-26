import type { ChatItem, ChatState, ExtToChatMessage } from '../../shared/protocol';
import { useEffect, useState } from 'preact/hooks';

type Listener = () => void;

export interface FileSuggestions {
  requestId: number;
  items: { path: string; isDirectory: boolean }[];
}

/**
 * Holds the ChatState sent by the extension and applies incremental updates.
 * Item objects are treated as immutable: an update replaces the object, so
 * memoized components re-render only for the items that changed.
 * Listeners are notified at most once per animation frame.
 */
export class ChatStore {
  state: ChatState | undefined;
  /** Increments whenever anything changes. */
  version = 0;
  /** Increments when items are appended (new content for auto-scroll / unread tracking). */
  contentVersion = 0;
  fileSuggestions: FileSuggestions | undefined;

  private index = new Map<string, number>();
  private listeners = new Set<Listener>();
  private scheduled = false;
  private readonly bus = new EventTarget();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Ask the message list to jump to the newest message (e.g. after the user sends one). */
  requestScrollToBottom(): void {
    this.emit('scroll-bottom');
  }

  /** One-off UI events: 'focus-input', 'insert-text' (detail: string), 'file-suggestions', 'scroll-bottom'. */
  on(type: 'focus-input' | 'insert-text' | 'file-suggestions' | 'scroll-bottom' | 'scroll-to', handler: (detail: unknown) => void): () => void {
    const fn = (e: Event) => handler((e as CustomEvent).detail);
    this.bus.addEventListener(type, fn);
    return () => this.bus.removeEventListener(type, fn);
  }

  /** Scroll the conversation to an item (bookmarks). */
  scrollTo(itemId: string): void {
    this.emit('scroll-to', itemId);
  }

  /** Insert text into the message box at the end. */
  insertText(text: string): void {
    this.emit('insert-text', text);
  }

  private emit(type: string, detail?: unknown): void {
    this.bus.dispatchEvent(new CustomEvent(type, { detail }));
  }

  apply(msg: ExtToChatMessage): void {
    switch (msg.type) {
      case 'state': {
        this.state = { ...msg.state, items: [...msg.state.items], pending: msg.state.pending ?? [] };
        this.reindex();
        this.contentVersion++;
        break;
      }
      case 'patch': {
        if (!this.state) return;
        const next: Record<string, unknown> = { ...this.state };
        // null means "clear this field" (JSON can't carry undefined).
        for (const [k, v] of Object.entries(msg.patch)) next[k] = v === null ? undefined : v;
        this.state = next as unknown as ChatState;
        break;
      }
      case 'items': {
        if (!this.state || msg.items.length === 0) return;
        const items = this.state.items.slice();
        let appended = false;
        for (const it of msg.items) {
          const i = this.index.get(it.id);
          if (i !== undefined) {
            items[i] = it;
          } else {
            this.index.set(it.id, items.length);
            items.push(it);
            appended = true;
          }
        }
        this.state = { ...this.state, items };
        if (appended) this.contentVersion++;
        break;
      }
      case 'remove-items': {
        if (!this.state) return;
        const drop = new Set(msg.ids);
        this.state = { ...this.state, items: this.state.items.filter((i) => !drop.has(i.id)) };
        this.reindex();
        break;
      }
      case 'delta': {
        if (!this.state) return;
        const i = this.index.get(msg.id);
        if (i === undefined) return;
        const cur = this.state.items[i];
        let next: ChatItem | undefined;
        if (msg.field === 'text' && (cur.kind === 'text' || cur.kind === 'thinking')) {
          next = { ...cur, text: cur.text + msg.text };
        } else if (msg.field === 'partialInput' && cur.kind === 'tool') {
          next = { ...cur, partialInput: (cur.partialInput ?? '') + msg.text };
        }
        if (!next) return;
        const items = this.state.items.slice();
        items[i] = next;
        this.state = { ...this.state, items };
        this.contentVersion++;
        break;
      }
      case 'file-suggestions':
        this.fileSuggestions = { requestId: msg.requestId, items: msg.items };
        this.emit('file-suggestions', this.fileSuggestions);
        return;
      case 'focus-input':
        this.emit('focus-input');
        return;
      case 'insert-text':
        this.emit('insert-text', msg.text);
        return;
      case 'scroll-to':
        this.emit('scroll-to', msg.itemId);
        return;
      default:
        return;
    }
    this.version++;
    this.schedule();
  }

  private reindex(): void {
    this.index.clear();
    this.state?.items.forEach((it, i) => this.index.set(it.id, i));
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      this.scheduled = false;
      for (const l of [...this.listeners]) l();
    };
    // rAF batches streaming deltas per frame; the timeout covers throttled/hidden frames.
    requestAnimationFrame(run);
    setTimeout(run, 100);
  }
}

export const store = new ChatStore();

/** Re-renders the calling component whenever the store changes. */
export function useStoreVersion(s: ChatStore = store): number {
  const [, setTick] = useState(0);
  useEffect(() => s.subscribe(() => setTick((t) => t + 1)), [s]);
  return s.version;
}
