import type { BookmarkView, ChatItem } from '../shared/protocol';
import { describeToolActivity } from './toolText';

/** What we persist per bookmark. `snippet` re-finds the message if its id changes (e.g. after a reload). */
export interface StoredBookmark {
  itemId: string;
  kind: BookmarkView['kind'];
  label: string;
  snippet: string;
  createdAt: number;
}

/** Where bookmarks live (global state in VS Code, a Map in tests). */
export interface BookmarkStore {
  load(sessionId: string): StoredBookmark[];
  save(sessionId: string, bookmarks: StoredBookmark[]): void;
}

export function isBookmarkable(item: ChatItem): item is Extract<ChatItem, { kind: 'user' | 'text' | 'tool' }> {
  return (item.kind === 'user' || item.kind === 'text' || item.kind === 'tool') && !('parentToolUseId' in item && item.parentToolUseId);
}

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s`]+/, '').replace(/[*_`]+/g, '').trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > 90 ? line.slice(0, 89) + '…' : line;
}

function snippetOf(item: ChatItem): string {
  if (item.kind === 'tool') return `${item.name}:${JSON.stringify(item.input).slice(0, 200)}`;
  if (item.kind === 'user' || item.kind === 'text') return item.text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return '';
}

export function bookmarkFor(item: ChatItem, cwd?: string): StoredBookmark | undefined {
  if (!isBookmarkable(item)) return undefined;
  const label = item.kind === 'tool' ? describeToolActivity(item.name, item.input, cwd) : firstLine(item.text) || (item.kind === 'user' ? 'Your message' : 'Claude’s reply');
  return { itemId: item.id, kind: item.kind, label, snippet: snippetOf(item), createdAt: Date.now() };
}

/**
 * Matches stored bookmarks to the current items. A bookmark whose id is gone
 * is re-attached to an item of the same kind with the same text, so bookmarks
 * survive id changes. Returns the (possibly updated) list and whether it changed.
 */
export function resolveBookmarks(stored: StoredBookmark[], items: readonly ChatItem[]): { list: StoredBookmark[]; changed: boolean } {
  if (!stored.length) return { list: stored, changed: false };
  const ids = new Set(items.map((i) => i.id));
  let changed = false;
  const list = stored.map((b) => {
    if (ids.has(b.itemId)) return b;
    const match = items.find((i) => i.kind === b.kind && isBookmarkable(i) && snippetOf(i) === b.snippet);
    if (!match) return b; // keep it: the item may be in older, not-yet-loaded history
    changed = true;
    return { ...b, itemId: match.id };
  });
  return { list, changed };
}

export function toViews(stored: StoredBookmark[]): BookmarkView[] {
  return stored.map(({ itemId, kind, label, createdAt }) => ({ itemId, kind, label, createdAt }));
}
