import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
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
  const dirName = basename(dirname(transcriptFile));
  return selfAndAncestors(cwd).find((d) => encodeProjectDirName(d) === dirName);
}

/** `cwd`, or the nearest parent folder whose transcripts folder has this session; undefined when none does. */
export function findTranscriptCwd(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv): string | undefined {
  return selfAndAncestors(cwd).find((d) => existsSync(transcriptPathFor(d, sessionId, env)));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
