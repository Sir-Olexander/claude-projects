/**
 * Directory listing for the Files view: sorting like the Explorer (folders
 * first, natural order) and `files.exclude` matching. No vscode imports.
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import picomatch from 'picomatch';

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** Shape of the `files.exclude` setting. */
export type ExcludeConfig = Record<string, boolean | { when?: string } | null | undefined>;

/** (repo/root-relative posix path, names of the siblings in the same folder) => excluded? */
export type ExcludeMatcher = (relPath: string, siblingNames: ReadonlySet<string>) => boolean;

export function buildExcludeMatcher(config: ExcludeConfig | undefined): ExcludeMatcher {
  const rules: { isMatch: (p: string) => boolean; when?: string }[] = [];
  for (const [pattern, value] of Object.entries(config ?? {})) {
    if (!value || !pattern) continue;
    try {
      rules.push({
        isMatch: picomatch(pattern, { dot: true }),
        when: typeof value === 'object' && typeof value.when === 'string' ? value.when : undefined,
      });
    } catch {
      // invalid glob in settings: ignore it like VS Code does
    }
  }
  if (!rules.length) return () => false;
  return (rel, siblings) => {
    for (const r of rules) {
      if (!r.isMatch(rel)) continue;
      if (!r.when) return true;
      const name = basename(rel);
      const stem = name.slice(0, name.length - extname(name).length);
      if (siblings.has(r.when.replace(/\$\(basename\)/g, stem))) return true;
    }
    return false;
  };
}

export function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return c !== 0 ? c : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function toPosixRelative(root: string, p: string): string {
  const rel = relative(root, p);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

export interface ListResult {
  entries: DirEntry[];
  /** Entries before the limit was applied (after exclusion). */
  total: number;
}

/**
 * Lists `dir`, hiding excluded entries, sorted folders-first. Symlinks to
 * folders count as folders. Returns at most `limit` entries.
 */
export async function listDirectory(dir: string, opts: { root: string; exclude?: ExcludeMatcher; limit?: number }): Promise<ListResult> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const names = new Set(dirents.map((d) => d.name));
  const entries: DirEntry[] = [];
  await Promise.all(
    dirents.map(async (d) => {
      const path = join(dir, d.name);
      if (opts.exclude && opts.exclude(toPosixRelative(opts.root, path), names)) return;
      let isDirectory = d.isDirectory();
      const isSymlink = d.isSymbolicLink();
      if (isSymlink) {
        try {
          isDirectory = (await stat(path)).isDirectory();
        } catch {
          isDirectory = false; // broken link
        }
      }
      entries.push({ name: d.name, path, isDirectory, isSymlink });
    }),
  );
  entries.sort(compareEntries);
  const limit = opts.limit ?? Infinity;
  return { entries: entries.length > limit ? entries.slice(0, limit) : entries, total: entries.length };
}
