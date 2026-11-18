import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BookmarkView, ChatState, LimitStopView, SharedEnvView, TodoItem } from '../../../shared/protocol';
import { clockTime, countdown } from '../../../util/time';
import { formatElapsed } from '../lib/format';
import { SPINNER_WORDS } from '../lib/tools';
import { TodoList } from './ToolCall';
import { Icon, IconButton } from './ui';
import { useChat, useExpanded, usePane, type PaneControls } from '../instance';
import { FLAG_INFO, SESSION_FLAGS } from '../../../shared/flags';

export function Header({ state }: { state: ChatState }) {
  const chat = useChat();
  const { send } = chat;
  const pane = usePane();
  return (
    <header class="header">
      <div class="header-main">
        <Icon name={state.isWorktree ? 'worktree' : 'repo'} class="header-icon" />
        <button type="button" class="header-project" title={`${state.cwd}\nShow in the Projects view`} onClick={() => send({ type: 'reveal-project' })}>
          {state.projectName}
        </button>
        {state.branch ? (
          <span class="branch-chip" title={state.isWorktree ? `Worktree on ${state.branch}` : `Branch ${state.branch}`}>
            <Icon name="git-branch" />
            <span>{state.branch}</span>
          </span>
        ) : null}
        <SessionName title={state.title} />
      </div>
      <div class="header-actions">
        {state.agents?.length ? <AgentsChip agents={state.agents} /> : null}
        <SharedEnvMenu env={state.sharedEnv ?? { available: [], enabled: [] }} />
        <IconButton
          icon="remote"
          title={state.remote?.state === 'on' ? 'Remote Control is on. Click to turn it off.' : 'Remote Control: continue this chat from claude.ai or the Claude app'}
          class={state.remote?.state === 'on' ? 'is-on' : undefined}
          onClick={() => send({ type: 'remote-control', on: !(state.remote?.state === 'on' || state.remote?.state === 'connecting') })}
        />
        <BookmarksMenu bookmarks={state.bookmarks ?? []} />
        {pane ? (
          <>
            <FlagMenu pane={pane} />
            <PaneMoreMenu pane={pane} />
            <IconButton icon="close" title="Close this chat (it stays in the Projects view)" onClick={() => pane.closeSession()} />
          </>
        ) : (
          <>
            <IconButton icon="link-external" title="Open in Claude extension (new window)" onClick={() => send({ type: 'open-in-claude-extension' })} />
            <IconButton icon="add" title="New session" onClick={() => send({ type: 'new-session' })} />
            <IconButton icon="trash" title="Delete session" onClick={() => send({ type: 'delete-session' })} />
            {chat.place === 'tab' ? <IconButton icon="layout-panel-justify" title="Move to Claude Chats (the sessions hub)" onClick={() => send({ type: 'move-to-hub' })} /> : null}
          </>
        )}
      </div>
    </header>
  );
}

/** The session's name in the header: click it to rename in place (Enter saves, Esc cancels). */
function SessionName({ title }: { title: string }) {
  const { send } = useChat();
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Set once Enter/Esc/blur ended the edit, so a blur that follows doesn't save again.
  const done = useRef(false);
  useEffect(() => {
    if (!editing) return;
    done.current = false;
    input.current?.focus();
    input.current?.select();
  }, [editing]);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = input.current?.value.replace(/\s+/g, ' ').trim() ?? '';
    setEditing(false);
    if (save && value && value !== title) send({ type: 'rename', title: value });
  };
  if (editing) {
    return (
      <input
        ref={input}
        class="header-title-input"
        defaultValue={title}
        aria-label="Session name"
        maxLength={200}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
      />
    );
  }
  return (
    <button type="button" class="header-title" title={`${title || 'Untitled session'}\nClick to rename`} onClick={() => setEditing(true)}>
      {title || 'Untitled session'}
    </button>
  );
}

/** "2 agents running", with the list on hover; click jumps to the first one. */
function AgentsChip({ agents }: { agents: NonNullable<ChatState['agents']> }) {
  const { store } = useChat();
  const n = agents.length;
  const list = agents.map((a) => `• ${a.type}${a.description ? ` — ${a.description}` : ''}${a.background ? ' (background)' : ''}`).join('\n');
  const first = agents.find((a) => a.itemId);
  return (
    <button
      type="button"
      class="agents-chip"
      title={`${n} agent${n > 1 ? 's' : ''} running\n${list}`}
      aria-label={`${n} agent${n > 1 ? 's' : ''} running`}
      onClick={() => first?.itemId && store.scrollTo(first.itemId)}
    >
      <Icon name="loading" spin />
      <span>
        {n} agent{n > 1 ? 's' : ''}
      </span>
    </button>
  );
}

/**
 * The shared .env, per chat: a switch to use it here and a checkbox per
 * variable (none by default). Names only; the values never reach the chat.
 */
function SharedEnvMenu({ env }: { env: SharedEnvView }) {
  const { store, send } = useChat();
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
  const enabled = new Set(env.enabled);
  const on = env.enabled.length > 0;
  const setNames = (names: string[]) => send({ type: 'set-shared-env', names });
  const toggle = (name: string) => setNames(enabled.has(name) ? env.enabled.filter((n) => n !== name) : [...env.enabled, name]);
  return (
    <div class="bm-menu-wrap" ref={root}>
      <button
        type="button"
        class={`icon-btn bm-menu-btn${on ? ' has-items is-on' : ''}`}
        title="Shared .env"
        aria-label={`Shared .env: ${env.enabled.length} of ${env.available.length} variables in this chat`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="key" />
        {on ? <span class="bm-count">{env.enabled.length}</span> : null}
      </button>
      {open ? (
        <div class="bm-menu env-menu" role="menu">
          <div class="bm-menu-title">Shared .env</div>
          {env.available.length === 0 ? (
            <div class="bm-empty">No variables yet. Add lines like MY_API_KEY=… to the shared .env and save it.</div>
          ) : (
            <>
              <label class="env-master">
                <button type="button" role="switch" aria-checked={on} class={`switch${on ? ' is-on' : ''}`} onClick={() => setNames(on ? [] : env.available)}>
                  <span class="switch-knob" />
                </button>
                <span>Use in this chat</span>
              </label>
              <div class="env-hint">Claude gets the checked variables in its environment and knows their names, not their values.</div>
              {env.available.map((n) => (
                <div class="env-row" key={n}>
                  <label class="env-check">
                    <input type="checkbox" checked={enabled.has(n)} onChange={() => toggle(n)} />
                    <span class="env-name">{n}</span>
                  </label>
                  {enabled.has(n) ? (
                    <button
                      type="button"
                      class="env-insert"
                      title={`Insert $${n} in your message`}
                      aria-label={`Insert $${n} in your message`}
                      onClick={() => {
                        setOpen(false);
                        store.insertText(`$${n}`);
                      }}
                    >
                      <Icon name="insert" />
                    </button>
                  ) : null}
                </div>
              ))}
              {env.pending ? <div class="env-note">Applies when Claude finishes what it's doing (it restarts; the conversation continues).</div> : null}
            </>
          )}
          <button
            type="button"
            class="env-edit"
            onClick={() => {
              setOpen(false);
              send({ type: 'open-global-env' });
            }}
          >
            <Icon name="edit" /> Edit shared .env
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Closes a header menu on an outside click or Esc. */
function useMenuClose(open: boolean, setOpen: (v: boolean) => void) {
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
  return root;
}

/** The rarer actions of a chat in a hub pane, kept out of its narrow header. */
function PaneMoreMenu({ pane }: { pane: PaneControls }) {
  const { send } = useChat();
  const [open, setOpen] = useState(false);
  const root = useMenuClose(open, setOpen);
  const items: { label: string; icon: string; run: () => void; danger?: boolean }[] = [
    { label: 'New session in this project', icon: 'add', run: () => send({ type: 'new-session' }) },
    { label: 'Pop out to its own tab', icon: 'multiple-windows', run: () => pane.popOut() },
    ...(pane.closePane ? [{ label: 'Close this pane', icon: 'split-horizontal', run: () => pane.closePane!() }] : []),
    { label: 'Open in Claude extension (new window)', icon: 'link-external', run: () => send({ type: 'open-in-claude-extension' }) },
    { label: 'Delete session…', icon: 'trash', danger: true, run: () => send({ type: 'delete-session' }) },
  ];
  return (
    <div class="bm-menu-wrap" ref={root}>
      <button type="button" class="icon-btn" title="More actions" aria-label="More actions" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="ellipsis" />
      </button>
      {open ? (
        <div class="bm-menu more-menu" role="menu">
          {items.map((it) => (
            <button
              type="button"
              role="menuitem"
              key={it.label}
              class={`flag-item more-item${it.danger ? ' is-danger' : ''}`}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
            >
              <Icon name={it.icon} class="flag-icon" />
              <span class="more-label">{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The session's flag (hub panes): a mark of what you mean to do with it. */
function FlagMenu({ pane }: { pane: PaneControls }) {
  const [open, setOpen] = useState(false);
  const root = useMenuClose(open, setOpen);
  const current = pane.flag ? FLAG_INFO[pane.flag] : undefined;
  return (
    <div class="bm-menu-wrap" ref={root}>
      <button
        type="button"
        class={`icon-btn flag-btn${pane.flag ? ` has-flag flag-${pane.flag}` : ''}`}
        title={current ? `Flag: ${current.label}. Click to change.` : 'Flag this session'}
        aria-label="Flag"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={current ? current.icon : 'tag'} />
      </button>
      {open ? (
        <div class="bm-menu flag-menu" role="menu">
          <div class="bm-menu-title">Flag</div>
          {SESSION_FLAGS.map((f) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={pane.flag === f}
              class={`flag-item flag-${f}${pane.flag === f ? ' is-current' : ''}`}
              key={f}
              onClick={() => {
                setOpen(false);
                pane.setFlag(pane.flag === f ? undefined : f);
              }}
            >
              <Icon name={FLAG_INFO[f].icon} class="flag-icon" />
              <span class="flag-label">{FLAG_INFO[f].label}</span>
              <span class="flag-desc">{FLAG_INFO[f].description}</span>
              {pane.flag === f ? <Icon name="check" class="flag-check" /> : null}
            </button>
          ))}
          {pane.flag ? (
            <button
              type="button"
              role="menuitem"
              class="flag-item flag-clear"
              onClick={() => {
                setOpen(false);
                pane.setFlag(undefined);
              }}
            >
              <Icon name="close" class="flag-icon" />
              <span class="flag-label">Clear flag</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const BM_ICON: Record<BookmarkView['kind'], string> = { user: 'account', text: 'sparkle', tool: 'tools' };

function BookmarksMenu({ bookmarks }: { bookmarks: BookmarkView[] }) {
  const { store, send } = useChat();
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
  const { send } = useChat();
  const remote = state.remote;
  return (
    <>
      {remote?.state === 'on' ? (
        <div class="banner banner-remote" role="status">
          <Icon name="remote" />
          <div class="banner-text">
            <b>Remote Control is on.</b> Continue this chat from claude.ai or the Claude app. It stays on while the chat is open here.
          </div>
          {remote.url ? (
            <>
              <button type="button" class="btn btn-small" onClick={() => send({ type: 'open-url', url: remote.url! })}>
                Open
              </button>
              <button type="button" class="btn btn-small btn-ghost" onClick={() => send({ type: 'copy', text: remote.url! })}>
                Copy link
              </button>
            </>
          ) : null}
          <button type="button" class="btn btn-small btn-ghost" onClick={() => send({ type: 'remote-control', on: false })}>
            Turn off
          </button>
        </div>
      ) : remote?.state === 'connecting' ? (
        <div class="banner banner-info" role="status">
          <Icon name="loading" spin />
          <div class="banner-text">Turning on Remote Control…</div>
        </div>
      ) : remote?.state === 'error' ? (
        <div class="banner banner-error" role="alert">
          <Icon name="error" />
          <div class="banner-text">Remote Control couldn't start: {remote.error}</div>
          <button type="button" class="btn btn-small btn-ghost" onClick={() => send({ type: 'remote-control', on: false })}>
            Dismiss
          </button>
        </div>
      ) : null}
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

/** Shown above the message box while the chat is stopped at a usage limit. */
export function LimitNotice({ limit, autoContinue }: { limit: LimitStopView; autoContinue: boolean }) {
  const { send } = useChat();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);
  const resets = limit.resetsAt;
  const headline = limit.message.replace(/\s*·.*$/, '').replace(/^You['’]ve hit your/i, 'You hit your') || 'Usage limit reached';
  return (
    <div class="limit-notice" role="status">
      <Icon name="watch" class="limit-icon" />
      <div class="limit-body">
        <div class="limit-title">
          {headline}
          {resets ? (
            <span class="limit-reset">
              {' '}
              · resets {clockTime(resets, now)} (in {countdown(resets, now)})
            </span>
          ) : null}
        </div>
        <label class="limit-switch">
          <button type="button" role="switch" aria-checked={autoContinue} class={`switch${autoContinue ? ' is-on' : ''}`} onClick={() => send({ type: 'set-auto-continue', on: !autoContinue })}>
            <span class="switch-knob" />
          </button>
          <span>Continue automatically when limits reset</span>
        </label>
        {autoContinue && limit.continueAt ? (
          <div class="limit-sub">
            Sends “continue” at {clockTime(limit.continueAt, now)}
            {limit.resetsAt ? '' : ' (reset time unknown, so it tries then)'}. Keep VS Code open.
          </div>
        ) : null}
      </div>
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
