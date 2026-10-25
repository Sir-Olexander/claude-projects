import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BookmarkView, ChatState, TodoItem } from '../../../shared/protocol';
import { store } from '../store';
import { formatElapsed } from '../lib/format';
import { SPINNER_WORDS } from '../lib/tools';
import { useExpanded } from '../ui';
import { send } from './actions';
import { TodoList } from './ToolCall';
import { Icon, IconButton } from './ui';

export function Header({ state }: { state: ChatState }) {
  return (
    <header class="header">
      <div class="header-main">
        <Icon name={state.isWorktree ? 'worktree' : 'repo'} class="header-icon" />
        <span class="header-project" title={state.cwd}>
          {state.projectName}
        </span>
        {state.branch ? (
          <span class="branch-chip" title={state.isWorktree ? `Worktree on ${state.branch}` : `Branch ${state.branch}`}>
            <Icon name="git-branch" />
            <span>{state.branch}</span>
          </span>
        ) : null}
        {state.title ? (
          <span class="header-title" title={state.title}>
            {state.title}
          </span>
        ) : null}
      </div>
      <div class="header-actions">
        <BookmarksMenu bookmarks={state.bookmarks ?? []} />
        <IconButton icon="link-external" title="Open in Claude extension (new window)" onClick={() => send({ type: 'open-in-claude-extension' })} />
        <IconButton icon="add" title="New session" onClick={() => send({ type: 'new-session' })} />
      </div>
    </header>
  );
}

const BM_ICON: Record<BookmarkView['kind'], string> = { user: 'account', text: 'sparkle', tool: 'tools' };

function BookmarksMenu({ bookmarks }: { bookmarks: BookmarkView[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div class="bm-menu-wrap" ref={root}>
      <button type="button" class={`icon-btn bm-menu-btn${bookmarks.length ? ' has-items' : ''}`} title="Bookmarks" aria-label="Bookmarks" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bookmark" />
        {bookmarks.length ? <span class="bm-count">{bookmarks.length}</span> : null}
      </button>
      {open ? (
        <div class="bm-menu" role="menu">
          <div class="bm-menu-title">Bookmarks</div>
          {bookmarks.length === 0 ? (
            <div class="bm-empty">No bookmarks yet. Hover a message and click <Icon name="bookmark" /> to keep it here.</div>
          ) : (
            bookmarks.map((b) => (
              <div class="bm-row" role="menuitem" key={b.itemId}>
                <button
                  type="button"
                  class="bm-go"
                  onClick={() => {
                    setOpen(false);
                    store.scrollTo(b.itemId);
                  }}
                >
                  <Icon name={BM_ICON[b.kind]} class="bm-kind" />
                  <span class="bm-label">{b.label}</span>
                </button>
                <button type="button" class="bm-remove" title="Remove bookmark" aria-label="Remove bookmark" onClick={() => send({ type: 'toggle-bookmark', itemId: b.itemId })}>
                  <Icon name="close" />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Banners({ state }: { state: ChatState }) {
  return (
    <>
      {state.liveElsewhere ? (
        <div class="banner banner-warn" role="status">
          <Icon name="broadcast" />
          <div class="banner-text">
            This session is running in <b>{state.liveElsewhere.source}</b>
            {state.liveElsewhere.status ? ` (${state.liveElsewhere.status})` : ''}. A message sent here continues it as a separate copy.
          </div>
          <button type="button" class="btn btn-small" onClick={() => send({ type: 'open-in-claude-extension' })}>
            Open there
          </button>
        </div>
      ) : null}
      {state.status === 'error' || state.error ? (
        <div class="banner banner-error" role="alert">
          <Icon name="error" />
          <div class="banner-text">{state.error || 'Claude stopped unexpectedly.'}</div>
          <button type="button" class="btn btn-small" onClick={() => send({ type: 'restart' })}>
            Restart
          </button>
        </div>
      ) : null}
      {state.historyTruncated ? (
        <div class="banner banner-info">
          <Icon name="history" />
          <div class="banner-text">Older messages are hidden to keep this panel fast.</div>
          <button type="button" class="btn btn-small btn-ghost" onClick={() => send({ type: 'load-full-history' })}>
            Load full history
          </button>
        </div>
      ) : null}
    </>
  );
}

const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

function hashNum(n: number): number {
  let x = Math.floor(n) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export function RunningIndicator({ state }: { state: ChatState }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 120);
    return () => clearInterval(t);
  }, []);
  const word = useMemo(() => SPINNER_WORDS[hashNum(state.turnStartedAt ?? 0) % SPINNER_WORDS.length], [state.turnStartedAt]);
  const elapsed = state.turnStartedAt ? Date.now() - state.turnStartedAt : 0;
  const label = state.status === 'starting' ? 'Starting Claude' : state.activity || word;
  return (
    <div class="running" role="status" aria-live="polite">
      <span class="spin-glyph" aria-hidden="true">
        {GLYPHS[tick % GLYPHS.length]}
      </span>
      <span class="spin-text">{label.replace(/…$/, '')}…</span>
      <span class="spin-meta">
        ({state.turnStartedAt ? `${formatElapsed(elapsed)} · ` : ''}
        <kbd>esc</kbd> to interrupt)
      </span>
    </div>
  );
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, toggle] = useExpanded('todo-panel', true);
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  if (!todos.length || done === todos.length) return null;
  return (
    <div class={`todo-panel${open ? ' is-open' : ''}`}>
      <div class="todo-panel-head" onClick={() => toggle()} role="button" aria-expanded={open}>
        <Icon name="checklist" />
        <span class="todo-panel-title">Todos</span>
        <span class="muted">
          {done}/{todos.length}
        </span>
        {!open && current ? <span class="todo-current">{current.activeForm || current.content}</span> : null}
        <Icon name="chevron-right" class="todo-chevron" />
      </div>
      {open ? <TodoList todos={todos} /> : null}
    </div>
  );
}

/** Claude-style spark mark (simple original drawing). */
export function SparkMark({ size = 40 }: { size?: number }) {
  const rays = 10;
  const paths = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const len = i % 2 === 0 ? 19 : 15;
    const w = 2.6;
    const x1 = 24 + Math.cos(a) * 4;
    const y1 = 24 + Math.sin(a) * 4;
    const x2 = 24 + Math.cos(a) * len;
    const y2 = 24 + Math.sin(a) * len;
    const px = Math.cos(a + Math.PI / 2) * w;
    const py = Math.sin(a + Math.PI / 2) * w;
    paths.push(`M${(x1 + px).toFixed(2)} ${(y1 + py).toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} L${(x1 - px).toFixed(2)} ${(y1 - py).toFixed(2)} Z`);
  }
  return (
    <svg class="spark-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path d={paths.join(' ')} />
      <circle cx="24" cy="24" r="5" />
    </svg>
  );
}

export function EmptyState({ state }: { state: ChatState }) {
  return (
    <div class="empty">
      <SparkMark size={44} />
      <div class="empty-title">
        What should we build in <b>{state.projectName}</b>?
      </div>
      {state.branch ? (
        <div class="empty-sub">
          <Icon name="git-branch" /> {state.branch}
          {state.isWorktree ? ' · worktree' : ''}
        </div>
      ) : null}
      <ul class="empty-hints">
        <li>
          <kbd>/</kbd> commands and skills
        </li>
        <li>
          <kbd>@</kbd> mention a file
        </li>
        <li>
          <kbd>⇧</kbd>
          <kbd>Tab</kbd> switch between Manual, Edit automatically and Plan
        </li>
        <li>Paste or drop images to attach them</li>
      </ul>
    </div>
  );
}
