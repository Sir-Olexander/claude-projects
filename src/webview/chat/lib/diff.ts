import { structuredPatch } from 'diff';
import type { ToolItem } from '../../../shared/protocol';

export type DiffLineType = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FileDiff {
  filePath?: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Line numbers are real file line numbers (false when computed from a snippet). */
  hasLineNumbers: boolean;
  /** True for a brand new file. */
  isNew?: boolean;
  /** Lines were left out to keep the view small. */
  truncated?: boolean;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

const MAX_LINES = 800;

function isHunk(h: unknown): h is Hunk {
  return !!h && typeof h === 'object' && Array.isArray((h as Hunk).lines) && typeof (h as Hunk).oldStart === 'number';
}

/** Converts unified hunks (CLI structuredPatch or jsdiff) into display lines. */
export function linesFromHunks(hunks: Hunk[], withNumbers = true): Pick<FileDiff, 'lines' | 'added' | 'removed' | 'truncated'> {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  hunks.forEach((h, i) => {
    if (i > 0 || h.oldStart > 1) {
      lines.push({ type: 'hunk', text: withNumbers ? `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` : '⋯' });
    }
    let o = h.oldStart;
    let n = h.newStart;
    for (const raw of h.lines) {
      const sign = raw[0];
      const text = raw.slice(1);
      if (sign === '\\') continue; // "\ No newline at end of file"
      if (lines.length >= MAX_LINES) {
        truncated = true;
        if (sign === '+') added++;
        else if (sign === '-') removed++;
        continue;
      }
      if (sign === '+') {
        lines.push({ type: 'add', text, newNo: withNumbers ? n : undefined });
        n++;
        added++;
      } else if (sign === '-') {
        lines.push({ type: 'del', text, oldNo: withNumbers ? o : undefined });
        o++;
        removed++;
      } else {
        lines.push({ type: 'ctx', text, oldNo: withNumbers ? o : undefined, newNo: withNumbers ? n : undefined });
        o++;
        n++;
      }
    }
  });
  return { lines, added, removed, truncated };
}

/** Diff between two strings (snippets), without real line numbers. */
export function diffStrings(oldStr: string, newStr: string, context = 3): Pick<FileDiff, 'lines' | 'added' | 'removed' | 'truncated'> {
  const patch = structuredPatch('a', 'b', oldStr, newStr, '', '', { context });
  return linesFromHunks(patch.hunks as Hunk[], false);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * The diff to show for a file-changing tool (Edit, MultiEdit, Write, NotebookEdit),
 * from the CLI's structured result when available, otherwise from the input.
 */
export function diffForTool(item: Pick<ToolItem, 'name' | 'input' | 'structured'>): FileDiff | undefined {
  const name = item.name;
  const input = item.input ?? {};
  const structured = item.structured as Record<string, unknown> | undefined;
  const filePath = str(input.file_path) || str(input.notebook_path) || str(structured?.filePath) || undefined;

  const patch = structured && Array.isArray(structured.structuredPatch) ? (structured.structuredPatch as unknown[]).filter(isHunk) : undefined;
  if (patch && patch.length > 0) {
    return { filePath, hasLineNumbers: true, ...linesFromHunks(patch) };
  }

  if (name === 'Edit') {
    const d = diffStrings(str(input.old_string), str(input.new_string));
    return { filePath, hasLineNumbers: false, ...d };
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const all: DiffLine[] = [];
    let added = 0;
    let removed = 0;
    let truncated = false;
    (input.edits as Record<string, unknown>[]).forEach((e, i) => {
      const d = diffStrings(str(e.old_string), str(e.new_string));
      if (i > 0) all.push({ type: 'hunk', text: '⋯' });
      all.push(...d.lines);
      added += d.added;
      removed += d.removed;
      truncated ||= !!d.truncated;
    });
    return { filePath, hasLineNumbers: false, lines: all, added, removed, truncated };
  }
  if (name === 'Write') {
    const content = str(input.content) || str(structured?.content);
    const original = structured && typeof structured.originalFile === 'string' ? (structured.originalFile as string) : undefined;
    if (original !== undefined && original !== null) {
      const p = structuredPatch('a', 'b', original, content, '', '', { context: 3 });
      return { filePath, hasLineNumbers: true, ...linesFromHunks(p.hunks as Hunk[]) };
    }
    const all = content.split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const shown = all.slice(0, MAX_LINES);
    return {
      filePath,
      hasLineNumbers: true,
      isNew: structured?.type === 'create' || original === undefined,
      lines: shown.map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 })),
      added: all.length,
      removed: 0,
      truncated: all.length > shown.length,
    };
  }
  if (name === 'NotebookEdit') {
    const src = str(input.new_source);
    if (!src) return undefined;
    const lines = src.split('\n');
    return { filePath, hasLineNumbers: false, lines: lines.map((text) => ({ type: 'add' as const, text })), added: lines.length, removed: 0 };
  }
  return undefined;
}
