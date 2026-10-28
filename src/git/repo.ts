/**
 * Git operations for the Source Control and Files views. No vscode imports:
 * everything here runs (and is tested) in plain Node.
 *
 * Read functions never throw for git failures (they return undefined / []).
 * Mutating functions return the ExecResult; use `ensureOk` to turn a failure
 * into a GitError carrying git's stderr.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ExecResult } from '../util/exec';
import { realPath } from '../util/paths';
import { runGit } from './gitCli';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  parseNameStatusZ,
  parseStatusV2,
  type BranchInfo,
  type CommitFileChange,
  type CommitInfo,
  type ParsedStatus,
} from './parse';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Throws a GitError (message = git's stderr/stdout, trimmed) when the command failed. */
export function ensureOk(r: ExecResult, what: string): ExecResult {
  if (r.code === 0) return r;
  const detail = (r.stderr || r.stdout || '').trim();
  throw new GitError(detail ? `${what} failed: ${detail}` : `${what} failed (exit code ${r.code ?? 'killed'}).`, r.stderr, r.code);
}

const NETWORK_TIMEOUT = 5 * 60_000;
const SLOW_TIMEOUT = 2 * 60_000;

/** Paths per git invocation (keeps argv well under the OS limit). */
const PATH_CHUNK = 200;

async function chunked(cwd: string, base: string[], paths: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  let last: ExecResult = { stdout: '', stderr: '', code: 0 };
  for (let i = 0; i < paths.length; i += PATH_CHUNK) {
    last = await runGit(cwd, [...base, '--', ...paths.slice(i, i + PATH_CHUNK)], opts);
    if (last.code !== 0) return last;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

export interface RepoInfo {
  /** Top-level folder of this worktree. */
  root: string;
  /** This worktree's git dir (.git, or .git/worktrees/<name> for linked worktrees). */
  gitDir: string;
  /** The shared git dir (refs, objects, info/exclude). */
  commonDir: string;
  isLinkedWorktree: boolean;
}

export async function getRepoInfo(path: string): Promise<RepoInfo | undefined> {
  const r = await runGit(path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  const [top, gitDir, commonDir] = r.stdout.split('\n').map((s) => s.trim());
  if (!top || !gitDir) return undefined;
  const abs = (p: string) => realPath(isAbsolute(p) ? p : resolve(path, p));
  const g = abs(gitDir);
  const c = commonDir ? abs(commonDir) : g;
  return { root: realPath(top), gitDir: g, commonDir: c, isLinkedWorktree: g !== c };
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

/** In-progress operation, detected from marker files in the git dir. */
export function getRepoOperation(gitDir: string): RepoOperation | undefined {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert';
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect';
  return undefined;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getStatus(root: string, opts: { ignored?: boolean } = {}): Promise<ParsedStatus | undefined> {
  const args = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'];
  if (opts.ignored) args.push('--ignored=matching');
  const r = await runGit(root, args, { timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  return parseStatusV2(r.stdout);
}

export async function getBranches(root: string): Promise<BranchInfo[]> {
  const r = await runGit(root, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { timeoutMs: 20_000 });
  if (r.code !== 0) return [];
  // Git for Windows prints C:/x; spell worktree paths like the rest of the extension.
  return parseBranches(r.stdout).map((b) => (b.worktreePath ? { ...b, worktreePath: realPath(b.worktreePath) } : b));
}

export async function getLog(root: string, count = 30): Promise<CommitInfo[]> {
  const r = await runGit(root, ['log', `-n${count}`, `--format=${LOG_FORMAT}`, '--no-color'], { timeoutMs: 20_000 });
  if (r.code !== 0) return [];
  return parseLog(r.stdout);
}

/** Files changed by a commit (against its first parent; everything for a root commit). */
export async function getCommitFiles(root: string, commit: Pick<CommitInfo, 'hash' | 'parents'>): Promise<CommitFileChange[]> {
  const args =
    commit.parents.length === 0
      ? ['diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '-M', '--root', commit.hash]
      : ['diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '-M', commit.parents[0], commit.hash];
  const r = await runGit(root, args, { timeoutMs: 20_000 });
  if (r.code !== 0) return [];
  return parseNameStatusZ(r.stdout);
}

/**
 * Content of a file at a ref. ref '' = the index (stage 0), '~1'/'~2'/'~3' = merge stages,
 * otherwise any revision ("HEAD", a hash…). Undefined when the file does not exist there.
 */
export async function showFile(root: string, ref: string, relPath: string): Promise<string | undefined> {
  const spec = ref === '' ? `:${relPath}` : /^~[123]$/.test(ref) ? `:${ref[1]}:${relPath}` : `${ref}:${relPath}`;
  const r = await runGit(root, ['show', '--no-color', spec], { timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  return r.stdout;
}

export async function getRemotes(root: string): Promise<string[]> {
  const r = await runGit(root, ['remote'], { timeoutMs: 10_000 });
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `git check-ref-format --branch` — true when `name` is a valid new branch name. */
export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name.trim() || /\s/.test(name)) return false;
  const r = await runGit(cwd, ['check-ref-format', '--branch', name], { timeoutMs: 10_000 });
  return r.code === 0;
}

export async function isIgnored(root: string, relPath: string): Promise<boolean> {
  const r = await runGit(root, ['check-ignore', '-q', '--', relPath], { timeoutMs: 10_000 });
  return r.code === 0;
}

// ---------------------------------------------------------------------------
// Index / working tree
// ---------------------------------------------------------------------------

export function stage(root: string, relPaths: string[]): Promise<ExecResult> {
  return chunked(root, ['add', '-A'], relPaths);
}

export function stageAll(root: string): Promise<ExecResult> {
  return runGit(root, ['add', '-A']);
}

/** Unstage. `hasHead` false on a branch without commits (then `git rm --cached` is the only way). */
export function unstage(root: string, relPaths: string[], hasHead: boolean): Promise<ExecResult> {
  return hasHead ? chunked(root, ['restore', '--staged'], relPaths) : chunked(root, ['rm', '--cached', '-r', '-q'], relPaths);
}

export function unstageAll(root: string, hasHead: boolean): Promise<ExecResult> {
  return hasHead ? runGit(root, ['reset', '-q']) : runGit(root, ['rm', '--cached', '-r', '-q', '.']);
}

/** Restore tracked files in the working tree from the index (discard unstaged changes). */
export function discardTracked(root: string, relPaths: string[]): Promise<ExecResult> {
  return chunked(root, ['restore', '--worktree'], relPaths);
}

/** Undo `git add -N` (intent to add) so the file becomes untracked again. */
export function forgetIntentToAdd(root: string, relPaths: string[]): Promise<ExecResult> {
  return chunked(root, ['rm', '--cached', '-q', '--force'], relPaths);
}

export function commit(root: string, message: string, opts: { all?: boolean; amend?: boolean } = {}): Promise<ExecResult> {
  const args = ['commit', '--quiet', '--file', '-'];
  if (opts.all) args.push('--all');
  if (opts.amend) args.push('--amend');
  return runGit(root, args, { input: message, timeoutMs: SLOW_TIMEOUT });
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export function checkout(root: string, branch: string): Promise<ExecResult> {
  return runGit(root, ['checkout', '-q', branch], { timeoutMs: SLOW_TIMEOUT });
}

/** Create a local branch tracking `remoteBranch` ("origin/feature") and check it out. */
export function checkoutTracking(root: string, remoteBranch: string, localName: string): Promise<ExecResult> {
  return runGit(root, ['checkout', '-q', '-b', localName, '--track', remoteBranch], { timeoutMs: SLOW_TIMEOUT });
}

export function createBranch(root: string, name: string, opts: { checkout?: boolean; startPoint?: string } = {}): Promise<ExecResult> {
  const start = opts.startPoint ? [opts.startPoint] : [];
  return opts.checkout === false
    ? runGit(root, ['branch', name, ...start])
    : runGit(root, ['checkout', '-q', '-b', name, ...start], { timeoutMs: SLOW_TIMEOUT });
}

export function deleteBranch(root: string, name: string, force = false): Promise<ExecResult> {
  return runGit(root, ['branch', force ? '-D' : '-d', name]);
}

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

export function fetch(root: string): Promise<ExecResult> {
  return runGit(root, ['fetch', '--all', '--prune'], { timeoutMs: NETWORK_TIMEOUT });
}

export function pull(root: string): Promise<ExecResult> {
  return runGit(root, ['pull'], { timeoutMs: NETWORK_TIMEOUT });
}

export function push(root: string, setUpstream?: { remote: string; branch: string }): Promise<ExecResult> {
  return setUpstream
    ? runGit(root, ['push', '-u', setUpstream.remote, setUpstream.branch], { timeoutMs: NETWORK_TIMEOUT })
    : runGit(root, ['push'], { timeoutMs: NETWORK_TIMEOUT });
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export interface WorktreeAddOptions {
  /** Create this new branch for the worktree. */
  newBranch?: string;
  /** Check out this existing branch (local name, or "origin/x" with newBranch for tracking). */
  branch?: string;
  /** Start point for newBranch (default HEAD). */
  base?: string;
}

export function worktreeAdd(cwd: string, path: string, opts: WorktreeAddOptions): Promise<ExecResult> {
  const args = ['worktree', 'add'];
  if (opts.newBranch) {
    args.push('-b', opts.newBranch, path);
    if (opts.base) args.push(opts.base);
  } else {
    args.push(path);
    if (opts.branch) args.push(opts.branch);
  }
  return runGit(cwd, args, { timeoutMs: SLOW_TIMEOUT });
}

export function worktreeRemove(cwd: string, path: string, force = false): Promise<ExecResult> {
  return runGit(cwd, force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path], { timeoutMs: SLOW_TIMEOUT });
}

/**
 * Makes sure `pattern` (e.g. ".claude/worktrees/") is listed in <commonDir>/info/exclude.
 * Returns true when the file was changed.
 */
export async function ensureExcluded(commonDir: string, pattern: string): Promise<boolean> {
  const infoDir = join(commonDir, 'info');
  const file = join(infoDir, 'exclude');
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    // missing file is fine
  }
  const norm = (s: string) => s.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (current.split('\n').some((l) => norm(l) === norm(pattern))) return false;
  await mkdir(infoDir, { recursive: true });
  const prefix = current.length && !current.endsWith('\n') ? '\n' : '';
  await appendFile(file, `${prefix}# Claude Code worktrees\n${pattern}\n`);
  return true;
}

/** Extracts the worktree path from git's "already checked out at" style errors. */
export function parseCheckedOutElsewhere(stderr: string): string | undefined {
  const m = /(?:already checked out at|is already used by worktree at|already used by worktree at) '([^']+)'/.exec(stderr);
  return m ? realPath(m[1]) : undefined;
}
