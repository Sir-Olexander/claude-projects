import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { isSameOrInside } from '../../util/paths';
import type { FileNode } from './FilesTreeProvider';

export type TransferMode = 'move' | 'copy';

/** "report.md" → "report copy.md", then "report copy 2.md", … (for copies into the same folder). */
export function copyName(destDir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const suffix = ext && ext !== name ? ext : '';
  for (let i = 1; ; i++) {
    const candidate = `${stem} copy${i > 1 ? ` ${i}` : ''}${suffix}`;
    if (!exists(join(destDir, candidate))) return candidate;
  }
}

/**
 * Why a source can't go into destDir, or undefined when it can. Moving a
 * folder into itself (or one of its subfolders) is refused, and a move into
 * the folder it is already in does nothing.
 */
export function transferProblem(source: string, destDir: string, mode: TransferMode): string | undefined {
  if (isSameOrInside(destDir, source)) return `"${basename(source)}" can't go inside itself.`;
  if (mode === 'move' && dirname(source) === destDir) return 'already there';
  return undefined;
}

/** Folder that a drop on `target` lands in: the folder itself, a file's folder, or the root for empty space. */
export function dropFolder(target: FileNode | undefined, root: string): string {
  if (!target) return root;
  if (target.kind === 'more') return target.path;
  return target.isDirectory ? target.path : dirname(target.path);
}

