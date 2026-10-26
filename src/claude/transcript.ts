import { readFile } from 'node:fs/promises';
import { ChatBuilder } from '../sessions/chatBuilder';
import type { ApiMessage } from './sdkTypes';

/**
 * Loads a session transcript (JSONL) into a ChatBuilder.
 *
 * Transcripts are append-only logs that can contain abandoned branches (after
 * a rewind) and compaction boundaries. We walk back from the last entry via
 * parentUuid (and logicalParentUuid across compactions) to get the branch the
 * user actually sees, falling back to file order when the chain looks broken.
 */

export interface TranscriptEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: ApiMessage;
  toolUseResult?: unknown;
  timestamp?: string;
  apiBlockIndex?: number;
  content?: unknown;
  level?: string;
  durationMs?: number;
  error?: unknown;
  retryAttempt?: number;
  maxRetries?: number;
  customTitle?: string;
  aiTitle?: string;
  cwd?: string;
  gitBranch?: string;
  [k: string]: unknown;
}

const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history-snapshot"', '{"type":"queue-operation"', '{"type":"atis-latch"', '{"type":"last-prompt"'];

const CONVERSATION_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'progress']);

export function parseTranscript(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl >= 0 ? text.slice(pos, nl) : text.slice(pos);
    pos = nl >= 0 ? nl + 1 : text.length;
    if (!line || line.length < 2) continue;
    if (SKIP_PREFIXES.some((p) => line.startsWith(p))) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && typeof o.type === 'string') out.push(o);
    } catch {
      // torn final line while the session is being written
    }
  }
  return out;
}

/** Entries of the visible conversation branch, in order. */
export function mainChain(entries: TranscriptEntry[]): TranscriptEntry[] {
  const convo = entries.filter((e) => CONVERSATION_TYPES.has(e.type) && !e.isSidechain && e.uuid);
  if (convo.length === 0) return [];
  const byUuid = new Map<string, TranscriptEntry>();
  for (const e of convo) byUuid.set(e.uuid!, e);
  const chain: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let cur: TranscriptEntry | undefined = convo[convo.length - 1];
  while (cur && !seen.has(cur.uuid!)) {
    seen.add(cur.uuid!);
    chain.push(cur);
    const parentId: string | null | undefined = cur.parentUuid ?? cur.logicalParentUuid;
    let next: TranscriptEntry | undefined = parentId ? byUuid.get(parentId) : undefined;
    if (!next && cur.parentUuid && cur.logicalParentUuid) next = byUuid.get(cur.logicalParentUuid);
    cur = next;
  }
  chain.reverse();
  // A healthy chain covers most of the conversation; otherwise trust file order.
  const messages = convo.filter((e) => e.type === 'user' || e.type === 'assistant').length;
  const inChainCount = chain.filter((e) => e.type === 'user' || e.type === 'assistant').length;
  if (messages > 0 && inChainCount < Math.min(messages, 4) && inChainCount < messages * 0.5) return convo;

  // Parallel tool calls branch the log: each tool_result hangs off its own
  // tool_use entry, so only one of them is on the parent chain. Keep file
  // order and add every result whose tool_use is on the visible branch.
  const toolUseIds = new Set<string>();
  for (const e of chain) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message!.content as Array<{ type?: string; id?: string }>) if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
  }
  const inChain = new Set(chain.map((e) => e.uuid!));
  return convo.filter((e) => {
    if (inChain.has(e.uuid!)) return true;
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) return false;
    return (e.message!.content as Array<{ type?: string; tool_use_id?: string }>).some((b) => b.type === 'tool_result' && !!b.tool_use_id && toolUseIds.has(b.tool_use_id));
  });
}

export interface TranscriptInfo {
  customTitle?: string;
  aiTitle?: string;
  cwd?: string;
  gitBranch?: string;
  /** Effort of the last assistant reply. */
  effort?: string;
}

/** Feeds transcript entries into a builder. */
export function buildChat(entries: TranscriptEntry[], builder: ChatBuilder): TranscriptInfo {
  const info: TranscriptInfo = {};
  for (const e of entries) {
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') info.customTitle = e.customTitle;
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') info.aiTitle = e.aiTitle;
  }
  for (const e of mainChain(entries)) {
    const ts = e.timestamp ? Date.parse(e.timestamp) : undefined;
    if (e.cwd) info.cwd = e.cwd;
    if (e.gitBranch) info.gitBranch = e.gitBranch;
    if (e.type === 'assistant' && typeof e.effort === 'string') info.effort = e.effort;
    switch (e.type) {
      case 'assistant':
        if (e.message) builder.addAssistant(e.message, null, typeof e.apiBlockIndex === 'number' ? e.apiBlockIndex : undefined, e.uuid);
        break;
      case 'user':
        if (e.message) builder.addUser(e.message, { uuid: e.uuid, toolUseResult: e.toolUseResult, timestamp: ts, isMeta: e.isMeta, isCompactSummary: e.isCompactSummary });
        break;
      case 'system':
        addSystemEntry(e, builder, ts);
        break;
      default:
        break;
    }
  }
  builder.endStreaming();
  return info;
}

function addSystemEntry(e: TranscriptEntry, builder: ChatBuilder, ts: number | undefined): void {
  const id = e.uuid;
  const content = typeof e.content === 'string' ? e.content : undefined;
  switch (e.subtype) {
    case 'compact_boundary':
      builder.addSystem('info', 'Conversation compacted', 'compact', id, ts);
      break;
    case 'turn_duration':
      builder.addTurnEnd({ id, durationMs: typeof e.durationMs === 'number' ? e.durationMs : undefined, isError: false });
      break;
    case 'informational':
      if (content) builder.addSystem('info', content, undefined, id, ts);
      break;
    case 'model_refusal_fallback':
      if (content) builder.addSystem('warning', content, undefined, id, ts);
      break;
    case 'local_command': {
      const out = content ? /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content)?.[1]?.trim() : undefined;
      if (out) builder.addSystem('info', out, 'command-output', id, ts);
      break;
    }
    case 'away_summary':
      if (content) builder.addSystem('info', content, undefined, id, ts);
      break;
    default:
      // api_error retries, hook summaries… are noise in history.
      break;
  }
}

/** Reads and builds a transcript file. Returns undefined when the file does not exist yet. */
export async function loadTranscriptFile(path: string, builder: ChatBuilder): Promise<TranscriptInfo | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  return buildChat(parseTranscript(text), builder);
}
