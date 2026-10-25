import { describe, expect, it } from 'vitest';
import {
  changeLabel,
  changeLetter,
  FS,
  groupChanges,
  makeIgnoredLookup,
  parseAheadBehind,
  parseBranches,
  parseLog,
  parseNameStatusZ,
  parseStatusV2,
  RS,
} from '../../src/git/parse';

describe('parseStatusV2', () => {
  it('parses branch headers', () => {
    const out = ['# branch.oid 1234abcd', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3', ''].join('\0');
    const s = parseStatusV2(out);
    expect(s.branch).toEqual({ oid: '1234abcd', head: 'main', upstream: 'origin/main', ahead: 2, behind: 3, detached: false, initial: false });
  });

  it('handles initial and detached states', () => {
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0').branch.initial).toBe(true);
    expect(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0').branch.detached).toBe(true);
  });

  it('parses ordinary, rename, unmerged, untracked and ignored entries (paths with spaces)', () => {
    const out = [
      '1 .M N... 100644 100644 100644 aaa aaa src/a file.ts',
      '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
      '1 MM N... 100644 100644 100644 aaa bbb both.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? new dir/untracked.txt',
      '! node_modules/',
      '',
    ].join('\0');
    const s = parseStatusV2(out);
    expect(s.entries.map((e) => [e.kind, e.x + e.y, e.path, e.origPath])).toEqual([
      ['ordinary', '.M', 'src/a file.ts', undefined],
      ['ordinary', 'M.', 'staged.ts', undefined],
      ['ordinary', 'MM', 'both.ts', undefined],
      ['rename', 'R.', 'new name.ts', 'old name.ts'],
      ['unmerged', 'UU', 'conflict.ts', undefined],
      ['untracked', '??', 'new dir/untracked.txt', undefined],
    ]);
    expect(s.ignored).toEqual(['node_modules/']);

    const g = groupChanges(s.entries);
    expect(g.staged.map((c) => [c.path, c.status, c.origPath])).toEqual([
      ['both.ts', 'M', undefined],
      ['new name.ts', 'R', 'old name.ts'],
      ['staged.ts', 'M', undefined],
    ]);
    expect(g.unstaged.map((c) => [c.path, c.status])).toEqual([
      ['both.ts', 'M'],
      ['src/a file.ts', 'M'],
    ]);
    expect(g.untracked.map((c) => c.path)).toEqual(['new dir/untracked.txt']);
    expect(g.conflicts.map((c) => [c.path, c.status])).toEqual([['conflict.ts', 'UU']]);
  });

  it('labels changes like VS Code', () => {
    expect(changeLetter({ group: 'untracked', status: '?' })).toBe('U');
    expect(changeLetter({ group: 'conflict', status: 'UU' })).toBe('!');
    expect(changeLetter({ group: 'staged', status: 'R' })).toBe('R');
    expect(changeLabel({ group: 'staged', status: 'A' })).toBe('Index Added');
    expect(changeLabel({ group: 'unstaged', status: 'D' })).toBe('Deleted');
    expect(changeLabel({ group: 'conflict', status: 'UU' })).toBe('Both modified');
  });
});

describe('parseBranches', () => {
  it('parses local and remote branches and skips origin/HEAD', () => {
    const line = (...f: string[]) => f.join(FS);
    const out = [
      line('*', 'refs/heads/main', 'main', 'origin/main', 'ahead 1, behind 2', 'abc1234', '1700000000', '', 'Fix the thing'),
      line(' ', 'refs/heads/feature', 'feature', '', '', 'def5678', '1700000100', '/tmp/wt/feature', 'Add feature'),
      line(' ', 'refs/heads/old', 'old', 'origin/old', 'gone', 'aaa0000', '1600000000', '', 'Old'),
      line(' ', 'refs/remotes/origin/HEAD', 'origin', '', '', 'abc1234', '1700000000', '', 'Fix the thing'),
      line(' ', 'refs/remotes/origin/main', 'origin/main', '', '', 'abc1234', '1700000000', '', 'Fix the thing'),
      '',
    ].join('\n');
    const b = parseBranches(out);
    expect(b.map((x) => x.name)).toEqual(['main', 'feature', 'old', 'origin/main']);
    expect(b[0]).toMatchObject({ isCurrent: true, upstream: 'origin/main', ahead: 1, behind: 2, hash: 'abc1234', subject: 'Fix the thing', committerDate: 1700000000000 });
    expect(b[1]).toMatchObject({ isCurrent: false, worktreePath: '/tmp/wt/feature', upstream: undefined });
    expect(b[2].upstreamGone).toBe(true);
    expect(b[3]).toMatchObject({ isRemote: true, remote: 'origin' });
  });

  it('parses ahead/behind track strings', () => {
    expect(parseAheadBehind('ahead 3')).toEqual({ ahead: 3, behind: 0 });
    expect(parseAheadBehind('behind 1')).toEqual({ ahead: 0, behind: 1 });
    expect(parseAheadBehind('')).toEqual({});
    expect(parseAheadBehind('gone')).toEqual({ gone: true });
  });
});

describe('parseLog', () => {
  it('parses records with multi-line bodies', () => {
    const rec = (...f: string[]) => f.join(FS) + RS;
    const out =
      rec('a'.repeat(40), 'aaaaaaa', 'b'.repeat(40), 'Alex', 'alex@example.com', '1700000000', 'Subject one', 'Body line 1\n\nBody line 2\n') +
      '\n' +
      rec('b'.repeat(40), 'bbbbbbb', '', 'Sam', 'sam@example.com', '1690000000', 'Initial commit', '');
    const log = parseLog(out);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ short: 'aaaaaaa', parents: ['b'.repeat(40)], author: 'Alex', subject: 'Subject one', body: 'Body line 1\n\nBody line 2', date: 1700000000000 });
    expect(log[1].parents).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('parses renames and plain changes', () => {
    const out = ['M', 'src/a.ts', 'R087', 'old.ts', 'new.ts', 'A', 'added file.txt', 'D', 'gone.txt', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'new.ts', origPath: 'old.ts' },
      { status: 'A', path: 'added file.txt' },
      { status: 'D', path: 'gone.txt' },
    ]);
  });
});

describe('makeIgnoredLookup', () => {
  it('matches ignored files, directories and their descendants', () => {
    const isIgnored = makeIgnoredLookup(['node_modules/', 'build/out/', '.env']);
    expect(isIgnored('node_modules')).toBe(true);
    expect(isIgnored('node_modules/react/index.js')).toBe(true);
    expect(isIgnored('build/out/x.js')).toBe(true);
    expect(isIgnored('build')).toBe(false);
    expect(isIgnored('.env')).toBe(true);
    expect(isIgnored('src/.env')).toBe(false);
    expect(makeIgnoredLookup([])('anything')).toBe(false);
  });
});
