import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { classifyHref } from './lib/paths';
import { useStoreVersion } from './store';
import { ChatInstanceContext, PaneContext, type ChatInstance, type PaneControls } from './instance';
import { Banners, EmptyState, Header, LimitNotice, RunningIndicator, TodoPanel } from './components/chrome';
import { CopyMenu } from './components/CopyMenu';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { PendingArea } from './components/PendingCard';
import { Icon } from './components/ui';

/** Width under which a chat drops paddings and the header title. */
const NARROW_PX = 460;

/**
 * One chat. `active` says whether this chat gets the panel-wide keys (Esc
 * interrupts) and counts as seen when the window has focus: always true in a
 * chat tab; only for the focused pane in the sessions hub.
 */
export function ChatView({ chat, active, pane }: { chat: ChatInstance; active: boolean; pane?: PaneControls }) {
  return (
    <ChatInstanceContext.Provider value={chat}>
      <PaneContext.Provider value={pane}>
        <ChatApp chat={chat} active={active} />
      </PaneContext.Provider>
    </ChatInstanceContext.Provider>
  );
}

function ChatApp({ chat, active }: { chat: ChatInstance; active: boolean }) {
  const { store, send } = chat;
  useStoreVersion(store);
  const state = store.state;
  const appRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  chat.active = active;

  /** Throttled "the user has seen the latest output" signal. */
  const lastSeen = useRef(0);
  const postSeen = useCallback(() => {
    if (!activeRef.current) return;
    const now = Date.now();
    if (now - lastSeen.current < 1200) return;
    lastSeen.current = now;
    send({ type: 'seen' });
  }, [send]);

  useEffect(() => {
    const onFocus = () => postSeen();
    window.addEventListener('focus', onFocus);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) postSeen();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [postSeen]);

  // Becoming the focused pane counts as seeing it, and puts the cursor in it
  // unless something in the pane already has focus.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && document.hasFocus()) postSeen();
    if (active && !wasActive.current && !appRef.current?.contains(document.activeElement)) {
      const card = appRef.current?.querySelector<HTMLElement>('.pending-card button, .pending-card input');
      if (card) card.focus();
      else store.apply({ type: 'focus-input' });
    }
    wasActive.current = active;
  }, [active]);

  // When new output arrives while the panel has focus, count it as seen.
  useEffect(() => {
    if (state && document.hasFocus()) postSeen();
  }, [store.contentVersion, state?.status]);

  // Esc anywhere in the panel interrupts a running turn (inputs handle their own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.closest('.pending-card'))) return;
      const s = store.state;
      if (s && (s.status === 'running' || s.status === 'starting') && s.pending.length === 0) {
        e.preventDefault();
        send({ type: 'interrupt' });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, send]);

  // Narrow layout follows this chat's own width (panes of the hub are narrower than the window).
  useEffect(() => {
    const el = appRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth <= NARROW_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!state]);

  const onClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const copy = target.closest<HTMLElement>('[data-action="copy-code"]');
      if (copy) {
        e.preventDefault();
        const code = copy.closest('.code-block')?.querySelector('pre code');
        if (code) {
          chat.copyText(code.textContent ?? '');
          copy.classList.add('is-copied');
          copy.innerHTML = '<i class="codicon codicon-check"></i>';
          setTimeout(() => {
            copy.classList.remove('is-copied');
            copy.innerHTML = '<i class="codicon codicon-copy"></i>';
          }, 1200);
        }
        return;
      }
      const fileRef = target.closest<HTMLElement>('code.file-ref[data-path]');
      if (fileRef) {
        e.preventDefault();
        const line = fileRef.dataset.line ? Number(fileRef.dataset.line) : undefined;
        chat.openFile(fileRef.dataset.path!, line);
        return;
      }
      const a = target.closest<HTMLAnchorElement>('a[href]');
      if (a) {
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        const c = classifyHref(href);
        if (c?.kind === 'url') chat.openUrl(c.url);
        else if (c?.kind === 'file') chat.openFile(c.ref.path, c.ref.line);
      }
    },
    [chat],
  );

  if (!state) {
    return (
      <div class="app app-loading">
        <div class="loading">
          <Icon name="loading" spin /> Loading session…
        </div>
      </div>
    );
  }

  const busy = state.status === 'running' || state.status === 'starting';
  const showEmpty = state.items.length === 0;

  return (
    <div class={`app${narrow ? ' is-narrow' : ''}`} ref={appRef} data-status={state.status} data-mode={state.permissionMode} onClick={onClick}>
      <Header state={state} />
      <Banners state={state} />
      <CopyMenu />
      <div class="main">
        <MessageList state={state} contentVersion={store.contentVersion} empty={showEmpty ? <EmptyState state={state} /> : null} onSeen={postSeen} />
      </div>
      <div class="bottom">
        <div class="bottom-inner">
          {state.todos?.length ? <TodoPanel todos={state.todos} /> : null}
          {busy && state.pending.length === 0 ? <RunningIndicator state={state} /> : null}
          {state.limit && !busy ? <LimitNotice limit={state.limit} autoContinue={state.autoContinue} /> : null}
          {state.pending.length ? <PendingArea pending={state.pending} cwd={state.cwd} /> : null}
          {/* Kept mounted while a request is pending so the draft and attached images survive. */}
          <div class={state.pending.length ? 'is-hidden' : undefined}>
            <Composer state={state} />
          </div>
        </div>
      </div>
    </div>
  );
}
