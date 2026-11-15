import { render } from 'preact';
import type { ChatToExtMessage, ExtToChatMessage } from '../../shared/protocol';
import { getPersisted, onMessage, post, setPersisted } from '../common/vscodeApi';
import { ChatInstance, ChatUi, type ChatUiData } from './instance';
import { ChatView } from './ChatView';
import './styles/base.css';
import './styles/messages.css';
import './styles/tools.css';
import './styles/composer.css';
import './styles/pending.css';
import './styles/syntax.css';

/** Read by the extension's panel serializer to restore the tab after a reload. */
interface PersistedSession {
  key: string;
  sessionId?: string;
  cwd: string;
  title: string;
  /** A fork that hasn't sent its first message. */
  forkFrom?: { sessionId: string; at: string; title: string };
}

/** The tab's webview state. `session` is top-level on purpose: the extension's serializer reads it. */
interface PersistedTab extends ChatUiData {
  v: 1;
  session?: PersistedSession;
}

const loaded = getPersisted<PersistedTab>();
const persisted: PersistedTab = loaded && loaded.v === 1 ? loaded : { v: 1 };
const chat = new ChatInstance(
  (m) => post<ChatToExtMessage>(m),
  new ChatUi(persisted, (data) => setPersisted<PersistedTab>({ ...data, v: 1, session: persisted.session })),
  'tab',
);

/** Records which session this tab shows; written right away (not debounced). */
function saveSession(s: PersistedSession): void {
  const cur = persisted.session;
  if (cur && cur.key === s.key && cur.sessionId === s.sessionId && cur.cwd === s.cwd && cur.title === s.title && cur.forkFrom?.at === s.forkFrom?.at) return;
  persisted.session = { key: s.key, sessionId: s.sessionId, cwd: s.cwd, title: s.title, forkFrom: s.forkFrom };
  chat.ui.flush();
}

// Listen before announcing readiness so the first `state` is never missed.
onMessage<ExtToChatMessage>((m) => {
  if (!m || typeof m !== 'object' || !('type' in m)) return;
  chat.store.apply(m);
  // Keep the session identity in the persisted webview state for the panel serializer.
  const touchesSession = m.type === 'state' || (m.type === 'patch' && ('sessionId' in m.patch || 'title' in m.patch || 'cwd' in m.patch || 'forkFrom' in m.patch));
  const s = chat.store.state;
  if (touchesSession && s) saveSession({ key: s.key, sessionId: s.sessionId, cwd: s.cwd, title: s.title, forkFrom: s.forkFrom ?? undefined });
});

render(<ChatView chat={chat} active />, document.getElementById('root')!);
chat.send({ type: 'ready' });
