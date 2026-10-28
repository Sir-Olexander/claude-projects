import type { ComponentChildren } from 'preact';
import { memo } from 'preact/compat';
import { useContext, useEffect, useMemo, useState } from 'preact/hooks';
import type { ChatItem, ImageAttachment, ToolItem, TodoItem } from '../../../shared/protocol';
import { diffForTool } from '../lib/diff';
import { formatElapsed } from '../lib/format';
import { attachmentSrc } from '../lib/images';
import { highlight } from '../lib/markdown';
import { displayPath, parsePathRef } from '../lib/paths';
import { defaultExpanded, field, parseMcpName, toolLabel } from '../lib/tools';
import { useExpanded } from '../ui';
import { openDiff, openFile, openUrl } from './actions';
import { ChatContext } from './context';
import { DiffStats, DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { Badge, Clipped, Icon } from './ui';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function statusClass(s: ToolItem['status']): string {
  switch (s) {
    case 'done':
      return 'st-done';
    case 'error':
      return 'st-error';
    case 'waiting-permission':
      return 'st-waiting';
    case 'denied':
    case 'interrupted':
      return 'st-muted';
    default:
      return 'st-running';
  }
}

/** Ticks every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export const ToolCall = memo(function ToolCall({ item, kids }: { item: ToolItem; kids?: ChatItem[] }) {
  const { cwd } = useContext(ChatContext);
  const label = useMemo(() => toolLabel(item, cwd), [item.name, item.input, item.partialInput, cwd]);
  const diff = useMemo(() => (FILE_TOOLS.has(item.name) && item.status !== 'streaming' ? diffForTool(item) : undefined), [item.name, item.input, item.structured, item.status]);
  const isAgent = item.name === 'Task' || item.name === 'Agent';
  const [open, toggle] = useExpanded(`tool:${item.id}`, defaultExpanded(item));
  const running = item.status === 'running' || item.status === 'pending';
  const now = useNow(running && (item.name === 'Bash' || isAgent));
  const hasBody = item.status !== 'streaming' || !!item.partialInput;
  const errorLine = item.status === 'error' && item.result?.text ? stripAnsi(item.result.text).split('\n').find((l) => l.trim()) : undefined;

  const onSummaryClick = label.filePath
    ? (e: MouseEvent) => {
        e.stopPropagation();
        openFile(label.filePath!, label.line);
      }
    : undefined;

  let lastChild: string | undefined;
  if (isAgent && kids?.length && running) {
    const tools = kids.filter((k): k is ToolItem => k.kind === 'tool');
    const last = tools[tools.length - 1];
    if (last) {
      const l = toolLabel(last, cwd);
      lastChild = l.summary ? `${l.name} ${l.summary}` : l.name;
    }
  }
  const toolCount = isAgent ? kids?.filter((k) => k.kind === 'tool').length ?? 0 : 0;

  return (
    <div class={`tl tool ${statusClass(item.status)}${open ? ' is-open' : ''}`} data-tool={item.name}>
      <div class={`tool-head${hasBody ? ' clickable' : ''}`} onClick={hasBody ? () => toggle() : undefined} role={hasBody ? 'button' : undefined} aria-expanded={hasBody ? open : undefined}>
        <span class="tool-name">{label.name}</span>
        {label.summary ? (
          <span class={`tool-summary${label.mono ? ' mono' : ''}${onSummaryClick ? ' link' : ''}`} onClick={onSummaryClick} title={label.filePath ?? label.summary}>
            {label.summary}
          </span>
        ) : item.status === 'streaming' ? (
          <span class="tool-summary muted">…</span>
        ) : null}
        {label.hint ? <span class="tool-hint">{label.hint}</span> : null}
        {diff ? <DiffStats added={diff.added} removed={diff.removed} /> : null}
        {toolCount > 0 ? <span class="tool-hint">{toolCount} tool use{toolCount === 1 ? '' : 's'}</span> : null}
        {running && item.startedAt && now - item.startedAt > 3000 ? <span class="tool-hint tabular">{formatElapsed(now - item.startedAt)}</span> : null}
        {item.status === 'waiting-permission' ? <Badge tone="warn">Waiting for approval</Badge> : null}
        {item.status === 'denied' ? <Badge>Denied</Badge> : null}
        {item.status === 'interrupted' ? <Badge>Interrupted</Badge> : null}
        {hasBody ? <Icon name="chevron-right" class="tool-chevron" /> : null}
      </div>
      {lastChild ? <div class="tool-subline">{lastChild}</div> : null}
      {errorLine && !open ? <div class="tool-error-line">{errorLine}</div> : null}
      {open && hasBody ? <div class="tool-body">{renderBody(item, cwd, diff, kids)}</div> : null}
    </div>
  );
});

function renderBody(item: ToolItem, cwd: string, diff: ReturnType<typeof diffForTool>, kids?: ChatItem[]): ComponentChildren {
  switch (item.name) {
    case 'Bash':
      return <BashBody item={item} />;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return <FileChangeBody item={item} diff={diff} />;
    case 'Read':
      return <GenericBody item={item} showInput={false} />;
    case 'Grep':
    case 'Glob':
    case 'LS':
      return <SearchBody item={item} cwd={cwd} />;
    case 'WebFetch':
    case 'WebSearch':
      return <WebBody item={item} />;
    case 'Task':
    case 'Agent':
      return <AgentBody item={item} kids={kids} />;
    case 'TodoWrite':
      return <TodoBody item={item} />;
    case 'AskUserQuestion':
      return <QuestionBody item={item} />;
    case 'ExitPlanMode':
      return <PlanBody item={item} />;
    case 'ToolSearch':
      return <ToolSearchBody item={item} />;
    default:
      return <GenericBody item={item} showInput />;
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function IOBox({ children }: { children: ComponentChildren }) {
  return <div class="io-box">{children}</div>;
}

function IORow({ label, children, tone }: { label: string; children: ComponentChildren; tone?: 'error' }) {
  return (
    <div class={`io-row${tone ? ' io-' + tone : ''}`}>
      <div class="io-label">{label}</div>
      <div class="io-content">{children}</div>
    </div>
  );
}

function Pre({ text, lang, clip = 180 }: { text: string; lang?: string; clip?: number }) {
  const html = useMemo(() => (lang ? highlight(text, lang) : undefined), [text, lang]);
  return (
    <Clipped maxHeight={clip} watch={text.length}>
      {html !== undefined ? <pre class="io-pre" dangerouslySetInnerHTML={{ __html: html }} /> : <pre class="io-pre">{text}</pre>}
    </Clipped>
  );
}

function Images({ images }: { images?: ImageAttachment[] }) {
  if (!images?.length) return null;
  return (
    <div class="result-images">
      {images.map((img, i) => (
        <img key={i} src={attachmentSrc(img)} alt={img.name ?? 'image'} class="result-image" />
      ))}
    </div>
  );
}

function ResultRow({ item, label = 'OUT', lang }: { item: ToolItem; label?: string; lang?: string }) {
  const r = item.result;
  if (!r) {
    if (item.status === 'running' || item.status === 'pending') {
      return (
        <IORow label={label}>
          <span class="muted running-text">
            <Icon name="loading" spin /> Running…
          </span>
        </IORow>
      );
    }
    return null;
  }
  const text = stripAnsi(r.text ?? '');
  return (
    <IORow label={r.isError ? 'ERROR' : label} tone={r.isError ? 'error' : undefined}>
      {text.trim() ? <Pre text={text} lang={r.isError ? undefined : lang} /> : <span class="muted">{r.images?.length ? '' : '(no output)'}</span>}
      <Images images={r.images} />
      {r.truncated ? <div class="muted small">Output truncated.</div> : null}
    </IORow>
  );
}

// ---------------------------------------------------------------------------
// Tool bodies
// ---------------------------------------------------------------------------

function BashBody({ item }: { item: ToolItem }) {
  const cmd = field(item, 'command') ?? '';
  const desc = typeof item.input?.description === 'string' ? item.input.description : undefined;
  return (
    <IOBox>
      {desc ? <div class="io-desc">{desc}</div> : null}
      <IORow label="IN">
        <Pre text={cmd} lang="bash" clip={120} />
      </IORow>
      <ResultRow item={item} />
    </IOBox>
  );
}

function FileChangeBody({ item, diff }: { item: ToolItem; diff: ReturnType<typeof diffForTool> }) {
  const failed = item.status === 'error' || item.status === 'denied';
  return (
    <div class="file-change">
      {diff && diff.lines.length > 0 ? (
        <div class={`diff-box${failed ? ' is-failed' : ''}`}>
          <DiffView diff={diff} collapsedLines={16} />
        </div>
      ) : (
        <div class="muted small">No changes to show.</div>
      )}
      <div class="file-change-actions">
        {item.status !== 'streaming' ? (
          <button type="button" class="link-btn" onClick={(e) => { e.stopPropagation(); openDiff(item.id); }}>
            <Icon name="diff" /> Open diff
          </button>
        ) : null}
        {diff?.filePath ? (
          <button type="button" class="link-btn" onClick={(e) => { e.stopPropagation(); openFile(diff.filePath!); }}>
            <Icon name="go-to-file" /> Open file
          </button>
        ) : null}
      </div>
      {item.result?.isError ? (
        <IOBox>
          <ResultRow item={item} />
        </IOBox>
      ) : null}
    </div>
  );
}

function LinkedLines({ text, cwd, max = 300 }: { text: string; cwd: string; max?: number }) {
  const lines = text.split('\n');
  const shown = lines.slice(0, max);
  return (
    <Clipped maxHeight={200} watch={text.length}>
      <pre class="io-pre">
        {shown.map((line, i) => {
          // An optional drive letter first, so C:\x\a.ts:12: is not cut at "C".
          const m = /^((?:[A-Za-z]:)?\S+?)(?::(\d+))?([:-].*)?$/.exec(line);
          const ref = m ? parsePathRef(m[2] ? `${m[1]}:${m[2]}` : m[1]) : undefined;
          if (ref && m) {
            const rest = line.slice(m[1].length + (m[2] ? m[2].length + 1 : 0));
            return (
              <div key={i}>
                <span class="link" onClick={() => openFile(ref.path, ref.line)}>
                  {displayPath(m[1], cwd)}
                  {m[2] ? `:${m[2]}` : ''}
                </span>
                {rest}
              </div>
            );
          }
          return <div key={i}>{line || ' '}</div>;
        })}
        {lines.length > max ? <div class="muted">… {lines.length - max} more lines</div> : null}
      </pre>
    </Clipped>
  );
}

function SearchBody({ item, cwd }: { item: ToolItem; cwd: string }) {
  const input = item.input ?? {};
  const rows: [string, string][] = [];
  for (const k of ['pattern', 'path', 'glob', 'type', 'output_mode']) {
    const v = input[k];
    if (typeof v === 'string' && v) rows.push([k, v]);
  }
  return (
    <IOBox>
      {rows.length ? (
        <IORow label="IN">
          <div class="kv">
            {rows.map(([k, v]) => (
              <div key={k}>
                <span class="kv-key">{k}</span> <span class="mono">{v}</span>
              </div>
            ))}
          </div>
        </IORow>
      ) : null}
      {item.result && !item.result.isError ? (
        <IORow label="OUT">{item.result.text.trim() ? <LinkedLines text={stripAnsi(item.result.text)} cwd={cwd} /> : <span class="muted">No matches</span>}</IORow>
      ) : (
        <ResultRow item={item} />
      )}
    </IOBox>
  );
}

function WebBody({ item }: { item: ToolItem }) {
  const url = field(item, 'url');
  const prompt = field(item, 'prompt');
  const query = field(item, 'query');
  return (
    <IOBox>
      <IORow label="IN">
        <div class="kv">
          {url ? (
            <div>
              <span class="link mono" onClick={() => openUrl(url)}>
                {url}
              </span>
            </div>
          ) : null}
          {query ? <div class="mono">{query}</div> : null}
          {prompt ? <div class="muted">{prompt}</div> : null}
        </div>
      </IORow>
      {item.result && !item.result.isError ? (
        <IORow label="OUT">
          <Clipped maxHeight={220} watch={item.result.text.length}>
            <Markdown text={item.result.text} />
          </Clipped>
        </IORow>
      ) : (
        <ResultRow item={item} />
      )}
    </IOBox>
  );
}

function AgentBody({ item, kids }: { item: ToolItem; kids?: ChatItem[] }) {
  const { renderItems } = useContext(ChatContext);
  const prompt = field(item, 'prompt');
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <div class="agent-body">
      {prompt ? (
        <div class="agent-prompt">
          <button type="button" class="link-btn" onClick={(e) => { e.stopPropagation(); setShowPrompt(!showPrompt); }}>
            <Icon name={showPrompt ? 'chevron-down' : 'chevron-right'} /> Prompt
          </button>
          {showPrompt ? (
            <div class="agent-prompt-text">
              <Markdown text={prompt} />
            </div>
          ) : null}
        </div>
      ) : null}
      {kids?.length ? <div class="subagent">{renderItems(kids, true)}</div> : null}
      {item.result ? (
        item.result.isError ? (
          <IOBox>
            <ResultRow item={item} />
          </IOBox>
        ) : (
          <div class="agent-result">
            <Clipped maxHeight={260} watch={item.result.text.length}>
              <Markdown text={item.result.text} />
            </Clipped>
          </div>
        )
      ) : null}
    </div>
  );
}

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul class="todo-list">
      {todos.map((t, i) => (
        <li key={i} class={`todo todo-${t.status}`}>
          <Icon name={t.status === 'completed' ? 'pass-filled' : t.status === 'in_progress' ? 'circle-filled' : 'circle-large-outline'} class="todo-icon" />
          <span class="todo-text">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function TodoBody({ item }: { item: ToolItem }) {
  const todos = Array.isArray(item.input?.todos) ? (item.input.todos as TodoItem[]) : [];
  if (!todos.length) return <ResultRow item={item} />;
  return <TodoList todos={todos} />;
}

function answersOf(item: ToolItem): Record<string, string> {
  const s = item.structured as { answers?: Record<string, string> } | undefined;
  if (s?.answers && typeof s.answers === 'object') return s.answers;
  const inp = item.input?.answers;
  if (inp && typeof inp === 'object') return inp as Record<string, string>;
  const out: Record<string, string> = {};
  const text = item.result?.text ?? '';
  for (const m of text.matchAll(/"([^"]+)"="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function QuestionBody({ item }: { item: ToolItem }) {
  const questions = Array.isArray(item.input?.questions) ? (item.input.questions as { question: string; header?: string }[]) : [];
  const answers = answersOf(item);
  return (
    <div class="qa-list">
      {questions.map((q, i) => (
        <div key={i} class="qa">
          <div class="qa-q">
            {q.header ? <span class="chip">{q.header}</span> : null}
            {q.question}
          </div>
          <div class="qa-a">
            {answers[q.question] ? (
              <>
                <Icon name="arrow-right" /> {answers[q.question]}
              </>
            ) : item.status === 'denied' || item.status === 'error' ? (
              <span class="muted">Not answered</span>
            ) : (
              <span class="muted">Waiting for your answer…</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanBody({ item }: { item: ToolItem }) {
  const plan = field(item, 'plan') ?? (item.structured as { plan?: string } | undefined)?.plan ?? '';
  const filePath = field(item, 'planFilePath');
  return (
    <div class="plan-body">
      <div class="plan-box">
        <Clipped maxHeight={320} watch={plan.length}>
          <Markdown text={plan || '_No plan text._'} />
        </Clipped>
      </div>
      <div class="plan-footer">
        {item.status === 'done' ? <Badge tone="ok" icon="check">Approved</Badge> : null}
        {item.status === 'denied' ? <Badge icon="close">Not approved</Badge> : null}
        {item.status === 'waiting-permission' ? <Badge tone="warn">Waiting for your review</Badge> : null}
        {filePath ? (
          <button type="button" class="link-btn" onClick={(e) => { e.stopPropagation(); openFile(filePath); }}>
            <Icon name="go-to-file" /> Open plan file
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ToolSearchBody({ item }: { item: ToolItem }) {
  const s = item.structured as { matches?: unknown } | undefined;
  const matches = Array.isArray(s?.matches) ? (s!.matches as unknown[]).filter((m): m is string => typeof m === 'string') : [];
  if (!matches.length) return <GenericBody item={item} showInput={false} />;
  return (
    <div class="chips">
      {matches.map((m) => {
        const mcp = parseMcpName(m);
        return (
          <span key={m} class="chip mono">
            {mcp ? `${mcp.server} › ${mcp.tool}` : m}
          </span>
        );
      })}
    </div>
  );
}

function isSimpleInput(input: Record<string, unknown>): boolean {
  const entries = Object.entries(input ?? {});
  return entries.length > 0 && entries.length <= 6 && entries.every(([, v]) => (typeof v === 'string' && v.length < 300 && !v.includes('\n')) || typeof v === 'number' || typeof v === 'boolean');
}

function GenericBody({ item, showInput }: { item: ToolItem; showInput: boolean }) {
  const input = item.input ?? {};
  const hasInput = showInput && Object.keys(input).length > 0;
  return (
    <IOBox>
      {hasInput ? (
        <IORow label="IN">
          {isSimpleInput(input) ? (
            <div class="kv">
              {Object.entries(input).map(([k, v]) => (
                <div key={k}>
                  <span class="kv-key">{k}</span> <span class="mono">{String(v)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Pre text={JSON.stringify(input, null, 2)} lang="json" clip={140} />
          )}
        </IORow>
      ) : null}
      {item.status === 'streaming' && item.partialInput ? (
        <IORow label="IN">
          <Pre text={item.partialInput} clip={100} />
        </IORow>
      ) : null}
      <ResultRow item={item} />
    </IOBox>
  );
}
