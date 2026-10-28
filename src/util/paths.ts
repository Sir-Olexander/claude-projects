import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/**
 * One spelling per folder on Windows: an upper-case drive letter. VS Code's
 * Uri.fsPath gives "c:\…" while the file system, git and Claude Code give "C:\…",
 * and paths are compared as strings all over the extension.
 */
export function normalizeDrive(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

/** A file: Uri's path, spelled the way the rest of the extension spells paths. */
export function fsPathOf(uri: { fsPath: string }): string {
  return normalizeDrive(uri.fsPath);
}

/**
 * Resolves symlinks when the path exists; otherwise returns it normalized.
 *
 * On Windows the path is only normalized (slashes, drive letter): resolving
 * would turn junctions, subst and mapped drives into other paths (Z:\x into
 * \\server\share\x), while Claude Code keeps the path it was started in, and
 * sessions are matched to projects by that path.
 */
export function realPath(p: string): string {
  if (process.platform === 'win32') return normalizeDrive(resolve(p));
  try {
    return normalizeDrive(realpathSync.native(p));
  } catch {
    return normalizeDrive(normalize(p));
  }
}

/** Removes a trailing separator (except for the filesystem root, "/" or "C:\\"). */
export function stripTrailingSep(p: string): string {
  if (/^[A-Za-z]:[\\/]$/.test(p)) return p;
  if (p.length > 1 && (p.endsWith('/') || p.endsWith(sep))) return p.slice(0, -1);
  return p;
}

/** True when `child` is `parent` or inside it. Both should be absolute and normalized. */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = stripTrailingSep(child);
  const p = stripTrailingSep(parent);
  if (c === p) return true;
  const rel = relative(p, c);
  // On Windows relative() ignores case, so "" also means the same folder.
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || (sep === '\\' && p.startsWith('~\\'))) return join(homedir(), p.slice(2));
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

/**
 * True when the folder is, or sits inside, a hidden (dot) folder, such as an app's
 * `.data/…/work/dsk-…` scratch folders or `.claude/worktrees/…`. Those hold Claude
 * sessions run by tools, not projects the user opens.
 */
export function isInHiddenFolder(p: string): boolean {
  return p.split(/[\\/]+/).some((part) => part.length > 1 && part.startsWith('.') && part !== '..');
}
