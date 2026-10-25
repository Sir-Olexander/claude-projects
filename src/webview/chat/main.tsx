import { render } from 'preact';
import { useCallback, useEffect, useRef } from 'preact/hooks';
import type { ExtToChatMessage } from '../../shared/protocol';
import { onMessage } from '../common/vscodeApi';
import { classifyHref } from './lib/paths';
import { store, useStoreVersion } from './store';
import { saveSession } from './ui';
import { copyText, openFile, openUrl, send } from './components/actions';
import { Banners, EmptyState, Header, RunningIndicator, TodoPanel } from './components/chrome';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { PendingArea } from './components/PendingCard';
import { Icon } from './components/ui';
import './styles/base.css';
import './styles/messages.css';
import './styles/tools.css';
import './styles/composer.css';
import './styles/pending.css';
import './styles/syntax.css';

// Listen before announcing readiness so the first `state` is never missed.
onMessage<ExtToChatMessage>((m) => {
  if (!m || typeof m !== 'object' || !('type' in m)) return;
  store.apply(m);
  // Keep the session identity in the persisted webview state for the panel serializer.
  const touchesSession = m.type === 'state' || (m.type === 'patch' && ('sessionId' in m.patch || 'title' in m.patch || 'cwd' in m.patch));
  const s = store.state;
  if (touchesSession && s) saveSession({ key: s.key, sessionId: s.sessionId, cwd: s.cwd, title: s.title });
});

/** Throttled "the user has seen the latest output" signal. */
let lastSeen = 0;
function postSeen(): void {
  const now = Date.now();
  if (now - lastSeen < 1200) return;
  lastSeen = now;
  send({ type: 'seen' });
}

function onDocumentClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const copy = target.closest<HTMLElement>('[data-action="copy-code"]');
  if (copy) {
    e.preventDefault();
    const code = copy.closest('.code-block')?.querySelector('pre code');
    if (code) {
      copyText(code.textContent ?? '');
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
    openFile(fileRef.dataset.path!, line);
    return;
  }
  const a = target.closest<HTMLAnchorElement>('a[href]');
  if (a) {
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    const c = classifyHref(href);
    if (c?.kind === 'url') openUrl(c.url);
    else if (c?.kind === 'file') openFile(c.ref.path, c.ref.line);
  }
}

function App() {
  useStoreVersion();
  const state = store.state;
  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    send({ type: 'ready' });
    document.addEventListener('click', onDocumentClick);
    const onFocus = () => postSeen();
    window.addEventListener('focus', onFocus);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) postSeen();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('click', onDocumentClick);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // When new output arrives while the panel has focus, count it as seen.
  useEffect(() => {
    if (state && document.hasFocus()) postSeen();
  }, [store.contentVersion, state?.status]);

  // Esc anywhere in the panel interrupts a running turn (inputs handle their own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
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
  }, []);

  const onSeen = useCallback(() => postSeen(), []);

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
    <div class="app" ref={appRef} data-status={state.status} data-mode={state.permissionMode}>
      <Header state={state} />
      <Banners state={state} />
      <div class="main">
        <MessageList state={state} contentVersion={store.contentVersion} empty={showEmpty ? <EmptyState state={state} /> : null} onSeen={onSeen} />
      </div>
      <div class="bottom">
        <div class="bottom-inner">
          {state.todos?.length ? <TodoPanel todos={state.todos} /> : null}
          {busy && state.pending.length === 0 ? <RunningIndicator state={state} /> : null}
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

render(<App />, document.getElementById('root')!);
