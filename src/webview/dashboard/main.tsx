import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AttentionState, DashboardState, DashboardToExtMessage, ExtToDashboardMessage, LiveSessionView, RecentSessionView, UsageView, UsageWindowView } from '../../shared/protocol';
import { SESSION_SOURCE_LABELS } from '../../shared/protocol';
import { clockTime, countdown, setTimeLocale, shortAgo } from '../../util/time';
import { getPersisted, onMessage, post as rawPost, setPersisted } from '../common/vscodeApi';
import './dashboard.css';

const post = (m: DashboardToExtMessage) => rawPost(m);
setTimeLocale(document.documentElement.lang || undefined);

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const STATE_LABEL: Record<AttentionState, string> = {
  'needs-input': 'Needs you',
  error: 'Stopped',
  done: 'Finished',
  running: 'Running',
  idle: 'Idle',
};

const STATE_ICON: Record<AttentionState, string> = {
  'needs-input': 'codicon-bell-dot',
  error: 'codicon-error',
  done: 'codicon-pass-filled',
  running: 'codicon-loading codicon-modifier-spin',
  idle: 'codicon-circle-large-outline',
};

function App() {
  const [state, setState] = useState<DashboardState | undefined>();
  const now = useNow(15_000);

  useEffect(() => {
    const off = onMessage<ExtToDashboardMessage>((m) => {
      if (m.type === 'state') setState(m.state);
    });
    post({ type: 'ready' });
    return off;
  }, []);

  const groups = useMemo(() => {
    const s = state?.sessions ?? [];
    return {
      attention: s.filter((v) => v.attention === 'needs-input' || v.attention === 'error' || v.attention === 'done'),
      running: s.filter((v) => v.attention === 'running'),
      // Every chat tab open in this window; idle ones are listed only here.
      open: s.filter((v) => v.tabOpen),
      idle: s.filter((v) => v.attention === 'idle' && !v.tabOpen),
    };
  }, [state]);

  if (!state) return <div class="loading">Loading…</div>;

  const needs = groups.attention.filter((v) => v.attention === 'needs-input').length;
  const summary = [
    needs ? `${needs} waiting for you` : undefined,
    groups.attention.length - needs ? `${groups.attention.length - needs} finished` : undefined,
    groups.running.length ? `${groups.running.length} running` : undefined,
    groups.open.length ? `${groups.open.length} open here` : undefined,
    groups.idle.length ? `${groups.idle.length} idle` : undefined,
  ].filter(Boolean);

  return (
    <div class="dash">
      <header class="top">
        <div>
          <h1>Claude sessions</h1>
          <p class="sub">{summary.length ? summary.join(' · ') : 'Nothing running right now'}</p>
        </div>
        <div class="top-actions">
          <button class="btn primary" onClick={() => post({ type: 'new-session' })} title="Start a new session in one of your projects">
            <i class="codicon codicon-add" /> New session
          </button>
        </div>
      </header>

      <Usage usage={state.usage} now={now} />

      {state.sessions.length === 0 ? (
        <div class="empty">
          <i class="codicon codicon-comment-discussion" />
          <p>No Claude sessions are running.</p>
          <p class="muted">Sessions you start here, in a terminal, in other VS Code windows or in the Claude app show up on this page. The ones waiting for you come first.</p>
          <div class="empty-actions">
            {state.projectCount === 0 ? (
              <button class="btn primary" onClick={() => post({ type: 'add-project' })}>
                <i class="codicon codicon-add" /> Add a project
              </button>
            ) : (
              <button class="btn primary" onClick={() => post({ type: 'new-session' })}>
                <i class="codicon codicon-add" /> New session
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <Section title="Needs you" items={groups.attention} now={now} accent="attention" />
          <Section title="Running" items={groups.running} now={now} accent="running" />
          <Section title="Open in this window" items={groups.open} now={now} accent="open" collapsible canClose closeAllTitle="Close all tabs in this window" />
          <Section title="Idle" items={groups.idle} now={now} accent="idle" collapsible canClose closeAllTitle="Close all idle sessions" />
        </>
      )}
      <RecentSection items={state.recent ?? []} now={now} />
    </div>
  );
}

function Usage({ usage, now }: { usage?: UsageView; now: number }) {
  const rows: { label: string; w: UsageWindowView }[] = [];
  if (usage?.fiveHour) rows.push({ label: '5-hour', w: usage.fiveHour });
  if (usage?.sevenDay) rows.push({ label: 'Weekly', w: usage.sevenDay });
  for (const o of usage?.others ?? []) rows.push({ label: `Weekly · ${o.label}`, w: o.window });
  return (
    <section class="usage" aria-label="Plan usage">
      <div class="usage-head">
        <h2>Plan usage{usage?.subscription ? <span class="chip">{usage.subscription}</span> : null}</h2>
        <button class="icon-btn" title="Refresh usage" onClick={() => post({ type: 'refresh-usage' })}>
          <i class="codicon codicon-refresh" />
        </button>
      </div>
      {rows.length === 0 ? (
        <p class="muted small">{usage?.error ? `Couldn't read usage: ${usage.error}` : 'Loading usage…'}</p>
      ) : (
        <div class="usage-rows">
          {rows.map(({ label, w }) => {
            const pct = w.percent ?? 0;
            const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
            const level = pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : 'ok';
            return (
              <div class="usage-row" key={label}>
                <span class="u-label">{label}</span>
                <span class={`meter ${level}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} usage`}>
                  <span style={{ width: `${Math.min(100, pct)}%` }} />
                </span>
                <span class="u-pct">{w.percent === null ? '—' : `${w.percent}%`}</span>
                <span class="u-reset">{Number.isNaN(reset) ? '' : `resets in ${countdown(reset, now)} · ${clockTime(reset, now)}`}</span>
              </div>
            );
          })}
        </div>
      )}
      {usage?.fetchedAt ? <p class="muted small updated">Updated {shortAgo(usage.fetchedAt, now) === 'now' ? 'just now' : `${shortAgo(usage.fetchedAt, now)} ago`}{usage.error ? ' · last refresh failed' : ''}</p> : null}
    </section>
  );
}

interface Persisted {
  collapsed?: Record<string, boolean>;
}

function useCollapsed(accent: string, initial: boolean): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => getPersisted<Persisted>()?.collapsed?.[accent] ?? initial);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    const prev = getPersisted<Persisted>() ?? {};
    setPersisted<Persisted>({ ...prev, collapsed: { ...(prev.collapsed ?? {}), [accent]: next } });
  };
  return [collapsed, toggle];
}

/** Sessions worked on lately that aren't running anywhere. */
function RecentSection({ items, now }: { items: RecentSessionView[]; now: number }) {
  const [collapsed, toggle] = useCollapsed('recent', false);
  if (!items.length) return null;
  return (
    <section class="group recent">
      <h2>
        <button class="section-toggle" aria-expanded={!collapsed} onClick={toggle}>
          <i class={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
          Recent <span class="count">{items.length}</span>
        </button>
      </h2>
      {collapsed ? null : (
        <ul class="cards">
          {items.map((r) => (
            <RecentCard key={r.sessionId} r={r} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentCard({ r, now }: { r: RecentSessionView; now: number }) {
  const open = () => post({ type: 'open-recent', sessionId: r.sessionId, cwd: r.cwd });
  return (
    <li
      class="card s-recent"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      aria-label={`${r.projectName}: ${r.title}, last active ${shortAgo(r.lastActive, now)} ago`}
    >
      <i class="state codicon codicon-history" title="Not running" />
      <div class="body">
        <div class="meta">
          <span class="project">{r.projectName}</span>
          {r.branch ? (
            <span class="chip branch" title="Branch">
              <i class="codicon codicon-git-branch" />
              {r.branch}
            </span>
          ) : null}
          <span class="since" title={new Date(r.lastActive).toLocaleString()}>
            {shortAgo(r.lastActive, now)}
          </span>
        </div>
        <div class="title">{r.title}</div>
        {r.lastPrompt ? <div class="detail">{r.lastPrompt}</div> : null}
      </div>
      <div class="actions" onClick={(e) => e.stopPropagation()}>
        <button class="icon-btn" title="Open in the Claude extension" onClick={() => post({ type: 'open-recent', sessionId: r.sessionId, cwd: r.cwd, inClaudeExtension: true })}>
          <i class="codicon codicon-link-external" />
        </button>
        <button class="btn" onClick={open}>
          Resume
        </button>
      </div>
    </li>
  );
}

interface SectionProps {
  title: string;
  items: LiveSessionView[];
  now: number;
  accent: string;
  collapsible?: boolean;
  /** Cards get a close button, and the header a "Close all" button. */
  canClose?: boolean;
  closeAllTitle?: string;
}

function Section({ title, items, now, accent, collapsible, canClose, closeAllTitle }: SectionProps) {
  // Long idle lists start collapsed; the user's choice is remembered.
  const [collapsed, toggle] = useCollapsed(accent, !!collapsible && items.length > 4);
  if (!items.length) return null;
  const closable = canClose ? items.filter((v) => v.closable) : [];
  return (
    <section class={`group ${accent}`}>
      <h2>
        {collapsible ? (
          <button class="section-toggle" aria-expanded={!collapsed} onClick={toggle}>
            <i class={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
            {title} <span class="count">{items.length}</span>
          </button>
        ) : (
          <>
            {title} <span class="count">{items.length}</span>
          </>
        )}
        {closable.length > 1 ? (
          <button class="link-btn" title={closeAllTitle} onClick={() => post({ type: 'close', keys: closable.map((v) => v.key) })}>
            Close all
          </button>
        ) : null}
      </h2>
      {collapsed && collapsible ? null : (
        <ul class="cards">
          {items.map((v) => (
            <Card key={v.key} v={v} now={now} canClose={canClose} />
          ))}
        </ul>
      )}
    </section>
  );
}

function closeTitle(v: LiveSessionView): string {
  if (!v.managed) return 'End this terminal session';
  const busy = v.attention === 'running' || v.attention === 'needs-input';
  if (v.tabOpen) return busy ? 'Close tab (Claude keeps working in the background)' : 'Close tab';
  return 'Close (stops its Claude process; resume it any time)';
}

function Card({ v, now, canClose }: { v: LiveSessionView; now: number; canClose?: boolean }) {
  const open = () => post({ type: 'open', key: v.key });
  const stop = (e: Event) => e.stopPropagation();
  const line = v.waitingFor ? (v.detail ? `${v.waitingFor} — ${v.detail}` : v.waitingFor) : v.activity ?? v.detail;
  return (
    <li
      class={`card s-${v.attention}`}
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      aria-label={`${v.projectName}: ${v.title}, ${STATE_LABEL[v.attention]}`}
    >
      <i class={`state codicon ${STATE_ICON[v.attention]}`} title={STATE_LABEL[v.attention]} />
      <div class="body">
        <div class="meta">
          <span class="project">{v.projectName}</span>
          {v.branch ? (
            <span class="chip branch" title="Branch">
              <i class="codicon codicon-git-branch" />
              {v.branch}
            </span>
          ) : null}
          <span class={`chip src src-${v.source}`} title="Where this session runs">
            {SESSION_SOURCE_LABELS[v.source]}
          </span>
          <span class="since" title={new Date(v.since).toLocaleString()}>
            {shortAgo(v.since, now)}
          </span>
        </div>
        <div class="title">{v.title}</div>
        {line ? <div class={`detail ${v.attention === 'needs-input' ? 'strong' : ''}`}>{line}</div> : null}
      </div>
      <div class="actions" onClick={stop}>
        {v.quickPermission ? (
          <>
            <button class="btn primary" title="Allow once" onClick={() => post({ type: 'allow', key: v.key, requestId: v.quickPermission!.requestId, optionId: v.quickPermission!.allowOptionId })}>
              Allow
            </button>
            <button class="btn" title="Deny" onClick={() => post({ type: 'deny', key: v.key, requestId: v.quickPermission!.requestId })}>
              Deny
            </button>
          </>
        ) : null}
        {v.attention === 'done' ? (
          <button class="icon-btn" title="Mark as seen" onClick={() => post({ type: 'dismiss', key: v.key })}>
            <i class="codicon codicon-check" />
          </button>
        ) : null}
        {v.managed && v.attention === 'running' ? (
          <button class="icon-btn" title="Stop (interrupt)" onClick={() => post({ type: 'stop', key: v.key })}>
            <i class="codicon codicon-debug-stop" />
          </button>
        ) : null}
        {!v.managed && v.source === 'vscode' && v.sessionId ? (
          <button class="icon-btn" title="Show in its VS Code window" onClick={() => post({ type: 'open-in-claude-extension', key: v.key })}>
            <i class="codicon codicon-link-external" />
          </button>
        ) : null}
        <button class={`btn ${v.quickPermission ? '' : v.attention === 'needs-input' ? 'primary' : ''}`} onClick={open}>
          Open
        </button>
        {canClose && v.closable ? (
          <button class="icon-btn" title={closeTitle(v)} aria-label={closeTitle(v)} onClick={() => post({ type: 'close', keys: [v.key] })}>
            <i class="codicon codicon-close" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

render(<App />, document.getElementById('root')!);
