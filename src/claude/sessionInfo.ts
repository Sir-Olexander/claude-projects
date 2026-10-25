import { open } from 'node:fs/promises';

/**
 * Cheap metadata for one transcript, read from its first and last 64 KB only
 * (transcripts can be tens of MB). Mirrors how Claude Code's own session list
 * picks a title: custom title (/rename) → AI title → last prompt → summary →
 * first prompt.
 */
export interface SessionInfo {
  sessionId: string;
  filePath: string;
  /** Working directory the session ran in. */
  cwd?: string;
  /** Display title. */
  title: string;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  gitBranch?: string;
  createdAt?: number;
  lastModified: number;
  size: number;
}

export const HEAD_TAIL_BYTES = 64 * 1024;

export interface HeadTail {
  head: string;
  tail: string;
  size: number;
  mtimeMs: number;
}

export async function readHeadTail(path: string, bytes = HEAD_TAIL_BYTES): Promise<HeadTail | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size === 0) return undefined;
    const buf = Buffer.allocUnsafe(Math.min(bytes, st.size));
    const h = await fh.read(buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, h.bytesRead);
    let tail = head;
    if (st.size > bytes) {
      const t = await fh.read(buf, 0, buf.length, st.size - bytes);
      tail = buf.toString('utf8', 0, t.bytesRead);
    }
    return { head, tail, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/** Value of the LAST `"key":"value"` occurrence in text (no JSON parse of the lines). */
export function lastStringField(text: string, key: string): string | undefined {
  let result: string | undefined;
  let bestPos = -1;
  for (const needle of [`"${key}":"`, `"${key}": "`]) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const start = at + needle.length;
      let i = start;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') break;
        i++;
      }
      if (i < text.length && at > bestPos) {
        bestPos = at;
        result = unescapeJsonString(text.slice(start, i));
      }
      from = i + 1;
    }
  }
  return result;
}

/** Value of the FIRST `"key":"value"` occurrence in text. */
export function firstStringField(text: string, key: string): string | undefined {
  let best: { pos: number; value: string } | undefined;
  for (const needle of [`"${key}":"`, `"${key}": "`]) {
    const at = text.indexOf(needle);
    if (at < 0 || (best && at > best.pos)) continue;
    const start = at + needle.length;
    let i = start;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') break;
      i++;
    }
    if (i < text.length) best = { pos: at, value: unescapeJsonString(text.slice(start, i)) };
  }
  return best?.value;
}

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/;
const SKIP_PROMPT_RE = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;
const BASH_INPUT_RE = /<bash-input>([\s\S]*?)<\/bash-input>/;

interface PromptContext {
  commandFallback: string;
}

/** The prompt text of a parsed transcript user entry, or undefined if it is not a typed prompt. */
export function promptTextOf(entry: Record<string, unknown>, ctx: PromptContext): string | undefined {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true) return undefined;
  const message = entry.message as { content?: unknown } | undefined;
  if (!message) return undefined;
  const content = message.content;
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content as Array<{ type?: string; text?: unknown }>) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') return undefined;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  for (const t of texts) {
    let s = t.replace(/\n/g, ' ').trim();
    if (!s) continue;
    const cmd = COMMAND_NAME_RE.exec(s);
    if (cmd) {
      if (!ctx.commandFallback) ctx.commandFallback = cmd[1];
      continue;
    }
    const bash = BASH_INPUT_RE.exec(s);
    if (bash) return `! ${bash[1].trim()}`;
    if (SKIP_PROMPT_RE.test(s)) continue;
    if (s.length > 200) s = s.slice(0, 200).trim() + '…';
    return s;
  }
  return undefined;
}

/** First typed prompt in the head of a transcript. */
export function firstPrompt(head: string): { prompt?: string; commandFallback?: string; media?: string } {
  const ctx: PromptContext = { commandFallback: '' };
  let media: string | undefined;
  let pos = 0;
  while (pos < head.length) {
    const nl = head.indexOf('\n', pos);
    const line = nl >= 0 ? head.slice(pos, nl) : head.slice(pos);
    pos = nl >= 0 ? nl + 1 : head.length;
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isCompactSummary":true')) continue;
    if (!media && line.includes('"type":"image"')) media = 'Image';
    if (!media && line.includes('"type":"document"')) media = 'Document';
    try {
      const entry = JSON.parse(line);
      const p = promptTextOf(entry, ctx);
      if (p) return { prompt: p, commandFallback: ctx.commandFallback || undefined, media };
    } catch {
      // partial line at the end of the head buffer
    }
  }
  return { commandFallback: ctx.commandFallback || undefined, media };
}

function relocatedCwd(tail: string): string | undefined {
  let end = tail.length;
  while (end > 0) {
    const nl = tail.lastIndexOf('\n', end - 1);
    const line = tail.slice(nl + 1, end);
    end = nl;
    if (line.includes('"relocatedCwd":') && line.includes('"type":"relocated"')) {
      try {
        const o = JSON.parse(line);
        if (typeof o.relocatedCwd === 'string') return o.relocatedCwd;
      } catch {
        // ignore
      }
    }
    if (nl < 0) break;
  }
  return undefined;
}

/** Builds SessionInfo from head/tail text, or undefined when the file is not a listable session. */
export function parseSessionInfo(sessionId: string, filePath: string, ht: HeadTail): SessionInfo | undefined {
  const firstLineEnd = ht.head.indexOf('\n');
  const firstLine = firstLineEnd >= 0 ? ht.head.slice(0, firstLineEnd) : ht.head;
  if (firstLine.includes('"isSidechain":true')) return undefined;
  // A transcript with no conversation entries at all (only metadata) is not a session.
  if (!ht.head.includes('"parentUuid":') && !ht.tail.includes('"parentUuid":') && ht.size <= 2 * HEAD_TAIL_BYTES) return undefined;

  const customTitle = lastStringField(ht.tail, 'customTitle') ?? lastStringField(ht.head, 'customTitle');
  const aiTitle = lastStringField(ht.tail, 'aiTitle') ?? lastStringField(ht.head, 'aiTitle');
  const lastPrompt = lastStringField(ht.tail, 'lastPrompt');
  const summary = lastStringField(ht.tail, 'summary');
  const fp = firstPrompt(ht.head);
  const title = customTitle || aiTitle || lastPrompt || summary || fp.prompt || (fp.commandFallback ? `/${fp.commandFallback.replace(/^\//, '')}` : undefined) || fp.media;
  if (!title) return undefined;

  const ts = firstStringField(ht.head, 'timestamp');
  const createdAt = ts ? Date.parse(ts) : NaN;
  return {
    sessionId,
    filePath,
    cwd: relocatedCwd(ht.tail) ?? firstStringField(ht.head, 'cwd') ?? lastStringField(ht.tail, 'cwd'),
    title: oneLine(title),
    customTitle: customTitle || undefined,
    aiTitle: aiTitle || undefined,
    firstPrompt: fp.prompt,
    lastPrompt: lastPrompt || undefined,
    gitBranch: lastStringField(ht.tail, 'gitBranch') ?? firstStringField(ht.head, 'gitBranch'),
    createdAt: Number.isNaN(createdAt) ? undefined : createdAt,
    lastModified: Math.round(ht.mtimeMs),
    size: ht.size,
  };
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? t.slice(0, 159) + '…' : t;
}
