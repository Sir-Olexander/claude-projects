import { randomUUID } from 'node:crypto';
import type { ChatItem, ImageAttachment, SystemItem, TodoItem, ToolItem, ToolStatus, UserItem } from '../shared/protocol';
import type { ApiMessage, ContentBlock, StreamEvent, ToolResultBlock, Usage } from '../claude/sdkTypes';

/**
 * Builds the chat view model (ChatItem[]) from Claude Code messages. Used for
 * both transcript history (JSONL entries) and live stream-json frames, so a
 * resumed session looks exactly like a live one.
 *
 * Changes are recorded so the session can send small incremental updates to
 * the webview (see takeChanges()).
 */

const MAX_RESULT_CHARS = 24_000;
const MAX_READ_RESULT_CHARS = 3_000;
const MAX_STRUCTURED_CHARS = 60_000;
const MAX_INPUT_STRING_CHARS = 16_000;
const MAX_THINKING_CHARS = 24_000;

function capText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n… (truncated)' : s;
}

/** Tool inputs can carry whole files (Write content, Edit strings); keep the UI payload small. */
function slimInput(input: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > MAX_INPUT_STRING_CHARS) {
      out ??= { ...input };
      out[k] = capText(v, MAX_INPUT_STRING_CHARS);
    }
  }
  return out ?? input;
}

export interface Delta {
  id: string;
  field: 'text' | 'partialInput';
  text: string;
}

export interface Changes {
  /** Items to insert/replace, in display order. */
  upserts: ChatItem[];
  removed: string[];
  deltas: Delta[];
}

export interface UserEntryContext {
  uuid?: string;
  parentToolUseId?: string | null;
  /** Structured tool output (transcript `toolUseResult` / stream `tool_use_result`). */
  toolUseResult?: unknown;
  timestamp?: number;
  isMeta?: boolean;
  isCompactSummary?: boolean;
}

export class ChatBuilder {
  private list: ChatItem[] = [];
  private pos = new Map<string, number>();
  private frameCounters = new Map<string, number>();
  private upserted = new Set<string>();
  private removedIds = new Set<string>();
  private pendingDeltas: Delta[] = [];
  /** `${messageId}:${blockIndex}` -> item id, for routing stream deltas. */
  private streamTargets = new Map<string, string>();
  /** parentToolUseId ('' for main thread) -> message id currently streaming. */
  private streamMessage = new Map<string, string>();
  /** parentToolUseId -> text/thinking item currently being streamed (for frames whose ids don't line up). */
  private openStream = new Map<string, { id: string; kind: 'text' | 'thinking' }>();
  private lastRetryId: string | undefined;

  todos: TodoItem[] | undefined;
  lastUsage: Usage | undefined;
  lastModel: string | undefined;

  /**
   * @param imageSink receives every image the builder creates (lets the session
   *   move big images to a disk cache instead of keeping base64 in memory).
   */
  constructor(
    private readonly imageSink: (img: ImageAttachment) => ImageAttachment = (img) => img,
    private readonly now: () => number = Date.now,
  ) {}

  get items(): readonly ChatItem[] {
    return this.list;
  }

  get size(): number {
    return this.list.length;
  }

  get<T extends ChatItem = ChatItem>(id: string): T | undefined {
    const i = this.pos.get(id);
    return i === undefined ? undefined : (this.list[i] as T);
  }

  /** Insert (append) or replace an item by id. */
  upsert(item: ChatItem): void {
    const i = this.pos.get(item.id);
    if (i === undefined) {
      this.pos.set(item.id, this.list.length);
      this.list.push(item);
      this.removedIds.delete(item.id);
    } else {
      this.list[i] = item;
    }
    this.upserted.add(item.id);
  }

  patch<T extends ChatItem>(id: string, patch: Partial<T>): T | undefined {
    const cur = this.get<T>(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch } as T;
    this.upsert(next);
    return next;
  }

  remove(id: string): void {
    const i = this.pos.get(id);
    if (i === undefined) return;
    this.list.splice(i, 1);
    this.pos.delete(id);
    for (let j = i; j < this.list.length; j++) this.pos.set(this.list[j].id, j);
    this.upserted.delete(id);
    this.removedIds.add(id);
  }

  /**
   * Move an item to the end (e.g. a queued message once Claude picks it up).
   * The webview gets a removal followed by an append, so send `removed` before `upserts`.
   */
  moveToEnd(id: string): void {
    const item = this.get(id);
    if (!item) return;
    if (this.pos.get(id) === this.list.length - 1) {
      this.upserted.add(id);
      return;
    }
    this.remove(id);
    this.upsert(item);
    this.moved.add(id);
  }

  private moved = new Set<string>();

  /** Changes since the last call, ready to send to the webview (send `removed` first). */
  takeChanges(): Changes {
    const upserts = [...this.upserted]
      .map((id) => ({ id, i: this.pos.get(id) }))
      .filter((x): x is { id: string; i: number } => x.i !== undefined)
      .sort((a, b) => a.i - b.i)
      .map((x) => this.list[x.i]);
    // Deltas for items being fully re-sent are already included.
    const merged: Delta[] = [];
    for (const d of this.pendingDeltas) {
      if (this.upserted.has(d.id) || this.removedIds.has(d.id)) continue;
      const last = merged[merged.length - 1];
      if (last && last.id === d.id && last.field === d.field) last.text += d.text;
      else merged.push({ ...d });
    }
    const removed = [...new Set([...this.removedIds, ...this.moved])];
    this.upserted.clear();
    this.removedIds.clear();
    this.moved.clear();
    this.pendingDeltas = [];
    return { upserts, removed, deltas: merged };
  }

  hasChanges(): boolean {
    return this.upserted.size > 0 || this.removedIds.size > 0 || this.pendingDeltas.length > 0 || this.moved.size > 0;
  }

  /** Forget pending change records (after sending a full snapshot). */
  clearChanges(): void {
    this.upserted.clear();
    this.removedIds.clear();
    this.moved.clear();
    this.pendingDeltas = [];
  }

  // ---------------------------------------------------------------------------
  // Assistant messages
  // ---------------------------------------------------------------------------

  /**
   * Adds the content blocks of an assistant message. Claude Code delivers one
   * block per frame/entry; `blockIndex` (transcript `apiBlockIndex`) or a
   * per-message counter maps each block to a stable item id.
   */
  addAssistant(msg: ApiMessage, parentToolUseId: string | null | undefined, blockIndex?: number): void {
    const msgId = msg.id || randomUUID();
    const parent = parentToolUseId ?? undefined;
    const blocks: ContentBlock[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content ?? []);
    let explicitIndex = blockIndex;
    const parentKey = parentToolUseId ?? '';
    for (const block of blocks) {
      const index = explicitIndex ?? this.nextFrameIndex(msgId);
      explicitIndex = undefined;
      let itemId = `${msgId}:${index}`;
      const kind = block.type === 'text' ? 'text' : block.type === 'thinking' || block.type === 'redacted_thinking' ? 'thinking' : undefined;
      if (kind && !this.get(itemId)) {
        const open = this.openStream.get(parentKey);
        if (open?.kind === kind && this.get(open.id)) itemId = open.id;
      }
      if (kind) this.openStream.delete(parentKey);
      switch (block.type) {
        case 'text': {
          const text = (block as { text?: string }).text ?? '';
          if (!text.trim() && !this.get(itemId)) break;
          this.upsert({ kind: 'text', id: itemId, text, parentToolUseId: parent });
          break;
        }
        case 'thinking':
          this.upsert({ kind: 'thinking', id: itemId, text: capText((block as { thinking?: string }).thinking ?? '', MAX_THINKING_CHARS), parentToolUseId: parent });
          break;
        case 'redacted_thinking':
          this.upsert({ kind: 'thinking', id: itemId, text: '', parentToolUseId: parent });
          break;
        case 'tool_use':
        case 'server_tool_use': {
          const b = block as { id: string; name: string; input?: Record<string, unknown> };
          const existing = this.get<ToolItem>(b.id);
          const status: ToolStatus = existing && existing.status !== 'streaming' ? existing.status : 'pending';
          this.upsert({
            kind: 'tool',
            id: b.id,
            name: b.name,
            input: slimInput(b.input ?? {}),
            status,
            result: existing?.result,
            structured: existing?.structured,
            parentToolUseId: parent,
            startedAt: existing?.startedAt ?? this.now(),
            finishedAt: existing?.finishedAt,
          });
          // A streamed placeholder under a synthetic id would duplicate the tool row.
          const placeholder = this.streamTargets.get(itemId);
          if (placeholder && placeholder !== b.id) this.remove(placeholder);
          if (b.name === 'TodoWrite' && !parent) this.todos = normalizeTodos(b.input?.todos);
          break;
        }
        default:
          break;
      }
    }
    if (!parent) {
      if (msg.usage) this.lastUsage = msg.usage;
      if (msg.model && msg.model !== '<synthetic>') this.lastModel = msg.model;
    }
  }

  private nextFrameIndex(msgId: string): number {
    const n = this.frameCounters.get(msgId) ?? 0;
    this.frameCounters.set(msgId, n + 1);
    return n;
  }

  // ---------------------------------------------------------------------------
  // Streaming (stream_event frames)
  // ---------------------------------------------------------------------------

  streamEvent(ev: StreamEvent, parentToolUseId: string | null | undefined): void {
    const parentKey = parentToolUseId ?? '';
    const parent = parentToolUseId ?? undefined;
    switch (ev.type) {
      case 'message_start': {
        this.streamMessage.set(parentKey, ev.message?.id || randomUUID());
        break;
      }
      case 'content_block_start': {
        const msgId = this.streamMessage.get(parentKey);
        if (!msgId || ev.index === undefined || !ev.content_block) break;
        const key = `${msgId}:${ev.index}`;
        const cb = ev.content_block as ContentBlock & Record<string, unknown>;
        if (cb.type === 'text') {
          this.streamTargets.set(key, key);
          if (!this.get(key)) this.upsert({ kind: 'text', id: key, text: String(cb.text ?? ''), streaming: true, parentToolUseId: parent });
          this.openStream.set(parentKey, { id: key, kind: 'text' });
        } else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
          this.streamTargets.set(key, key);
          if (!this.get(key)) this.upsert({ kind: 'thinking', id: key, text: String(cb.thinking ?? ''), streaming: true, parentToolUseId: parent });
          this.openStream.set(parentKey, { id: key, kind: 'thinking' });
        } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
          const id = String(cb.id ?? key);
          this.streamTargets.set(key, id);
          if (!this.get(id)) {
            this.upsert({ kind: 'tool', id, name: String(cb.name ?? 'Tool'), input: {}, partialInput: '', status: 'streaming', parentToolUseId: parent, startedAt: this.now() });
          }
        }
        break;
      }
      case 'content_block_delta': {
        const msgId = this.streamMessage.get(parentKey);
        if (!msgId || ev.index === undefined || !ev.delta) break;
        const target = this.streamTargets.get(`${msgId}:${ev.index}`);
        if (!target) break;
        const item = this.get(target);
        if (!item) break;
        const d = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        if (d.type === 'text_delta' && item.kind === 'text' && d.text) {
          item.text += d.text;
          this.pendingDeltas.push({ id: target, field: 'text', text: d.text });
        } else if (d.type === 'thinking_delta' && item.kind === 'thinking' && d.thinking) {
          item.text += d.thinking;
          this.pendingDeltas.push({ id: target, field: 'text', text: d.thinking });
        } else if (d.type === 'input_json_delta' && item.kind === 'tool' && d.partial_json) {
          item.partialInput = (item.partialInput ?? '') + d.partial_json;
          this.pendingDeltas.push({ id: target, field: 'partialInput', text: d.partial_json });
        }
        break;
      }
      case 'content_block_stop': {
        const msgId = this.streamMessage.get(parentKey);
        if (!msgId || ev.index === undefined) break;
        const target = this.streamTargets.get(`${msgId}:${ev.index}`);
        const item = target ? this.get(target) : undefined;
        if (item && (item.kind === 'text' || item.kind === 'thinking') && item.streaming) this.patch(item.id, { streaming: false });
        break;
      }
      case 'message_stop':
        this.streamMessage.delete(parentKey);
        this.openStream.delete(parentKey);
        break;
      default:
        break;
    }
  }

  /** Marks any still-streaming items as finished (turn ended or was interrupted). */
  endStreaming(): void {
    for (const item of this.list) {
      if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) this.patch(item.id, { streaming: false });
    }
    this.streamMessage.clear();
    this.openStream.clear();
  }

  /** Marks tools that never got a result as interrupted (after an interrupt or crash). */
  settleOpenTools(status: ToolStatus = 'interrupted'): void {
    for (const item of this.list) {
      if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'running' || item.status === 'streaming' || item.status === 'waiting-permission')) {
        this.patch<ToolItem>(item.id, { status, finishedAt: this.now() });
      }
    }
  }

  setToolStatus(toolUseId: string | undefined, status: ToolStatus): void {
    if (!toolUseId) return;
    const t = this.get<ToolItem>(toolUseId);
    if (t && t.kind === 'tool' && t.status !== status) this.patch<ToolItem>(toolUseId, { status });
  }

  // ---------------------------------------------------------------------------
  // User messages (typed prompts and tool results)
  // ---------------------------------------------------------------------------

  addUser(msg: ApiMessage, ctx: UserEntryContext = {}): void {
    if (ctx.isMeta) return;
    if (ctx.isCompactSummary) {
      this.addSystem('info', 'Conversation compacted', 'compact', ctx.uuid ? `${ctx.uuid}:compact` : undefined, ctx.timestamp);
      return;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      if (!ctx.parentToolUseId) this.addUserText(content, [], ctx);
      return;
    }
    const texts: string[] = [];
    const images: ImageAttachment[] = [];
    for (const block of content ?? []) {
      if (block.type === 'tool_result') {
        this.applyToolResult(block as ToolResultBlock, ctx.toolUseResult);
      } else if (block.type === 'text') {
        texts.push((block as { text: string }).text);
      } else if (block.type === 'image') {
        const src = (block as { source?: { type?: string; media_type?: string; data?: string } }).source;
        if (src?.type === 'base64' && src.data) images.push(this.imageSink({ mediaType: src.media_type ?? 'image/png', data: src.data }));
      }
    }
    // Text inside a subagent is the prompt Claude gave it (already shown on the Agent row), not something you typed.
    if ((texts.length || images.length) && !ctx.parentToolUseId) this.addUserText(texts.join('\n\n'), images, ctx);
  }

  private addUserText(raw: string, images: ImageAttachment[], ctx: UserEntryContext): void {
    const id = ctx.uuid ?? randomUUID();
    const text = stripSystemReminders(raw).trim();
    if (!text && !images.length) return;

    if (text.startsWith('Caveat: The messages below were generated by the user while running local commands')) return;

    const cmd = /<command-name>\/?([^<]*)<\/command-name>/.exec(text);
    if (cmd) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
      const name = cmd[1].trim();
      this.upsert({ kind: 'user', id, text: `/${name}${args ? ' ' + args : ''}`, command: name, timestamp: ctx.timestamp });
      return;
    }
    const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
    if (stdout) {
      const out = stripAnsi(stdout[1]).trim();
      if (out) this.addSystem('info', out, 'command-output', id, ctx.timestamp);
      return;
    }
    const bashIn = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
    if (bashIn) {
      this.upsert({ kind: 'user', id, text: `! ${bashIn[1].trim()}`, timestamp: ctx.timestamp });
      return;
    }
    if (/<bash-stdout>|<bash-stderr>/.test(text)) {
      const out = [/<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(text)?.[1], /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(text)?.[1]]
        .filter(Boolean)
        .map((s) => stripAnsi(s!).trim())
        .join('\n');
      if (out) this.addSystem('info', out, 'command-output', id, ctx.timestamp);
      return;
    }
    if (/^\[Request interrupted by user/.test(text)) {
      this.addSystem('info', text.includes('for tool use') ? 'Interrupted · Claude is waiting for your instructions' : 'Interrupted', 'interrupted', id, ctx.timestamp);
      return;
    }
    if (text.startsWith('<task-notification>')) {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
      const status = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim();
      this.addSystem('info', summary ? `Background task${status ? ` ${status}` : ''}: ${summary}` : 'Background task update', undefined, id, ctx.timestamp);
      return;
    }
    if (/^<[a-z][\w-]*[\s>]/.test(text) && !images.length) {
      // Other internal envelopes (hook output, reminders…) are not shown.
      return;
    }
    const item: UserItem = { kind: 'user', id, text, timestamp: ctx.timestamp };
    if (images.length) item.images = images;
    this.upsert(item);
  }

  private applyToolResult(block: ToolResultBlock, structured: unknown): void {
    const tool = this.get<ToolItem>(block.tool_use_id);
    const flat = flattenToolResult(block.content);
    const text = flat.text;
    const images = flat.images.map(this.imageSink);
    const isError = block.is_error === true;
    let status: ToolStatus = isError ? 'error' : 'done';
    if (isError && /doesn't want to proceed|tool use was rejected|User rejected/i.test(text)) status = 'denied';
    if (/^\[Request interrupted by user/.test(text)) status = 'interrupted';
    const limit = tool?.name === 'Read' ? MAX_READ_RESULT_CHARS : MAX_RESULT_CHARS;
    const truncated = text.length > limit;
    const result = { text: truncated ? text.slice(0, limit) : text, isError, truncated: truncated || undefined, images: images.length ? images : undefined };
    const base: ToolItem = tool ?? { kind: 'tool', id: block.tool_use_id, name: 'Tool', input: {}, status: 'done' };
    this.upsert({ ...base, status, result, structured: slimStructured(base.name, structured) ?? base.structured, finishedAt: this.now(), partialInput: undefined });
  }

  // ---------------------------------------------------------------------------
  // System notices and turn ends
  // ---------------------------------------------------------------------------

  addSystem(level: SystemItem['level'], text: string, tag?: SystemItem['tag'], id?: string, timestamp?: number): SystemItem {
    const item: SystemItem = { kind: 'system', id: id ?? randomUUID(), level, text, tag, timestamp: timestamp ?? this.now() };
    this.upsert(item);
    return item;
  }

  /** API retry notices replace each other instead of piling up. */
  addRetry(text: string): void {
    const last = this.list[this.list.length - 1];
    if (this.lastRetryId && last && last.id === this.lastRetryId) {
      this.patch<SystemItem>(this.lastRetryId, { text });
      return;
    }
    this.lastRetryId = this.addSystem('warning', text, 'retry').id;
  }

  addTurnEnd(opts: { durationMs?: number; isError: boolean; errorText?: string; id?: string }): void {
    this.lastRetryId = undefined;
    this.upsert({ kind: 'turn-end', id: opts.id ?? randomUUID(), durationMs: opts.durationMs, isError: opts.isError, errorText: opts.errorText });
  }

  /** Items for the webview, optionally only the most recent ones. */
  snapshot(maxItems?: number): { items: ChatItem[]; truncated: boolean } {
    if (!maxItems || this.list.length <= maxItems) return { items: [...this.list], truncated: false };
    // Cut at a user message boundary so a turn is never shown half.
    let start = this.list.length - maxItems;
    for (let i = start; i < this.list.length; i++) {
      const it = this.list[i];
      if (it.kind === 'user' && !(it as UserItem).queued) {
        start = i;
        break;
      }
    }
    // Keep subagent children of tools that are still shown.
    const items = this.list.slice(start);
    return { items, truncated: true };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function flattenToolResult(content: ToolResultBlock['content']): { text: string; images: ImageAttachment[] } {
  if (content === undefined || content === null) return { text: '', images: [] };
  if (typeof content === 'string') return { text: content, images: [] };
  const parts: string[] = [];
  const images: ImageAttachment[] = [];
  for (const c of content) {
    if (c.type === 'text') parts.push(String((c as { text?: string }).text ?? ''));
    else if (c.type === 'image') {
      const src = (c as { source?: { type?: string; media_type?: string; data?: string } }).source;
      if (src?.type === 'base64' && src.data && src.data.length < 4_000_000) images.push({ mediaType: src.media_type ?? 'image/png', data: src.data });
    } else if (c.type === 'tool_reference') {
      parts.push(`Loaded tool: ${String((c as { tool_name?: string }).tool_name ?? '')}`);
    }
  }
  return { text: parts.join('\n'), images };
}

/** Keeps the useful parts of structured tool output and drops bulky ones (full file contents…). */
export function slimStructured(toolName: string, structured: unknown): unknown {
  if (structured === undefined || structured === null) return undefined;
  if (typeof structured !== 'object') return undefined;
  const s = structured as Record<string, unknown>;
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      return capSize({ filePath: s.filePath, type: s.type, structuredPatch: s.structuredPatch, userModified: s.userModified });
    }
    case 'Read': {
      const f = s.file as Record<string, unknown> | undefined;
      return f ? { type: s.type, file: { filePath: f.filePath, numLines: f.numLines, startLine: f.startLine, totalLines: f.totalLines } } : { type: s.type };
    }
    case 'Bash':
      return { interrupted: s.interrupted, isImage: s.isImage, backgroundTaskId: s.backgroundTaskId, returnCodeInterpretation: s.returnCodeInterpretation };
    case 'Grep':
    case 'Glob':
      return { numFiles: s.numFiles, numLines: s.numLines, numMatches: s.numMatches, truncated: s.truncated, durationMs: s.durationMs, mode: s.mode };
    case 'Task':
    case 'Agent':
      return { status: s.status, totalDurationMs: s.totalDurationMs, totalToolUseCount: s.totalToolUseCount, totalTokens: s.totalTokens };
    case 'AskUserQuestion':
      return { answers: s.answers };
    case 'ExitPlanMode':
      return { plan: typeof s.plan === 'string' ? s.plan.slice(0, 40_000) : undefined, filePath: s.filePath };
    default:
      return capSize(s);
  }
}

function capSize(o: unknown): unknown {
  try {
    const json = JSON.stringify(o);
    return json && json.length <= MAX_STRUCTURED_CHARS ? o : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeTodos(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const todos: TodoItem[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content : typeof o.subject === 'string' ? o.subject : undefined;
    if (!content) continue;
    const status = o.status === 'completed' || o.status === 'in_progress' ? o.status : 'pending';
    todos.push({ content, status, activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined });
  }
  return todos;
}

export function stripSystemReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
