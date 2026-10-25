import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorktrees, runGit } from '../../src/git/gitCli';
import { groupChanges, makeIgnoredLookup } from '../../src/git/parse';
import {
  checkout,
  commit,
  createBranch,
  deleteBranch,
  discardTracked,
  ensureExcluded,
  getBranches,
  getCommitFiles,
  getLog,
  getRepoInfo,
  getRepoOperation,
  getStatus,
  isIgnored,
  isValidBranchName,
  parseCheckedOutElsewhere,
  showFile,
  stage,
  stageAll,
  unstage,
  unstageAll,
  worktreeAdd,
  worktreeRemove,
} from '../../src/git/repo';

let base: string;
let repo: string;

async function git(cwd: string, ...args: string[]) {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function write(rel: string, content: string, root = repo) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cp-git-test-')));
  repo = join(base, 'repo');
  mkdirSync(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  write('a.txt', 'one\n');
  write('b.txt', 'bee\n');
  write('rename-me.txt', 'some content that is long enough to be detected as a rename\n');
  write('.gitignore', 'ignored-dir/\n*.log\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'Initial commit');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('repo discovery', () => {
  it('finds root, git dir and common dir', async () => {
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const info = await getRepoInfo(join(repo, 'sub'));
    expect(info).toMatchObject({ root: repo, gitDir: join(repo, '.git'), commonDir: join(repo, '.git'), isLinkedWorktree: false });
    expect(await getRepoInfo(base)).toBeUndefined();
    expect(getRepoOperation(join(repo, '.git'))).toBeUndefined();
  });
});

describe('status, staging and discarding', () => {
  it('reports staged, unstaged, untracked, renamed, deleted and ignored files', async () => {
    write('a.txt', 'one\ntwo\n'); // unstaged modify
    write('b.txt', 'bee\nbuzz\n');
    await git(repo, 'add', 'b.txt'); // staged modify
    await git(repo, 'mv', 'rename-me.txt', 'renamed.txt'); // staged rename
    write('new dir/untracked.txt', 'hi\n'); // untracked inside a new dir (with a space)
    write('ignored-dir/x.js', 'x');
    write('debug.log', 'log');

    const st = await getStatus(repo, { ignored: true });
    expect(st).toBeDefined();
    expect(st!.branch.head).toBe('main');
    const g = groupChanges(st!.entries);
    expect(g.unstaged.map((c) => [c.path, c.status])).toEqual([['a.txt', 'M']]);
    expect(g.staged.map((c) => [c.path, c.status, c.origPath])).toEqual([
      ['b.txt', 'M', undefined],
      ['renamed.txt', 'R', 'rename-me.txt'],
    ]);
    expect(g.untracked.map((c) => c.path)).toEqual(['new dir/untracked.txt']);
    const ignored = makeIgnoredLookup(st!.ignored);
    expect(ignored('ignored-dir/x.js')).toBe(true);
    expect(ignored('debug.log')).toBe(true);
    expect(ignored('a.txt')).toBe(false);
    expect(await isIgnored(repo, 'debug.log')).toBe(true);
    expect(await isIgnored(repo, 'a.txt')).toBe(false);
  });

  it('shows file content at HEAD and in the index', async () => {
    expect(await showFile(repo, 'HEAD', 'b.txt')).toBe('bee\n');
    expect(await showFile(repo, '', 'b.txt')).toBe('bee\nbuzz\n');
    expect(await showFile(repo, 'HEAD', 'does-not-exist.txt')).toBeUndefined();
    expect(await showFile(repo, '', 'new dir/untracked.txt')).toBeUndefined();
  });

  it('stages, unstages and discards', async () => {
    let r = await stage(repo, ['a.txt', 'new dir/untracked.txt']);
    expect(r.code).toBe(0);
    let g = groupChanges((await getStatus(repo))!.entries);
    expect(g.staged.map((c) => c.path)).toContain('a.txt');
    expect(g.staged.map((c) => c.path)).toContain('new dir/untracked.txt');

    r = await unstage(repo, ['a.txt', 'new dir/untracked.txt'], true);
    expect(r.code).toBe(0);
    g = groupChanges((await getStatus(repo))!.entries);
    expect(g.unstaged.map((c) => c.path)).toEqual(['a.txt']);
    expect(g.untracked.map((c) => c.path)).toEqual(['new dir/untracked.txt']);

    r = await discardTracked(repo, ['a.txt']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n');

    expect((await stageAll(repo)).code).toBe(0);
    expect(groupChanges((await getStatus(repo))!.entries).unstaged).toHaveLength(0);
    expect((await unstageAll(repo, true)).code).toBe(0);
    expect(groupChanges((await getStatus(repo))!.entries).staged).toHaveLength(0);
  });

  it('stages a deleted file', async () => {
    rmSync(join(repo, 'b.txt'));
    let g = groupChanges((await getStatus(repo))!.entries);
    expect(g.unstaged.find((c) => c.path === 'b.txt')?.status).toBe('D');
    expect((await stage(repo, ['b.txt'])).code).toBe(0);
    g = groupChanges((await getStatus(repo))!.entries);
    expect(g.staged.find((c) => c.path === 'b.txt')?.status).toBe('D');
    // restore for later tests
    await unstage(repo, ['b.txt'], true);
    await discardTracked(repo, ['b.txt']);
    expect(existsSync(join(repo, 'b.txt'))).toBe(true);
  });

  it('commits with a multi-line message and lists commit files', async () => {
    await stageAll(repo);
    const r = await commit(repo, 'Second commit\n\nWith a body line.');
    expect(r.code).toBe(0);
    const log = await getLog(repo, 10);
    expect(log[0].subject).toBe('Second commit');
    expect(log[0].body).toBe('With a body line.');
    expect(log[1].subject).toBe('Initial commit');
    const files = await getCommitFiles(repo, log[0]);
    expect(files).toContainEqual({ status: 'R', path: 'renamed.txt', origPath: 'rename-me.txt' });
    expect(files).toContainEqual({ status: 'A', path: 'new dir/untracked.txt' });
    const rootFiles = await getCommitFiles(repo, log[1]);
    expect(rootFiles.map((f) => f.path).sort()).toEqual(['.gitignore', 'a.txt', 'b.txt', 'rename-me.txt']);
    expect(await showFile(repo, log[1].hash, 'rename-me.txt')).toContain('some content');
  });
});

describe('branches', () => {
  it('lists branches with ahead/behind against a local upstream', async () => {
    expect(await isValidBranchName(repo, 'feature/x')).toBe(true);
    expect(await isValidBranchName(repo, 'bad name')).toBe(false);
    expect(await isValidBranchName(repo, 'bad..name')).toBe(false);

    expect((await createBranch(repo, 'feature/x')).code).toBe(0);
    await git(repo, 'branch', '--set-upstream-to=main');
    write('feature.txt', 'f\n');
    await stageAll(repo);
    await commit(repo, 'Feature work');
    const branches = await getBranches(repo);
    const fx = branches.find((b) => b.name === 'feature/x')!;
    expect(fx).toMatchObject({ isCurrent: true, upstream: 'main', ahead: 1, behind: 0, subject: 'Feature work' });
    const st = await getStatus(repo);
    expect(st!.branch).toMatchObject({ head: 'feature/x', upstream: 'main', ahead: 1, behind: 0 });

    expect((await checkout(repo, 'main')).code).toBe(0);
    const unmerged = await deleteBranch(repo, 'feature/x');
    expect(unmerged.code).not.toBe(0);
    expect(unmerged.stderr).toMatch(/not fully merged/);
    expect((await deleteBranch(repo, 'feature/x', true)).code).toBe(0);
  });

  it('detects conflicts after a failed merge', async () => {
    await createBranch(repo, 'conflicting');
    write('a.txt', 'theirs\n');
    await stageAll(repo);
    await commit(repo, 'Change on branch');
    await checkout(repo, 'main');
    write('a.txt', 'ours\n');
    await stageAll(repo);
    await commit(repo, 'Change on main');
    const merge = await runGit(repo, ['merge', 'conflicting']);
    expect(merge.code).not.toBe(0);
    const g = groupChanges((await getStatus(repo))!.entries);
    expect(g.conflicts.map((c) => [c.path, c.status])).toEqual([['a.txt', 'UU']]);
    expect(getRepoOperation(join(repo, '.git'))).toBe('merge');
    expect(await showFile(repo, '~2', 'a.txt')).toBe('ours\n');
    expect(await showFile(repo, '~3', 'a.txt')).toBe('theirs\n');
    await git(repo, 'merge', '--abort');
    expect(getRepoOperation(join(repo, '.git'))).toBeUndefined();
  });
});

describe('worktrees', () => {
  it('adds, lists and removes worktrees and keeps them excluded', async () => {
    const wtPath = join(repo, '.claude', 'worktrees', 'wt-one');
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
    expect(await ensureExcluded(join(repo, '.git'), '.claude/worktrees/')).toBe(true);
    expect(await ensureExcluded(join(repo, '.git'), '.claude/worktrees/')).toBe(false);
    const r = await worktreeAdd(repo, wtPath, { newBranch: 'wt-one' });
    expect(r.code).toBe(0);

    const list = await listWorktrees(repo);
    expect(list.map((w) => [w.path, w.branch, w.isMain])).toEqual([
      [repo, 'main', true],
      [wtPath, 'wt-one', false],
    ]);
    // The worktree folder must not show up as untracked in the main repo.
    const g = groupChanges((await getStatus(repo))!.entries);
    expect(g.untracked.find((c) => c.path.startsWith('.claude/'))).toBeUndefined();

    const info = await getRepoInfo(wtPath);
    expect(info).toMatchObject({ root: wtPath, commonDir: join(repo, '.git'), isLinkedWorktree: true });

    const branches = await getBranches(repo);
    expect(branches.find((b) => b.name === 'wt-one')?.worktreePath).toBe(wtPath);
    const co = await checkout(repo, 'wt-one');
    expect(co.code).not.toBe(0);
    expect(parseCheckedOutElsewhere(co.stderr)).toBe(wtPath);

    write('dirty.txt', 'x', wtPath);
    const rm = await worktreeRemove(repo, wtPath);
    expect(rm.code).not.toBe(0);
    expect((await worktreeRemove(repo, wtPath, true)).code).toBe(0);
    expect((await listWorktrees(repo)).length).toBe(1);
  });
});
