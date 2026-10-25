import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatItem, ChatState } from '../../../shared/protocol';
import { store } from '../store';
import { getScroll, saveScroll } from '../ui';
import { ChatContext, type ChatContextValue } from './context';
import { ItemView } from './items';
import { Icon } from './ui';
import { send } from './actions';
import { memo } from 'preact/compat';

const BOOKMARKABLE = new Set(['user', 'text', 'tool']);

/** A top-level item with its hover bookmark toggle. */
const Frame = memo(function Frame({ item, kids, marked }: { item: ChatItem; kids?: ChatItem[]; marked: boolean }) {
  const can = BOOKMARKABLE.has(item.kind) && !(item.kind === 'text' && !item.text.trim()) && !(item.kind === 'user' && item.queued);
  return (
    <div class={`bm-frame${marked ? ' is-marked' : ''}`} data-item-id={item.id}>
      <ItemView item={item} kids={kids} />
      {can ? (
        <button
          type="button"
          class="bm-toggle"
          title={marked ? 'Remove bookmark' : 'Bookmark this message'}
          aria-label={marked ? 'Remove bookmark' : 'Bookmark this message'}
          aria-pressed={marked}
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'toggle-bookmark', itemId: item.id });
          }}
        >
          <Icon name={marked ? 'bookmark' : 'bookmark'} />
        </button>
      ) : null}
    </div>
  );
});

interface Grouped {
  top: ChatItem[];
  children: Map<string, ChatItem[]>;
}

/**
 * Splits items into the main timeline and subagent children (by parentToolUseId).
 * Child arrays are reused when unchanged so memoized tool rows don't re-render.
 */
function useGrouped(items: ChatItem[]): Grouped {
  const prev = useRef<Map<string, ChatItem[]>>(new Map());
  return useMemo(() => {
    const ids = new Set<string>();
    for (const it of items) ids.add(it.id);
    const top: ChatItem[] = [];
    const children = new Map<string, ChatItem[]>();
    for (const it of items) {
      const parent = (it as { parentToolUseId?: string }).parentToolUseId;
      if (parent && ids.has(parent)) {
        let arr = children.get(parent);
        if (!arr) children.set(parent, (arr = []));
        arr.push(it);
      } else {
        top.push(it);
      }
    }
    for (const [k, arr] of children) {
      const old = prev.current.get(k);
      if (old && old.length === arr.length && old.every((x, i) => x === arr[i])) children.set(k, old);
    }
    prev.current = children;
    return { top, children };
  }, [items]);
}

const BOTTOM_SLACK = 48;

export function MessageList({ state, contentVersion, empty, onSeen }: { state: ChatState; contentVersion: number; empty: ComponentChildren; onSeen: () => void }) {
  const { top, children } = useGrouped(state.items);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restored = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const lastSeenVersion = useRef(contentVersion);

  const renderItems = useCallback(
    (list: ChatItem[]) => list.map((it) => <ItemView key={it.id} item={it} kids={it.kind === 'tool' ? children.get(it.id) : undefined} />),
    [children],
  );
  const marked = useMemo(() => new Set((state.bookmarks ?? []).map((b) => b.itemId)), [state.bookmarks]);
  const renderTop = (list: ChatItem[]) =>
    list.map((it) => <Frame key={it.id} item={it} kids={it.kind === 'tool' ? children.get(it.id) : undefined} marked={marked.has(it.id)} />);

  // Jump to a bookmarked item; load older history first if it isn't rendered yet.
  const pendingScroll = useRef<string | undefined>(undefined);
  const scrollToItem = useCallback((id: string): boolean => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
    if (!el) return false;
    atBottom.current = false;
    setShowJump(true);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 1600);
    return true;
  }, []);
  useEffect(
    () =>
      store.on('scroll-to', (detail) => {
        const id = String(detail);
        if (scrollToItem(id)) return;
        pendingScroll.current = id;
        if (store.state?.historyTruncated) send({ type: 'load-full-history' });
      }),
    [scrollToItem],
  );
  // After more history arrives, retry a jump that was waiting for it.
  useEffect(() => {
    const id = pendingScroll.current;
    if (!id) return;
    requestAnimationFrame(() => {
      if (scrollToItem(id)) pendingScroll.current = undefined;
    });
  }, [state.items, scrollToItem]);

  const ctx = useMemo<ChatContextValue>(
    () => ({
      cwd: state.cwd,
      childrenOf: (id) => children.get(id),
      renderItems: (list) => renderItems(list),
    }),
    [state.cwd, children, renderItems],
  );

  // Restore scroll position once after the first render of a session.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || restored.current) return;
    restored.current = true;
    const s = getScroll();
    if (s.atBottom === false && typeof s.scrollTop === 'number') {
      el.scrollTop = s.scrollTop;
      atBottom.current = false;
      setShowJump(true);
    } else {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
    }
  }, []);

  // Follow new content while pinned to the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (contentVersion !== lastSeenVersion.current) {
      setShowJump(true);
    }
  }, [contentVersion, state.items, state.pending.length]);

  // The user just sent a message: follow the conversation again.
  useEffect(
    () =>
      store.on('scroll-bottom', () => {
        const el = scroller.current;
        if (!el) return;
        atBottom.current = true;
        setShowJump(false);
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }),
    [],
  );

  // Keep pinned when content above the fold grows asynchronously (images, markdown re-layout).
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    atBottom.current = bottom;
    saveScroll(el.scrollTop, bottom);
    if (bottom) {
      setShowJump(false);
      if (lastSeenVersion.current !== contentVersion) {
        lastSeenVersion.current = contentVersion;
        onSeen();
      }
    }
  }, [contentVersion, onSeen]);

  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottom.current = true;
    setShowJump(false);
    lastSeenVersion.current = contentVersion;
    onSeen();
  }, [contentVersion, onSeen]);

  return (
    <ChatContext.Provider value={ctx}>
      <div class="messages" ref={scroller} onScroll={onScroll}>
        <div class="messages-inner">{top.length === 0 ? empty : renderTop(top)}</div>
      </div>
      {showJump ? (
        <button type="button" class="jump-bottom" onClick={jump} title="Jump to latest" aria-label="Jump to latest">
          <Icon name="arrow-down" />
        </button>
      ) : null}
    </ChatContext.Provider>
  );
}
