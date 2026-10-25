import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ElicitationField, ElicitationRequestView, PendingRequestView, PermissionRequestView, PlanRequestView, QuestionRequestView } from '../../../shared/protocol';
import { validateElicitation, type ElicitationValue } from '../../../sessions/elicitation';
import { diffForTool } from '../lib/diff';
import { highlight } from '../lib/markdown';
import { displayPath } from '../lib/paths';
import { permissionTitle } from '../lib/tools';
import { openDiff, openFile, openUrl, send } from './actions';
import { DiffStats, DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { Clipped, Icon } from './ui';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Shows the oldest pending request; the rest wait behind it. */
export function PendingArea({ pending, cwd }: { pending: PendingRequestView[]; cwd: string }) {
  const sorted = useMemo(() => [...pending].sort((a, b) => a.createdAt - b.createdAt), [pending]);
  const req = sorted[0];
  if (!req) return null;
  const more = sorted.length - 1;
  let card: ComponentChildren;
  if (req.kind === 'permission') card = <PermissionCard key={req.requestId} req={req} cwd={cwd} />;
  else if (req.kind === 'question') card = <QuestionCard key={req.requestId} req={req} />;
  else if (req.kind === 'elicitation') card = <ElicitationCard key={req.requestId} req={req} />;
  else card = <PlanCard key={req.requestId} req={req} />;
  return (
    <div class="pending-area">
      {more > 0 ? <div class="pending-more">+{more} more request{more === 1 ? '' : 's'} waiting</div> : null}
      {card}
    </div>
  );
}

interface ChoiceButton {
  id: string;
  label: ComponentChildren;
}

/**
 * Vertical list of numbered choices plus a "tell Claude what to do instead" input,
 * with keyboard shortcuts (1–9, ↑/↓, Enter, Esc), like the official extension.
 */
function Choices({
  choices,
  initialFocus = 0,
  onChoose,
  feedbackPlaceholder,
  onFeedback,
  onEscape,
}: {
  choices: ChoiceButton[];
  initialFocus?: number;
  onChoose: (id: string) => void;
  feedbackPlaceholder?: string;
  onFeedback?: (text: string) => void;
  onEscape: () => void;
}) {
  const total = choices.length + (onFeedback ? 1 : 0);
  const [focus, setFocus] = useState(Math.min(initialFocus, total - 1));
  const [feedback, setFeedback] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Take focus when the card appears so the shortcuts work right away.
    const t = setTimeout(() => (focus < choices.length ? buttons.current[focus]?.focus() : input.current?.focus()), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (to: number) => {
    const next = (to + total) % total;
    setFocus(next);
    if (next < choices.length) buttons.current[next]?.focus();
    else input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const inInput = e.target === input.current;
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(focus + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(focus - 1);
      return;
    }
    if (inInput) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (feedback.trim() && onFeedback) onFeedback(feedback.trim());
      }
      return;
    }
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const i = Number(e.key) - 1;
      if (i < choices.length) {
        e.preventDefault();
        onChoose(choices[i].id);
      } else if (i === choices.length && onFeedback) {
        e.preventDefault();
        move(i);
      }
    }
  };

  return (
    <div class="choices" ref={root} onKeyDown={onKeyDown as unknown as (e: Event) => void}>
      {choices.map((c, i) => (
        <button
          key={c.id}
          type="button"
          ref={(el) => {
            buttons.current[i] = el;
          }}
          class={`choice${focus === i ? ' is-focused' : ''}`}
          onFocus={() => setFocus(i)}
          onMouseEnter={() => setFocus(i)}
          onClick={() => onChoose(c.id)}
        >
          <span class="choice-num">{i + 1}</span>
          <span class="choice-label">{c.label}</span>
        </button>
      ))}
      {onFeedback ? (
        <div class={`choice choice-input${focus === choices.length ? ' is-focused' : ''}`} onClick={() => input.current?.focus()}>
          <span class="choice-num">{choices.length + 1}</span>
          <input
            ref={input}
            type="text"
            class="feedback-input"
            placeholder={feedbackPlaceholder ?? 'Tell Claude what to do instead'}
            value={feedback}
            onFocus={() => setFocus(choices.length)}
            onInput={(e) => setFeedback((e.currentTarget as HTMLInputElement).value)}
          />
          {feedback.trim() ? (
            <button type="button" class="feedback-send" title="Send" aria-label="Send" onClick={(e) => { e.stopPropagation(); onFeedback(feedback.trim()); }}>
              <Icon name="arrow-up" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div class="choices-hint">
        <kbd>1</kbd>–<kbd>{Math.min(9, total)}</kbd> to choose · <kbd>Esc</kbd> to cancel
      </div>
    </div>
  );
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function PermissionDetails({ req, cwd }: { req: PermissionRequestView; cwd: string }) {
  const input = req.input ?? {};
  const [showJson, setShowJson] = useState(false);
  const file = str(input.file_path) ?? str(input.notebook_path);
  const diff = useMemo(
    () => (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(req.toolName) ? diffForTool({ name: req.toolName, input, structured: undefined }) : undefined),
    [req.toolName, input],
  );

  if (req.toolName === 'Bash') {
    const cmd = str(input.command) ?? '';
    const html = highlight(cmd, 'bash');
    return (
      <div class="perm-body">
        {req.description || str(input.description) ? <div class="perm-desc">{req.description || str(input.description)}</div> : null}
        <Clipped maxHeight={160} watch={cmd.length}>
          <pre class="perm-code" dangerouslySetInnerHTML={{ __html: html }} />
        </Clipped>
      </div>
    );
  }

  if (diff) {
    return (
      <div class="perm-body">
        {file ? (
          <div class="perm-file">
            <span class="link mono" onClick={() => openFile(file)} title={file}>
              {displayPath(file, cwd)}
            </span>
            <DiffStats added={diff.added} removed={diff.removed} />
            {req.toolUseId ? (
              <button type="button" class="link-btn" onClick={() => openDiff(req.toolUseId!)}>
                <Icon name="diff" /> Open diff
              </button>
            ) : null}
          </div>
        ) : null}
        <div class="diff-box">
          <DiffView diff={diff} collapsedLines={12} />
        </div>
      </div>
    );
  }

  const url = str(input.url);
  const rows: ComponentChildren[] = [];
  if (file) rows.push(<span key="f" class="link mono" onClick={() => openFile(file)}>{displayPath(file, cwd)}</span>);
  if (url) rows.push(<span key="u" class="link mono" onClick={() => openUrl(url)}>{url}</span>);
  for (const k of ['pattern', 'path', 'query', 'prompt', 'description', 'skill', 'command']) {
    const v = str(input[k]);
    if (v && !(k === 'path' && v === file)) rows.push(<div key={k}><span class="kv-key">{k}</span> <span class="mono">{v}</span></div>);
  }
  const hasJson = Object.keys(input).length > 0;
  return (
    <div class="perm-body">
      {req.description ? <div class="perm-desc">{req.description}</div> : null}
      {rows.length ? <div class="kv">{rows}</div> : null}
      {hasJson ? (
        <div class="perm-json">
          <button type="button" class="link-btn" onClick={() => setShowJson(!showJson)}>
            <Icon name={showJson ? 'chevron-down' : 'chevron-right'} /> Details
          </button>
          {showJson ? <pre class="perm-code">{JSON.stringify(input, null, 2)}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function PermissionCard({ req, cwd }: { req: PermissionRequestView; cwd: string }) {
  const title = req.title?.trim() || permissionTitle(req.toolName, req.input ?? {}, req.displayName, cwd);
  const choices: ChoiceButton[] = [
    ...req.options.map((o) => ({ id: o.id, label: o.label })),
    { id: 'deny', label: 'No' },
  ];
  const respond = (optionId: string, feedback?: string) => send({ type: 'permission-response', requestId: req.requestId, optionId, feedback });
  const blocked = req.blockedPath && req.blockedPath !== str(req.input?.file_path) ? req.blockedPath : undefined;
  return (
    <div class="pending-card perm-card" role="dialog" aria-label={title}>
      <div class="pending-title">{title}</div>
      <PermissionDetails req={req} cwd={cwd} />
      {req.decisionReason ? (
        <div class="perm-reason">
          <Icon name="info" /> {req.decisionReason.replace(ANSI, '')}
        </div>
      ) : null}
      {blocked ? (
        <div class="perm-reason">
          <Icon name="folder" /> Outside the project: <span class="mono">{displayPath(blocked, cwd)}</span>
        </div>
      ) : null}
      <Choices
        choices={choices}
        initialFocus={req.defaultToNo ? choices.length - 1 : 0}
        onChoose={(id) => respond(id)}
        onFeedback={(text) => respond('deny', text)}
        onEscape={() => respond('deny')}
      />
    </div>
  );
}

const OTHER = '__other__';

function QuestionCard({ req }: { req: QuestionRequestView }) {
  const qs = req.questions;
  const [selected, setSelected] = useState<string[][]>(() => qs.map(() => []));
  const [other, setOther] = useState<string[]>(() => qs.map(() => ''));
  const [hover, setHover] = useState<{ q: number; label: string } | undefined>();
  const single = qs.length === 1 && !qs[0].multiSelect;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => root.current?.querySelector<HTMLButtonElement>('.q-option')?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const answerFor = (i: number): string => {
    const q = qs[i];
    const picks = selected[i].filter((s) => s !== OTHER);
    const o = other[i].trim();
    const withOther = selected[i].includes(OTHER) && o ? [...picks, o] : picks;
    return q.multiSelect ? withOther.join(', ') : withOther[0] ?? '';
  };
  const complete = qs.every((_, i) => answerFor(i).length > 0);

  const submit = (override?: string[][]) => {
    const sel = override ?? selected;
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => {
      const picks = sel[i].filter((s) => s !== OTHER);
      const o = other[i].trim();
      const all = sel[i].includes(OTHER) && o ? [...picks, o] : picks;
      answers[q.question] = q.multiSelect ? all.join(', ') : all[0] ?? '';
    });
    send({ type: 'question-response', requestId: req.requestId, answers });
  };
  const cancel = () => send({ type: 'question-response', requestId: req.requestId, answers: {}, cancelled: true });

  const pick = (qi: number, label: string) => {
    const q = qs[qi];
    setSelected((cur) => {
      const next = cur.map((a) => a.slice());
      if (q.multiSelect) {
        next[qi] = next[qi].includes(label) ? next[qi].filter((x) => x !== label) : [...next[qi], label];
      } else {
        next[qi] = [label];
      }
      if (single && label !== OTHER) setTimeout(() => submit(next), 0);
      return next;
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    const inText = (e.target as HTMLElement).tagName === 'INPUT';
    if (!inText && single && /^[1-9]$/.test(e.key)) {
      const opts = qs[0].options;
      const i = Number(e.key) - 1;
      if (i < opts.length) {
        e.preventDefault();
        pick(0, opts[i].label);
      } else if (i === opts.length) {
        e.preventDefault();
        pick(0, OTHER);
        setTimeout(() => root.current?.querySelector<HTMLInputElement>('.q-other-input')?.focus(), 0);
      }
    }
    if (inText && e.key === 'Enter' && !e.isComposing && complete) {
      e.preventDefault();
      submit();
    }
  };

  const preview = hover ? qs[hover.q]?.options.find((o) => o.label === hover.label)?.preview : undefined;

  return (
    <div class="pending-card question-card" role="dialog" aria-label="Claude has a question" ref={root} onKeyDown={onKeyDown as unknown as (e: Event) => void}>
      <div class="pending-title">
        <Icon name="question" /> {qs.length > 1 ? 'Claude has a few questions' : 'Claude has a question'}
      </div>
      {qs.map((q, qi) => (
        <div class="question" key={qi}>
          <div class="question-text">
            {q.header ? <span class="chip">{q.header}</span> : null}
            {q.question}
            {q.multiSelect ? <span class="muted small"> (choose any)</span> : null}
          </div>
          <div class="q-options">
            {q.options.map((o, oi) => {
              const on = selected[qi].includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  class={`q-option${on ? ' is-selected' : ''}`}
                  onClick={() => pick(qi, o.label)}
                  onMouseEnter={() => setHover({ q: qi, label: o.label })}
                  onFocus={() => setHover({ q: qi, label: o.label })}
                >
                  {q.multiSelect ? <Icon name={on ? 'pass-filled' : 'circle-large-outline'} class="q-check" /> : <span class="choice-num">{oi + 1}</span>}
                  <span class="q-option-text">
                    <span class="q-option-label">{o.label}</span>
                    {o.description ? <span class="q-option-desc">{o.description}</span> : null}
                  </span>
                </button>
              );
            })}
            <div class={`q-option q-other${selected[qi].includes(OTHER) ? ' is-selected' : ''}`}>
              {q.multiSelect ? (
                <Icon name={selected[qi].includes(OTHER) ? 'pass-filled' : 'circle-large-outline'} class="q-check" />
              ) : (
                <span class="choice-num">{q.options.length + 1}</span>
              )}
              <input
                type="text"
                class="q-other-input"
                placeholder="Other…"
                value={other[qi]}
                onFocus={() => {
                  if (!selected[qi].includes(OTHER)) pick(qi, OTHER);
                }}
                onInput={(e) => {
                  const v = (e.currentTarget as HTMLInputElement).value;
                  setOther((cur) => cur.map((x, i) => (i === qi ? v : x)));
                }}
              />
            </div>
          </div>
        </div>
      ))}
      {preview ? (
        <div class="q-preview">
          <pre>{preview}</pre>
        </div>
      ) : null}
      <div class="pending-actions">
        <button type="button" class="btn btn-secondary" onClick={cancel}>
          Cancel
        </button>
        {!single || selected[0].includes(OTHER) ? (
          <button type="button" class="btn btn-primary" disabled={!complete} onClick={() => submit()}>
            Submit
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PlanCard({ req }: { req: PlanRequestView }) {
  const respond = (decision: 'accept-auto' | 'accept-manual' | 'reject', feedback?: string) =>
    send({ type: 'plan-response', requestId: req.requestId, decision, feedback });
  return (
    <div class="pending-card plan-card" role="dialog" aria-label="Ready to code?">
      <div class="pending-title">
        <Icon name="checklist" /> Ready to code?
      </div>
      <div class="pending-sub">Here is Claude's plan:</div>
      <div class="plan-box plan-scroll">
        <Markdown text={req.plan || '_No plan text._'} />
      </div>
      {req.planFilePath ? (
        <div class="perm-reason">
          <span class="link" onClick={() => openFile(req.planFilePath!)}>
            <Icon name="go-to-file" /> Open plan file
          </span>
        </div>
      ) : null}
      <Choices
        choices={[
          { id: 'accept-auto', label: 'Yes, and auto-accept edits' },
          { id: 'accept-manual', label: 'Yes, and manually approve edits' },
          { id: 'reject', label: 'No, keep planning' },
        ]}
        onChoose={(id) => respond(id as 'accept-auto' | 'accept-manual' | 'reject')}
        feedbackPlaceholder="Tell Claude what to change"
        onFeedback={(text) => respond('reject', text)}
        onEscape={() => respond('reject')}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP elicitation (a server asks the user for input)
// ---------------------------------------------------------------------------

function initialValues(fields: ElicitationField[]): Record<string, ElicitationValue | undefined> {
  const v: Record<string, ElicitationValue | undefined> = {};
  for (const f of fields) v[f.name] = f.default ?? (f.type === 'multi' ? [] : f.type === 'boolean' ? false : undefined);
  return v;
}

function inputType(f: ElicitationField): "number" | "email" | "url" | "date" | "datetime-local" | "text" {
  if (f.type === 'number' || f.type === 'integer') return 'number';
  switch (f.format) {
    case 'email':
      return 'email';
    case 'uri':
      return 'url';
    case 'date':
      return 'date';
    case 'date-time':
      return 'datetime-local';
    default:
      return 'text';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function FieldInput({ f, value, error, onChange, autoFocus }: { f: ElicitationField; value: ElicitationValue | undefined; error?: string; onChange: (v: ElicitationValue | undefined) => void; autoFocus?: boolean }) {
  const id = `elicit-${f.name}`;
  const label = (
    <label class="elicit-label" for={id}>
      {f.label}
      {f.required && f.type !== 'boolean' ? <span class="elicit-req" aria-label="required"> *</span> : null}
    </label>
  );
  let control;
  if (f.type === 'boolean') {
    control = (
      <label class="elicit-check">
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
        <span>{f.label}</span>
      </label>
    );
  } else if (f.type === 'enum' && (f.options?.length ?? 0) <= 6) {
    control = (
      <div class="elicit-options" role="radiogroup" aria-labelledby={id}>
        {f.options!.map((o) => (
          <button type="button" key={o.value} role="radio" aria-checked={value === o.value} class={`elicit-option${value === o.value ? ' is-on' : ''}`} onClick={() => onChange(o.value)}>
            <Icon name={value === o.value ? 'pass-filled' : 'circle-large-outline'} />
            {o.label}
          </button>
        ))}
      </div>
    );
  } else if (f.type === 'enum') {
    control = (
      <select id={id} class="elicit-input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value || undefined)}>
        <option value="">Choose…</option>
        {f.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (f.type === 'multi') {
    const arr = Array.isArray(value) ? value : [];
    control = (
      <div class="elicit-options" role="group">
        {(f.options ?? []).map((o) => {
          const on = arr.includes(o.value);
          return (
            <button type="button" key={o.value} role="checkbox" aria-checked={on} class={`elicit-option${on ? ' is-on' : ''}`} onClick={() => onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])}>
              <Icon name={on ? 'pass-filled' : 'circle-large-outline'} />
              {o.label}
            </button>
          );
        })}
      </div>
    );
  } else {
    control = (
      <input
        id={id}
        class="elicit-input"
        {...({ type: inputType(f) } as Record<string, string>)}
        value={value === undefined ? '' : String(value)}
        min={f.minimum}
        max={f.maximum}
        step={f.type === 'integer' ? 1 : f.type === 'number' ? 'any' : undefined}
        minLength={f.minLength}
        maxLength={f.maxLength}
        autoFocus={autoFocus}
        onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)}
      />
    );
  }
  return (
    <div class={`elicit-field${error ? ' has-error' : ''}`}>
      {f.type === 'boolean' ? null : label}
      {control}
      {f.description ? <div class="elicit-desc">{f.description}</div> : null}
      {error ? <div class="elicit-error">{error}</div> : null}
    </div>
  );
}

function ElicitationCard({ req }: { req: ElicitationRequestView }) {
  const [values, setValues] = useState(() => initialValues(req.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const name = req.title ?? req.serverName;

  const respond = (action: 'accept' | 'decline' | 'cancel', content?: Record<string, ElicitationValue>) =>
    send({ type: 'elicitation-response', requestId: req.requestId, action, content });

  const submit = () => {
    const errs = validateElicitation(req.fields, values);
    setErrors(errs);
    setTried(true);
    if (Object.keys(errs).length) return;
    const content: Record<string, ElicitationValue> = {};
    for (const [k, v] of Object.entries(values)) if (v !== undefined) content[k] = v;
    respond('accept', content);
  };

  const set = (k: string, v: ElicitationValue | undefined) => {
    const next = { ...values, [k]: v };
    setValues(next);
    if (tried) setErrors(validateElicitation(req.fields, next));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      respond('cancel');
    } else if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName === 'INPUT' && req.mode === 'form') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div class="pending-card elicit-card" role="dialog" aria-label={`${name} needs your input`} onKeyDown={onKeyDown as unknown as (e: Event) => void}>
      <div class="pending-title">
        <Icon name="plug" /> {name} needs your input
      </div>
      {req.title && req.title !== req.serverName ? <div class="pending-sub">MCP server: {req.serverName}</div> : null}
      {req.message ? <div class="elicit-message">{req.message}</div> : null}
      {req.mode === 'url' ? (
        <>
          {req.url ? (
            <div class="elicit-url">
              <Icon name="link-external" />
              <span class="elicit-host">{hostOf(req.url)}</span>
              <span class="elicit-full mono" title={req.url}>
                {req.url}
              </span>
            </div>
          ) : null}
          <div class="pending-actions">
            <button type="button" class="btn btn-secondary" onClick={() => respond('cancel')}>
              Cancel
            </button>
            <button type="button" class="btn btn-secondary" onClick={() => respond('decline')}>
              Decline
            </button>
            <button
              type="button"
              class="btn btn-primary"
              autoFocus
              onClick={() => {
                if (req.url) openUrl(req.url);
                respond('accept');
              }}
            >
              Open link
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="elicit-form">
            {req.fields.map((f, i) => (
              <FieldInput key={f.name} f={f} value={values[f.name]} error={errors[f.name]} onChange={(v) => set(f.name, v)} autoFocus={i === 0} />
            ))}
          </div>
          <div class="pending-actions">
            <button type="button" class="btn btn-secondary" onClick={() => respond('cancel')}>
              Cancel
            </button>
            <button type="button" class="btn btn-secondary" onClick={() => respond('decline')}>
              Decline
            </button>
            <button type="button" class="btn btn-primary" onClick={submit}>
              Submit
            </button>
          </div>
        </>
      )}
      <div class="choices-hint">
        <kbd>Esc</kbd> to cancel · the answer goes to the MCP server, not to Claude
      </div>
    </div>
  );
}
