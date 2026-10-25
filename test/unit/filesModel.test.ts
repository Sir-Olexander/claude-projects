import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExcludeMatcher, compareEntries, listDirectory, type DirEntry } from '../../src/views/files/fsModel';

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-files-test-')));
  for (const d of ['src', 'node_modules/pkg', '.git', 'docs', 'Assets']) mkdirSync(join(root, d), { recursive: true });
  for (const f of ['file10.txt', 'file2.txt', 'README.md', '.DS_Store', 'app.ts', 'app.js', 'lone.js', '.env']) writeFileSync(join(root, f), '');
  symlinkSync(join(root, 'docs'), join(root, 'docs-link'));
  symlinkSync(join(root, 'missing'), join(root, 'broken-link'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('compareEntries', () => {
  it('puts folders first and sorts naturally, case-insensitively', () => {
    const e = (name: string, isDirectory = false): DirEntry => ({ name, path: name, isDirectory, isSymlink: false });
    const sorted = [e('b.txt'), e('Zeta', true), e('file10'), e('alpha', true), e('file2'), e('A.txt')].sort(compareEntries).map((x) => x.name);
    expect(sorted).toEqual(['alpha', 'Zeta', 'A.txt', 'b.txt', 'file2', 'file10']);
  });
});

describe('buildExcludeMatcher', () => {
  it('honours globs, false values and when-clauses', () => {
    const m = buildExcludeMatcher({ '**/.git': true, '**/.DS_Store': true, '**/node_modules': false, '**/*.js': { when: '$(basename).ts' }, build: true });
    const siblings = new Set(['app.ts', 'app.js', 'lone.js']);
    expect(m('.git', siblings)).toBe(true);
    expect(m('packages/x/.git', siblings)).toBe(true);
    expect(m('node_modules', siblings)).toBe(false);
    expect(m('app.js', siblings)).toBe(true);
    expect(m('lone.js', siblings)).toBe(false);
    expect(m('build', siblings)).toBe(true);
    expect(m('src/build', siblings)).toBe(false);
    expect(buildExcludeMatcher(undefined)('anything', siblings)).toBe(false);
  });
});

describe('listDirectory', () => {
  it('lists with exclusions, symlinked folders and a limit', async () => {
    const exclude = buildExcludeMatcher({ '**/.git': true, '**/.DS_Store': true, '**/*.js': { when: '$(basename).ts' } });
    const { entries, total } = await listDirectory(root, { root, exclude });
    expect(entries.map((e) => (e.isDirectory ? e.name + '/' : e.name))).toEqual([
      'Assets/',
      'docs/',
      'docs-link/',
      'node_modules/',
      'src/',
      '.env',
      'app.ts',
      'broken-link',
      'file2.txt',
      'file10.txt',
      'lone.js',
      'README.md',
    ]);
    expect(total).toBe(12);
    expect(entries.find((e) => e.name === 'docs-link')?.isSymlink).toBe(true);

    const limited = await listDirectory(root, { root, exclude, limit: 3 });
    expect(limited.entries).toHaveLength(3);
    expect(limited.total).toBe(12);

    const nested = await listDirectory(join(root, 'node_modules'), { root, exclude });
    expect(nested.entries.map((e) => e.name)).toEqual(['pkg']);
  });
});
