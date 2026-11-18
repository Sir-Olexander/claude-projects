import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Claude Code's config directory (~/.claude, or $CLAUDE_CONFIG_DIR). */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override ? override : join(homedir(), '.claude');
}

/** Where transcripts live: <claudeHome>/projects/<encoded cwd>/<sessionId>.jsonl */
export function projectsDir(env?: NodeJS.ProcessEnv): string {
  return join(claudeHome(env), 'projects');
}

/** Live process registry: <claudeHome>/sessions/<pid>.json */
export function liveSessionsDir(env?: NodeJS.ProcessEnv): string {
  return join(claudeHome(env), 'sessions');
}

const MAX_DIR_NAME = 200;

/** Same string hash Claude Code uses for long directory names. */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Directory name Claude Code uses for a working directory: every character
 * that is not a letter or digit becomes "-"; very long names are truncated and
 * suffixed with a hash.
 */
export function encodeProjectDirName(cwd: string): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (enc.length <= MAX_DIR_NAME) return enc;
  return `${enc.slice(0, MAX_DIR_NAME)}-${Math.abs(javaHash(cwd)).toString(36)}`;
}

export function transcriptDirFor(cwd: string, env?: NodeJS.ProcessEnv): string {
  return join(projectsDir(env), encodeProjectDirName(cwd));
}

export function transcriptPathFor(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv): string {
  return join(transcriptDirFor(cwd, env), `${sessionId}.jsonl`);
}

/** `cwd` and its parent folders, nearest first. */
function selfAndAncestors(cwd: string): string[] {
  const out = [cwd];
  for (let d = dirname(cwd); d !== out[out.length - 1]; d = dirname(d)) out.push(d);
  return out;
}

/**
 * A transcript stays in the folder of the directory the session started in, even
 * after Claude `cd`s into a subfolder (later entries then carry the subfolder as
 * their cwd). Returns `cwd`, or the parent folder whose encoded name is the
 * transcript's folder name, or undefined when neither matches.
 */
export function cwdForTranscriptDir(cwd: string, transcriptFile: string): string | undefined {
  // Without case: on Windows one folder can be "c--Users-…" (VS Code's drive letter) and another "C--Users-…".
  const dirName = basename(dirname(transcriptFile)).toLowerCase();
  return selfAndAncestors(cwd).find((d) => encodeProjectDirName(d).toLowerCase() === dirName);
}

/** `cwd`, or the nearest parent folder whose transcripts folder has this session; undefined when none does. */
export function findTranscriptCwd(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv): string | undefined {
  return selfAndAncestors(cwd).find((d) => existsSync(transcriptPathFor(d, sessionId, env)));
}

/** A session's transcript file, and the folder to run Claude in so that it finds it. */
export interface TranscriptLocation {
  file: string;
  cwd: string;
}

/**
 * Finds a session's transcript. The folder a chat was opened in is only the first
 * guess: Claude moves the transcript into a worktree's folder when the session
 * enters a git worktree, so `known` (where the session list found the file) comes
 * next. The folder to run in is the one whose encoded name is the file's folder.
 */
export function locateTranscript(
  sessionId: string,
  hints: readonly string[],
  known?: { filePath: string; cwd?: string },
  env?: NodeJS.ProcessEnv,
): TranscriptLocation | undefined {
  for (const hint of hints) {
    const d = findTranscriptCwd(hint, sessionId, env);
    if (d) return { file: transcriptPathFor(d, sessionId, env), cwd: d };
  }
  if (known && existsSync(known.filePath)) return { file: known.filePath, cwd: runCwdFor(known.filePath, [known.cwd, ...hints]) ?? known.cwd ?? hints[0] };
  return undefined;
}

/** The first of `candidates` (or a parent of one) whose transcripts folder holds `file`. */
export function runCwdFor(file: string, candidates: readonly (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    const d = c ? cwdForTranscriptDir(c, file) : undefined;
    if (d) return d;
  }
  return undefined;
}

/** Looks through every project folder for a session's transcript. */
export async function scanForTranscript(sessionId: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const root = projectsDir(env);
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const file = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
