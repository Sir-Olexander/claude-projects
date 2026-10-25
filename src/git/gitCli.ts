import { run, type ExecResult } from '../util/exec';
import { realPath } from '../util/paths';
import type { Worktree } from '../shared/types';

/**
 * Thin wrapper over the git CLI. Everything else in src/git builds on runGit.
 * Functions here never throw for git errors; they return undefined/[] instead,
 * because the views call them constantly for folders that may not be repos.
 */

let gitPath = 'git';
export function setGitPath(p: string | undefined): void {
  gitPath = p && p.trim() ? p : 'git';
}

export interface GitRunOptions {
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export async function runGit(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<ExecResult> {
  const env = {
    ...process.env,
    ...opts.env,
    // Never block on a credential or editor prompt from inside the extension.
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  try {
    return await run(gitPath, args, { cwd, env, timeoutMs: opts.timeoutMs ?? 30_000, input: opts.input, maxBuffer: opts.maxBuffer });
  } catch (err) {
    return { stdout: '', stderr: String((err as Error)?.message ?? err), code: 127 };
  }
}

/** Top-level directory of the worktree containing `path`, or undefined if not in a repo. */
export async function getRepoRoot(path: string): Promise<string | undefined> {
  const r = await runGit(path, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  const top = r.stdout.trim();
  return top ? realPath(top) : undefined;
}

/** Current branch name, or `undefined` when detached / not a repo. */
export async function getCurrentBranch(path: string): Promise<string | undefined> {
  const r = await runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 10_000 });
  if (r.code === 0) return r.stdout.trim() || undefined;
  return undefined;
}

/** Short HEAD hash, or undefined. */
export async function getHeadShort(path: string): Promise<string | undefined> {
  const r = await runGit(path, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

export function parseWorktreeList(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Partial<Worktree> & { path?: string } = {};
  const flush = () => {
    if (cur.path) {
      out.push({
        path: cur.path,
        branch: cur.branch,
        head: cur.head,
        detached: !!cur.detached,
        bare: !!cur.bare,
        locked: !!cur.locked,
        prunable: !!cur.prunable,
        isMain: out.length === 0,
      });
    }
    cur = {};
  };
  for (const raw of porcelain.split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    switch (key) {
      case 'worktree':
        if (cur.path) flush();
        cur.path = val;
        break;
      case 'HEAD':
        cur.head = val;
        break;
      case 'branch':
        cur.branch = val.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        cur.detached = true;
        break;
      case 'bare':
        cur.bare = true;
        break;
      case 'locked':
        cur.locked = true;
        break;
      case 'prunable':
        cur.prunable = true;
        break;
    }
  }
  flush();
  return out;
}

/** All worktrees of the repository containing `path` (main worktree first). [] when not a repo. */
export async function listWorktrees(path: string): Promise<Worktree[]> {
  const r = await runGit(path, ['worktree', 'list', '--porcelain'], { timeoutMs: 15_000 });
  if (r.code !== 0) return [];
  return parseWorktreeList(r.stdout).map((w) => ({ ...w, path: realPath(w.path) }));
}
