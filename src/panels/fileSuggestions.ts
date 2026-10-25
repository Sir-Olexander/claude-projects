import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { runGit } from '../git/gitCli';

interface CacheEntry {
  at: number;
  files: string[];
  dirs: string[];
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;
const MAX_FILES = 50_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'Pods', 'DerivedData', '.dart_tool']);

async function listFiles(cwd: string): Promise<CacheEntry> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  let files: string[] = [];
  const r = await runGit(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeoutMs: 8000, maxBuffer: 64 * 1024 * 1024 });
  if (r.code === 0) {
    files = r.stdout.split('\0').filter(Boolean).slice(0, MAX_FILES);
  } else {
    files = await walk(cwd);
  }
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const d = f.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = d.lastIndexOf('/');
    }
  }
  const entry = { at: Date.now(), files, dirs: [...dirs] };
  cache.set(cwd, entry);
  return entry;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length && out.length < 20_000) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(p);
      } else out.push(relative(root, p));
    }
  }
  return out;
}

/** Scores a path against a query: higher is better, -1 means no match. */
export function scorePath(path: string, query: string): number {
  if (!query) return 1;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base === q) return 1000 - p.length;
  if (base.startsWith(q)) return 800 - p.length;
  if (base.includes(q)) return 600 - p.length;
  if (p.includes(q)) return 400 - p.length;
  // subsequence match
  let i = 0;
  let gaps = 0;
  for (const ch of p) {
    if (ch === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return 200 - gaps - p.length / 10;
  }
  return -1;
}

/** @-mention autocomplete for a session's folder. */
export async function fileSuggestions(cwd: string, query: string, limit = 40): Promise<{ path: string; isDirectory: boolean }[]> {
  const { files, dirs } = await listFiles(cwd);
  const q = query.replace(/^@/, '').trim();
  const scored: { path: string; isDirectory: boolean; score: number }[] = [];
  for (const d of dirs) {
    const s = scorePath(d, q);
    if (s >= 0) scored.push({ path: d + '/', isDirectory: true, score: s + 5 });
  }
  for (const f of files) {
    const s = scorePath(f, q);
    if (s >= 0) scored.push({ path: f, isDirectory: false, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map(({ path, isDirectory }) => ({ path, isDirectory }));
}
