import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';

/** Resolves symlinks when the path exists; otherwise returns it normalized. */
export function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return normalize(p);
  }
}

/** Removes a trailing separator (except for the filesystem root). */
export function stripTrailingSep(p: string): string {
  if (p.length > 1 && (p.endsWith('/') || p.endsWith(sep))) return p.slice(0, -1);
  return p;
}

/** True when `child` is `parent` or inside it. Both should be absolute and normalized. */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = stripTrailingSep(child);
  const p = stripTrailingSep(parent);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Replaces the home directory with ~ for display. */
export function tildify(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length);
  return p;
}

export function folderName(p: string): string {
  return basename(stripTrailingSep(p)) || p;
}
