import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AttentionState, ExtToHubMessage, HubPersisted, HubRepoView, HubSessionView, HubState, HubToExtMessage, SessionFlagName } from '../../shared/protocol';
import { FLAG_INFO, SESSION_FLAGS } from '../../shared/flags';
import { getPersisted, onMessage, post as rawPost, setPersisted } from '../common/vscodeApi';
import { ChatInstance, ChatUi, type ChatUiData, type PaneControls } from '../chat/instance';
import { ChatView } from '../chat/ChatView';
import { Icon } from '../chat/components/ui';
import '../chat/styles/base.css';
import '../chat/styles/messages.css';
import '../chat/styles/tools.css';
import '../chat/styles/composer.css';
import '../chat/styles/pending.css';
import '../chat/styles/syntax.css';
import './hub.css';

const post = (m: HubToExtMessage) => rawPost<HubToExtMessage>(m);

// Errors in the hub, kept for the visual test pass (test/e2e/hub-visual.ts).
const errors: string[] = [];
(window as unknown as { __hubErrors: string[] }).__hubErrors = errors;
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const PANE_LETTERS = ['A', 'B', 'C'];
const MAX_PANES = 3;

// ---------------------------------------------------------------------------
// Persisted webview state: the open sessions (read by the extension when VS
// Code restores the tab), each chat's draft/scroll/expanded blocks, and the
// project picked in the strip.

interface PersistedHub {
  v: 1;
  hub?: HubPersisted;
  ui: Record<string, ChatUiData>;
  selectedRepo?: string;
}

const loaded = getPersisted<PersistedHub>();
const persisted: PersistedHub = loaded && loaded.v === 1 ? { ...loaded, ui: { ...(loaded.ui ?? {}) } } : { v: 1, ui: {} };
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    setPersisted(persisted);
  }, 200);
}

// ---------------------------------------------------------------------------
// One chat instance per session shown in a pane; messages from the extension
// are routed to them by session key.

const chats = new Map<string, ChatInstance>();
/** UI state of every open chat (draft text and images, scroll), kept while it is out of the panes. */
const uis = new Map<string, ChatUi>();

function uiFor(key: string): ChatUi {
  let ui = uis.get(key);
  if (!ui) {
    ui = new ChatUi(persisted.ui[key], (data) => {
      persisted.ui[key] = { ...data, expanded: { ...(data.expanded ?? {}) } };
      saveSoon();
    });
    uis.set(key, ui);
  }
  return ui;
}

function chatFor(key: string): ChatInstance {
  let chat = chats.get(key);
  if (!chat) {
    chat = new ChatInstance((msg) => post({ type: 'chat', key, msg }), uiFor(key), 'hub');
    chats.set(key, chat);
    chat.send({ type: 'ready' });
  }
  return chat;
}

/** Drops chats no pane shows any more (their UI state stays while the chat is open). */
function dropChats(keep: Set<string>, open: Set<string>): void {
  for (const [key, chat] of chats) {
    if (keep.has(key)) continue;
    chat.ui.flush();
    chats.delete(key);
  }
  for (const key of [...uis.keys()]) if (!open.has(key)) uis.delete(key);
}

let listeners: ((s: HubState) => void)[] = [];
let lastState: HubState | undefined;

onMessage<ExtToHubMessage>((m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'chat') {
    chats.get(m.key)?.store.apply(m.msg);
  } else if (m.type === 'hub') {
    lastState = m.state;
    persisted.hub = m.state.persist;
    // Forget UI state of sessions that left the hub.
    const open = new Set(m.state.sessions.map((s) => s.key));
    for (const k of Object.keys(persisted.ui)) if (!open.has(k)) delete persisted.ui[k];
    setPersisted(persisted);
    dropChats(new Set(m.state.panes.filter((k): k is string => !!k)), open);
    for (const l of listeners) l(m.state);
  }
});

function useHubState(): HubState | undefined {
  const [state, setState] = useState<HubState | undefined>(lastState);
  useEffect(() => {
    const l = (s: HubState) => setState(s);
    listeners.push(l);
    post({ type: 'ready' });
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);
  return state;
}

// ---------------------------------------------------------------------------
// Helpers

const STATUS_LABEL: Record<AttentionState, string> = {
  'needs-input': 'Needs you',
  error: 'Stopped with an error',
  done: 'Finished',
  running: 'Running',
  idle: 'Idle',
};

const needsYou = (s: HubSessionView) => s.attention === 'needs-input' || s.attention === 'error';

/** Order inside a project: Main first, then where you put them (new chats go at the end). Switching chats never moves them. */
function ordered(sessions: HubSessionView[]): HubSessionView[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(b.s.flag === 'main') - Number(a.s.flag === 'main') || a.i - b.i)
    .map((x) => x.s);
}

type DropSide = 'before' | 'after';

/** Moves `id` before or after `target` in `list`. */
function moved(list: string[], id: string, target: string, side: DropSide): string[] {
  const rest = list.filter((x) => x !== id);
  const at = rest.indexOf(target);
  if (at < 0) return list;
  rest.splice(side === 'before' ? at : at + 1, 0, id);
  return rest;
}

/**
 * Drag to reorder the items of one strip row, with pointer events (the
 * browser's own drag and drop isn't reliable inside VS Code webviews).
 * A press that moves less than a few pixels stays a click.
 */
function useReorder(list: string[], onReorder: (next: string[]) => void, enabled: boolean) {
  const [drag, setDrag] = useState<string>();
  const [over, setOver] = useState<{ id: string; side: DropSide }>();
  const overRef = useRef<{ id: string; side: DropSide } | undefined>(undefined);
  const press = useRef<{ id: string; x: number; el: HTMLElement; pointerId: number; active: boolean } | undefined>(undefined);
  const suppressClick = useRef(false);
  const listRef = useRef(list);
  listRef.current = list;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const setTarget = (t: { id: string; side: DropSide } | undefined) => {
    overRef.current = t;
    setOver((o) => (o?.id === t?.id && o?.side === t?.side ? o : t));
  };
  const reset = () => {
    press.current = undefined;
    document.body.classList.remove('is-reordering');
    setDrag(undefined);
    setTarget(undefined);
  };

  const props = (id: string) =>
    enabled
      ? {
          'data-dnd-id': id,
          onPointerDown: (e: PointerEvent) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close')) return;
            press.current = { id, x: e.clientX, el: e.currentTarget as HTMLElement, pointerId: e.pointerId, active: false };
          },
          onPointerMove: (e: PointerEvent) => {
            const p = press.current;
            if (!p || p.pointerId !== e.pointerId) return;
            if (!p.active) {
              if (Math.abs(e.clientX - p.x) < 5) return;
              p.active = true;
              p.el.setPointerCapture?.(e.pointerId);
              document.body.classList.add('is-reordering');
              setDrag(p.id);
            }
            const items = [...(p.el.parentElement?.querySelectorAll<HTMLElement>('[data-dnd-id]') ?? [])];
            let target: { id: string; side: DropSide } | undefined;
            for (const it of items) {
              const r = it.getBoundingClientRect();
              if (e.clientX >= r.left && e.clientX <= r.right) target = { id: it.dataset.dndId!, side: e.clientX < r.left + r.width / 2 ? 'before' : 'after' };
            }
            if (!target && items.length) {
              const first = items[0].getBoundingClientRect();
              const last = items[items.length - 1];
              target = e.clientX < first.left ? { id: items[0].dataset.dndId!, side: 'before' } : e.clientX > last.getBoundingClientRect().right ? { id: last.dataset.dndId!, side: 'after' } : undefined;
            }
            setTarget(target && target.id !== p.id ? target : undefined);
            // Scroll the row when dragging near its edges.
            const scroller = p.el.closest<HTMLElement>('.strip-scroll');
            if (scroller) {
              const r = scroller.getBoundingClientRect();
              if (e.clientX < r.left + 30) scroller.scrollLeft -= 12;
              else if (e.clientX > r.right - 30) scroller.scrollLeft += 12;
            }
          },
          onPointerUp: (e: PointerEvent) => {
            const p = press.current;
            if (!p || p.pointerId !== e.pointerId) return;
            if (p.active) {
              const t = overRef.current;
              if (t) {
                const next = moved(listRef.current, p.id, t.id, t.side);
                if (next.join('\n') !== listRef.current.join('\n')) onReorderRef.current(next);
              }
              // The click that follows a drag isn't a click.
              suppressClick.current = true;
              setTimeout(() => (suppressClick.current = false), 0);
            }
            reset();
          },
          onPointerCancel: reset,
        }
      : {};
  const cls = (id: string) => (drag === id ? ' is-dragging' : over?.id === id ? ` drop-${over.side}` : '');
  /** Wraps a click handler so the click ending a drag is ignored. */
  const click = <E,>(fn: (e: E) => void) => (e: E) => {
    if (!suppressClick.current) fn(e);
  };
  return { props, cls, click };
}

function matches(s: HubSessionView, repo: HubRepoView | undefined, q: string): boolean {
  if (!q) return true;
  const hay = [s.title, repo?.name, s.branch, STATUS_LABEL[s.attention], s.waitingFor, s.flag ? FLAG_INFO[s.flag].label : ''].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function hasDraft(key: string): boolean {
  const ui = uis.get(key);
  return !!(ui ? ui.getDraft().trim() || ui.draftImages.length : persisted.ui[key]?.draft?.trim());
}

function StatusDot({ attention }: { attention: AttentionState }) {
  return (
    <span class={`st st-${attention}`} title={STATUS_LABEL[attention]} aria-label={STATUS_LABEL[attention]}>
      {attention === 'done' ? <Icon name="check" /> : attention === 'error' ? <Icon name="error" /> : <i />}
    </span>
  );
}

function FlagIcon({ flag }: { flag?: SessionFlagName }) {
  if (!flag) return null;
  return (
    <span class={`chip-flag flag-${flag}`} title={`${FLAG_INFO[flag].label}: ${FLAG_INFO[flag].description}`}>
      <Icon name={FLAG_INFO[flag].icon} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Context menus

interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
  separator?: boolean;
  heading?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

function Menu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${menu.y + r.height > window.innerHeight - 4 ? Math.max(4, menu.y - r.height) : menu.y}px`;
  }, [menu]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div class="hub-menu" ref={ref} role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={i} class="hub-menu-sep" />
        ) : it.heading ? (
          <div key={i} class="hub-menu-heading">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            class={`hub-menu-item${it.danger ? ' is-danger' : ''}${it.checked ? ' is-checked' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run?.();
            }}
          >
            <span class="hub-menu-icon">{it.icon ? <Icon name={it.icon} /> : null}</span>
            <span class="hub-menu-label">{it.label}</span>
            {it.checked ? <Icon name="check" class="hub-menu-check" /> : it.hint ? <span class="hub-menu-hint">{it.hint}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal scroller with edge fades (both strip rows).

function Scroller({ children, class: cls, revealSelector, revealKey }: { children: ComponentChildren; class?: string; revealSelector?: string; revealKey?: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  useLayoutEffect(update);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // A vertical wheel scrolls the row sideways.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, []);
  // Keep the selected item in view.
  useEffect(() => {
    const target = revealSelector ? ref.current?.querySelector<HTMLElement>(revealSelector) : null;
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [revealKey]);
  return (
    <div class={`strip-wrap${edges.left ? ' can-left' : ''}${edges.right ? ' can-right' : ''}${cls ? ' ' + cls : ''}`}>
      <div class="strip-scroll" ref={ref} onScroll={update}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The app

function App() {
  const state = useHubState();
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>(persisted.selectedRepo);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<MenuState | undefined>();
  const [legend, setLegend] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const repos = state?.repos ?? [];
  const sessions = state?.sessions ?? [];
  const panes = state?.panes ?? [null];
  const focusedPane = state?.focusedPane ?? 0;
  const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const byKey = useMemo(() => new Map(sessions.map((s) => [s.key, s])), [sessions]);

  // The strip follows the focused pane's project when the extension asks (a session was shown, a pane focused).
  useEffect(() => {
    if (!state) return;
    const key = state.panes[state.focusedPane];
    const repo = key ? byKey.get(key)?.repoId : undefined;
    if (repo) setSelectedRepo(repo);
  }, [state?.followSeq]);

  // Keep a valid selection.
  const selected = selectedRepo && repoById.has(selectedRepo) ? selectedRepo : repos[0]?.id;
  useEffect(() => {
    if (persisted.selectedRepo === selected) return;
    persisted.selectedRepo = selected;
    saveSoon();
  }, [selected]);

  const q = filter.trim();
  const row2 = useMemo(() => {
    if (q) return ordered(sessions.filter((s) => matches(s, repoById.get(s.repoId), q)));
    return ordered(sessions.filter((s) => s.repoId === selected));
  }, [sessions, selected, q, repoById]);
  const matchingRepos = useMemo(() => new Set(q ? sessions.filter((s) => matches(s, repoById.get(s.repoId), q)).map((s) => s.repoId) : []), [sessions, q, repoById]);

  const repoDnd = useReorder(
    repos.map((r) => r.id),
    (ids) => post({ type: 'reorder-repos', ids }),
    !q,
  );

  const chipDnd = useReorder(
    row2.map((s) => s.key),
    (keys) => post({ type: 'reorder-sessions', keys }),
    !q,
  );

  const show = (key: string, pane?: number) => post({ type: 'show', key, pane });
  const setFlag = (key: string, flag: SessionFlagName | undefined) => post({ type: 'set-flag', key, flag });

  // Keys: 1–9 open the Nth session of the second row, Alt+1–9 pick the Nth project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m) return;
      const n = Number(m[1]) - 1;
      if (e.altKey) {
        const repo = repos[n];
        if (!repo) return;
        e.preventDefault();
        setFilter('');
        setSelectedRepo(repo.id);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
      const s = row2[n];
      if (!s) return;
      e.preventDefault();
      show(s.key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [repos, row2]);

  const selRepo = selected ? repoById.get(selected) : undefined;
  const trashedHere = selRepo ? sessions.filter((s) => s.repoId === selRepo.id && s.flag === 'trash') : [];

  const sessionMenu = (e: MouseEvent, s: HubSessionView) => {
    e.preventDefault();
    const inPane = panes.indexOf(s.key);
    const items: MenuItem[] = [
      { label: 'Flag', heading: true },
      ...SESSION_FLAGS.map((f) => ({ label: FLAG_INFO[f].label, icon: FLAG_INFO[f].icon, checked: s.flag === f, run: () => setFlag(s.key, s.flag === f ? undefined : f) })),
      ...(s.flag ? [{ label: 'Clear flag', icon: 'close', run: () => setFlag(s.key, undefined) }] : []),
      { label: '', separator: true },
      ...panes.map((k, i) => ({
        label: panes.length > 1 ? `Show in pane ${PANE_LETTERS[i]}` : 'Show',
        icon: 'layout',
        disabled: inPane === i,
        hint: k && k !== s.key ? byKey.get(k)?.title : undefined,
        run: () => show(s.key, i),
      })),
      ...(panes.length < MAX_PANES
        ? [
            {
              label: 'Show in a new pane',
              icon: 'split-horizontal',
              run: () => {
                post({ type: 'set-pane-count', count: panes.length + 1 });
                show(s.key, panes.length);
              },
            },
          ]
        : []),
      { label: 'Pop out to its own tab', icon: 'multiple-windows', run: () => post({ type: 'pop-out', key: s.key }) },
      { label: 'Show in Projects view', icon: 'list-tree', run: () => post({ type: 'reveal-in-projects', key: s.key }) },
      { label: '', separator: true },
      { label: 'Close chat', icon: 'close', run: () => post({ type: 'close-sessions', keys: [s.key] }) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const repoMenu = (x: number, y: number, r: HubRepoView) => {
    const here = sessions.filter((s) => s.repoId === r.id);
    const trashed = here.filter((s) => s.flag === 'trash');
    const items: MenuItem[] = [
      { label: 'New session', icon: 'add', run: () => post({ type: 'new-session', repoId: r.id }) },
      { label: '', separator: true },
      { label: trashed.length ? `Delete ${trashed.length} trashed` : 'No trashed sessions', icon: 'trash', danger: !!trashed.length, disabled: !trashed.length, run: () => post({ type: 'delete-trashed', repoId: r.id }) },
      { label: `Close all ${here.length} chat${here.length === 1 ? '' : 's'}`, icon: 'close-all', run: () => post({ type: 'close-sessions', keys: here.map((s) => s.key) }) },
    ];
    setMenu({ x, y, items });
  };

  const paneControls = (i: number, key: string): PaneControls => {
    const s = byKey.get(key);
    return {
      flag: s?.flag,
      setFlag: (flag) => setFlag(key, flag),
      popOut: () => post({ type: 'pop-out', key }),
      closeSession: () => post({ type: 'close-sessions', keys: [key] }),
      closePane: panes.length > 1 ? () => post({ type: 'close-pane', pane: i }) : undefined,
    };
  };

  if (!state) {
    return (
      <div class="hub hub-loading">
        <Icon name="loading" spin /> Loading…
      </div>
    );
  }

  const selColor = selRepo && !q ? `var(--repo-${selRepo.color})` : 'var(--repo-none)';

  return (
    <div class="hub">
      <div class={`hub-top${q ? ' is-filtering' : ''}`} style={{ '--sel': selColor }}>
        <div class="row1">
          <Scroller class="row1-scroll" revealSelector=".rtab.is-selected" revealKey={selected}>
            <div class="rtabs" role="tablist" aria-label="Projects">
              {repos.length === 0 ? <span class="strip-empty">Claude Chats</span> : null}
              {repos.map((r, i) => {
                const here = sessions.filter((s) => s.repoId === r.id);
                const needs = here.filter(needsYou).length;
                const running = here.filter((s) => s.attention === 'running').length;
                const done = here.filter((s) => s.attention === 'done').length;
                const trashed = here.filter((s) => s.flag === 'trash').length;
                const letters = panes.map((k, pi) => (k && byKey.get(k)?.repoId === r.id ? pi : -1)).filter((pi) => pi >= 0);
                const isSel = !q && r.id === selected;
                const dim = !!q && !matchingRepos.has(r.id);
                return (
                  <div
                    key={r.id}
                    role="tab"
                    tabIndex={0}
                    aria-selected={isSel}
                    {...repoDnd.props(r.id)}
                    class={`rtab${isSel ? ' is-selected' : ''}${dim ? ' is-dim' : ''}${repoDnd.cls(r.id)}`}
                    style={{ '--c': `var(--repo-${r.color})` }}
                    title={`${r.name}\n${here.length} open · ${needs} need you · ${running} running\nDouble-click: open the chat you were last in${i < 9 ? `\nAlt+${i + 1}` : ''}`}
                    onClick={repoDnd.click(() => {
                      setFilter('');
                      setSelectedRepo(r.id);
                    })}
                    onDblClick={(e) => {
                      if ((e.target as HTMLElement).closest('.tab-close')) return;
                      // Opens the project's chat you last opened or worked in.
                      const last = [...here].sort((a, b) => (b.enteredAt ?? 0) - (a.enteredAt ?? 0))[0];
                      if (last) show(last.key);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setFilter('');
                        setSelectedRepo(r.id);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      repoMenu(e.clientX, e.clientY, r);
                    }}
                  >
                    <span class="rdot" />
                    <span class="rname">{r.name}</span>
                    <span class="rcount">{here.length}</span>
                    {running ? (
                      <span class="rmini" title={`${running} running`}>
                        <span class="st st-running">
                          <i />
                        </span>
                        {running > 1 ? running : null}
                      </span>
                    ) : null}
                    {done ? (
                      <span class="rmini rdone" title={`${done} finished`}>
                        <Icon name="check" />
                        {done > 1 ? done : null}
                      </span>
                    ) : null}
                    {needs ? <span class="needs-badge" title={`${needs} need${needs === 1 ? 's' : ''} you`}>{needs}</span> : null}
                    {trashed ? (
                      <span class="trash-badge" title={`${trashed} flagged Trash`}>
                        <Icon name="trash" />
                        {trashed}
                      </span>
                    ) : null}
                    {letters.map((pi) => (
                      <span key={pi} class={`pane-pip${pi === focusedPane ? ' is-focused' : ''}`} title={`Shown in pane ${PANE_LETTERS[pi]}`}>
                        {PANE_LETTERS[pi]}
                      </span>
                    ))}
                    <span
                      role="button"
                      tabIndex={-1}
                      class="tab-close"
                      title={`Close the ${here.length} chat${here.length === 1 ? '' : 's'} of ${r.name} (right-click for more)`}
                      aria-label={`Close the chats of ${r.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        post({ type: 'close-sessions', keys: here.map((s) => s.key) });
                      }}
                    >
                      <Icon name="close" />
                    </span>
                  </div>
                );
              })}
            </div>
          </Scroller>
          <div class="controls">
            <label class="filter">
              <Icon name="search" />
              <input
                ref={filterRef}
                type="text"
                placeholder="Filter chats"
                value={filter}
                onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setFilter('');
                    filterRef.current?.blur();
                  } else if (e.key === 'Enter' && row2[0]) show(row2[0].key);
                }}
              />
            </label>
            <div class="seg" role="group" aria-label="Panes" title="Chats side by side">
              <span class="seg-lead">
                <Icon name="layout" />
              </span>
              {[1, 2, 3].map((n) => (
                <button type="button" key={n} class={panes.length === n ? 'is-on' : undefined} aria-pressed={panes.length === n} onClick={() => post({ type: 'set-pane-count', count: n })}>
                  {n}
                </button>
              ))}
            </div>
            <button type="button" class="cbtn icon" title="Open the Claude Sessions dashboard" onClick={() => post({ type: 'open-dashboard' })}>
              <Icon name="dashboard" />
            </button>
            <button type="button" class={`cbtn icon${legend ? ' is-on' : ''}`} title="Status, flags and keys" aria-expanded={legend} onClick={() => setLegend(!legend)}>
              <Icon name="question" />
            </button>
          </div>
        </div>
        <div class="row2" hidden={sessions.length === 0}>
          <Scroller class="row2-scroll" revealSelector=".chip.in-focus" revealKey={`${panes[focusedPane]}|${selected}`}>
            <div class="strip" role="toolbar" aria-label={q ? 'Matching chats' : `Chats in ${selRepo?.name ?? 'this project'}`}>
              {row2.length === 0 ? <span class="strip-empty">{q ? 'No chats match' : selRepo ? `No open chats in ${selRepo.name}` : 'Open a session from the Projects view, or start a new one'}</span> : null}
              {row2.map((s, i) => {
                const paneIdx = panes.indexOf(s.key);
                const repo = repoById.get(s.repoId);
                const tip = [s.title, repo?.name + (s.branch ? ` · ${s.isWorktree ? 'worktree ' : ''}${s.branch}` : ''), s.waitingFor ?? s.activity ?? STATUS_LABEL[s.attention], s.flag ? `Flag: ${FLAG_INFO[s.flag].label}` : '', i < 9 ? `Key ${i + 1}` : '']
                  .filter(Boolean)
                  .join('\n');
                return (
                  <button
                    type="button"
                    key={s.key}
                    class={`chip st-${s.attention}${s.flag ? ` f-${s.flag}` : ''}${paneIdx >= 0 ? ' in-pane' : ''}${paneIdx === focusedPane ? ' in-focus' : ''}${chipDnd.cls(s.key)}`}
                    style={{ '--c': repo ? `var(--repo-${repo.color})` : 'var(--repo-none)' }}
                    title={tip}
                    {...chipDnd.props(s.key)}
                    onClick={chipDnd.click(() => show(s.key))}
                    onContextMenu={(e) => sessionMenu(e, s)}
                    onAuxClick={(e) => {
                      if (e.button === 1) post({ type: 'close-sessions', keys: [s.key] });
                    }}
                  >
                    {paneIdx >= 0 && panes.length > 1 ? <span class="chip-pane">{PANE_LETTERS[paneIdx]}</span> : null}
                    {q ? <span class="rdot" /> : null}
                    <StatusDot attention={s.attention} />
                    <span class="ttl">{s.title}</span>
                    {s.isWorktree && s.branch ? (
                      <span class="bchip">
                        <Icon name="git-branch" />
                        <span>{s.branch}</span>
                      </span>
                    ) : null}
                    <FlagIcon flag={s.flag} />
                    {hasDraft(s.key) && paneIdx < 0 ? <span class="draft-dot" title="Unsent draft" /> : null}
                    {/* Always there: the close button takes its place on hover. */}
                    <span class="num">{i < 9 ? i + 1 : ''}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      class="tab-close"
                      title="Close this chat (middle-click works too)"
                      aria-label={`Close ${s.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        post({ type: 'close-sessions', keys: [s.key] });
                      }}
                    >
                      <Icon name="close" />
                    </span>
                  </button>
                );
              })}
              {!q && selRepo ? (
                <button type="button" class="addbtn" title={`New session in ${selRepo.name}`} onClick={() => post({ type: 'new-session', repoId: selRepo.id })}>
                  <Icon name="add" />
                </button>
              ) : null}
            </div>
          </Scroller>
          {!q && trashedHere.length ? (
            <div class="row2-acts">
              <button type="button" class="delbtn" title="Delete the sessions flagged Trash (asks first)" onClick={() => post({ type: 'delete-trashed', repoId: selRepo!.id })}>
                <Icon name="trash" />
                Delete {trashedHere.length} trashed
              </button>
            </div>
          ) : null}
        </div>
        {legend ? <Legend onClose={() => setLegend(false)} /> : null}
      </div>
      <div class={`panes${panes.length > 1 ? ' is-split' : ''}`} style={{ '--n': String(panes.length) }}>
        {panes.map((key, i) => {
          const s = key ? byKey.get(key) : undefined;
          const repo = s ? repoById.get(s.repoId) : undefined;
          const focused = i === focusedPane;
          return (
            <section
              key={i}
              class={`pane${focused ? ' is-focused' : ''}`}
              style={{ '--c': repo ? `var(--repo-${repo.color})` : 'var(--repo-none)' }}
              aria-label={`Pane ${PANE_LETTERS[i]}${s ? `: ${s.title}` : ''}`}
              onMouseDownCapture={() => {
                if (!focused) post({ type: 'focus-pane', pane: i });
              }}
              onFocusCapture={() => {
                if (!focused) post({ type: 'focus-pane', pane: i });
              }}
            >
              {key && s ? (
                <ChatView key={key} chat={chatFor(key)} active={focused} pane={paneControls(i, key)} />
              ) : (
                <EmptyPane
                  index={i}
                  paneCount={panes.length}
                  waiting={sessions.filter((x) => !panes.includes(x.key) && (needsYou(x) || x.attention === 'done'))}
                  others={sessions.filter((x) => !panes.includes(x.key))}
                  repoById={repoById}
                  onShow={(k) => show(k, i)}
                />
              )}
            </section>
          );
        })}
      </div>
      {menu ? <Menu menu={menu} onClose={() => setMenu(undefined)} /> : null}
    </div>
  );
}

function EmptyPane({
  index,
  paneCount,
  waiting,
  others,
  repoById,
  onShow,
}: {
  index: number;
  paneCount: number;
  waiting: HubSessionView[];
  others: HubSessionView[];
  repoById: Map<string, HubRepoView>;
  onShow: (key: string) => void;
}) {
  const quick = (waiting.length ? waiting : others).slice(0, 5);
  return (
    <div class="pane-empty">
      <Icon name="comment-discussion" class="pane-empty-icon" />
      {others.length === 0 && paneCount === 1 ? (
        <>
          <div class="pane-empty-title">No chats open</div>
          <div class="pane-empty-text">Open a session from the Projects view, or start a new one. Open chats line up in the strip above, grouped by project.</div>
          <div class="pane-empty-actions">
            <button type="button" class="btn" onClick={() => post({ type: 'new-session' })}>
              <Icon name="add" /> New session
            </button>
            <button type="button" class="btn btn-ghost" onClick={() => post({ type: 'open-session-picker' })}>
              <Icon name="search" /> Find a session
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="pane-empty-title">{paneCount > 1 ? `Pane ${PANE_LETTERS[index]} is empty` : 'Pick a chat'}</div>
          <div class="pane-empty-text">Click a chat in the strip above to show it here.</div>
          {quick.length ? (
            <div class="quick">
              <div class="quick-title">{waiting.length ? 'Waiting for you' : 'Open chats'}</div>
              {quick.map((s) => {
                const repo = repoById.get(s.repoId);
                return (
                  <button type="button" key={s.key} class={`chip st-${s.attention}`} style={{ '--c': repo ? `var(--repo-${repo.color})` : 'var(--repo-none)' }} onClick={() => onShow(s.key)}>
                    <span class="rdot" />
                    <StatusDot attention={s.attention} />
                    <span class="ttl">{s.title}</span>
                    <span class="quick-repo">{repo?.name}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {paneCount > 1 ? (
            <button type="button" class="btn btn-ghost btn-small" onClick={() => post({ type: 'close-pane', pane: index })}>
              Close this pane
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function Legend({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const statuses: AttentionState[] = ['needs-input', 'running', 'done', 'idle', 'error'];
  return (
    <div class="legend" role="dialog" aria-label="Status, flags and keys">
      <div class="legend-col">
        <div class="legend-title">Status (automatic)</div>
        {statuses.map((a) => (
          <div class="legend-row" key={a}>
            <StatusDot attention={a} />
            <span>{STATUS_LABEL[a]}</span>
          </div>
        ))}
      </div>
      <div class="legend-col">
        <div class="legend-title">Flags (yours)</div>
        {SESSION_FLAGS.map((f) => (
          <div class="legend-row" key={f}>
            <FlagIcon flag={f} />
            <span>
              <b>{FLAG_INFO[f].label}</b> {FLAG_INFO[f].description}
            </span>
          </div>
        ))}
        <div class="legend-note">Right-click a chat, or use the tag in its header.</div>
      </div>
      <div class="legend-col">
        <div class="legend-title">Keys</div>
        <div class="legend-row">
          <kbd>1</kbd>–<kbd>9</kbd> <span>Show the Nth chat of the project</span>
        </div>
        <div class="legend-row">
          <kbd>Alt</kbd>+<kbd>1</kbd>–<kbd>9</kbd> <span>Pick the Nth project</span>
        </div>
        <div class="legend-row">
          <span class="legend-mouse">Double-click a project</span> <span>Open the chat you were last in</span>
        </div>
        <div class="legend-row">
          <kbd>Esc</kbd> <span>Stop Claude in the focused chat</span>
        </div>
        <div class="legend-row">
          <span class="legend-mouse">× or middle-click</span> <span>Close a chat</span>
        </div>
      </div>
      <button type="button" class="legend-close icon-btn" title="Close" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
