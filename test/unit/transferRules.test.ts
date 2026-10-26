import { describe, expect, it } from 'vitest';
import { copyName, dropFolder, transferProblem } from '../../src/views/files/transferRules';
import type { FileNode } from '../../src/views/files/FilesTreeProvider';

const entry = (path: string, isDirectory: boolean): FileNode => ({ kind: 'entry', path, name: path.split('/').pop()!, isDirectory, isSymlink: false });

describe('Files view transfer rules', () => {
  it('names copies like the Explorer', () => {
    const taken = new Set(['/p/report copy.md']);
    expect(copyName('/p', 'report.md', () => false)).toBe('report copy.md');
    expect(copyName('/p', 'report.md', (p) => taken.has(p))).toBe('report copy 2.md');
    expect(copyName('/p', 'assets', () => false)).toBe('assets copy');
    expect(copyName('/p', '.env', () => false)).toBe('.env copy');
  });

  it('refuses a folder into itself and ignores a move to where it already is', () => {
    expect(transferProblem('/p/src', '/p/src/lib', 'move')).toMatch(/inside itself/);
    expect(transferProblem('/p/src', '/p/src', 'copy')).toMatch(/inside itself/);
    expect(transferProblem('/p/src/a.ts', '/p/src', 'move')).toBe('already there');
    expect(transferProblem('/p/src/a.ts', '/p/src', 'copy')).toBeUndefined();
    expect(transferProblem('/p/src/a.ts', '/p/docs', 'move')).toBeUndefined();
    expect(transferProblem('/p/src', '/p/src-old', 'move')).toBeUndefined();
  });

  it('drops into the folder, a file’s folder, or the root', () => {
    expect(dropFolder(entry('/p/docs', true), '/p')).toBe('/p/docs');
    expect(dropFolder(entry('/p/docs/a.md', false), '/p')).toBe('/p/docs');
    expect(dropFolder(undefined, '/p')).toBe('/p');
    expect(dropFolder({ kind: 'more', path: '/p/big', name: '', isDirectory: false, isSymlink: false, hidden: 5 }, '/p')).toBe('/p/big');
  });
});
