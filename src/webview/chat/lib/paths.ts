/** Path helpers for display in the webview (no Node APIs here). */

export function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i >= 0 ? clean.slice(i + 1) : clean;
}

export function dirname(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i > 0 ? clean.slice(0, i) : '';
}

/** Home directory guessed from the cwd (/Users/name/…, /home/name/… or C:\Users\name\…). */
function guessHome(cwd: string): string | undefined {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)/.exec(cwd);
  return m?.[1];
}

/** "C:\…", "C:/…" or "\\server\share\…". */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * `dir`'s length when `p` is `dir` or inside it, else undefined. Windows paths
 * compare without regard to case or slash direction (Claude writes both C:\x and C:/x).
 */
function insideLength(p: string, dir: string): number | undefined {
  if (!dir) return undefined;
  const win = isWindowsPath(dir) || isWindowsPath(p);
  const norm = (s: string) => (win ? s.replace(/\//g, '\\').toLowerCase() : s);
  const a = norm(p);
  const d = norm(dir);
  if (a === d) return dir.length;
  const sep = win ? '\\' : '/';
  return a.startsWith(d + sep) ? dir.length : undefined;
}

/** Path relative to the session cwd when inside it, else ~-shortened absolute path. */
export function displayPath(p: string | undefined, cwd: string): string {
  if (!p) return '';
  const c = cwd.replace(/[\\/]+$/, '');
  const inCwd = insideLength(p, c);
  if (inCwd !== undefined) return p.length === inCwd ? '.' : p.slice(inCwd + 1);
  const home = guessHome(cwd);
  const inHome = home ? insideLength(p, home) : undefined;
  if (inHome !== undefined) return '~' + p.slice(inHome);
  return p;
}

const FILE_EXT = /\.[A-Za-z0-9_+-]{1,12}$/;
const KNOWN_BARE = /^(Makefile|Dockerfile|Gemfile|Rakefile|Procfile|LICENSE|README|CHANGELOG|Jenkinsfile|Brewfile)$/;

export interface PathRef {
  path: string;
  line?: number;
}

/**
 * Recognises strings that look like a file reference: `src/app.ts`, `./x.js:12`,
 * `/abs/path/file.py:10:4`, `package.json`. Returns undefined for anything that
 * looks like code, a URL or a sentence.
 */
export function parsePathRef(raw: string): PathRef | undefined {
  const s = raw.trim();
  if (!s || s.length > 300 || /\s/.test(s)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return undefined; // URL
  if (/[(){}<>;=`'"|$,!*?[\]]/.test(s)) return undefined; // code-ish
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(s);
  if (!m) return undefined;
  let path = m[1];
  const line = m[2] ? Number(m[2]) : undefined;
  // "#L12" GitHub-style anchors
  const anchor = /^(.*)#L(\d+)(?:-L?\d+)?$/.exec(path);
  if (anchor) {
    path = anchor[1];
    return looksLikeFile(path) ? { path, line: Number(anchor[2]) } : undefined;
  }
  return looksLikeFile(path) ? { path, line } : undefined;
}

function looksLikeFile(path: string): boolean {
  if (!path || /[\\/]$/.test(path)) return false;
  const hasDir = /[\\/]/.test(path);
  if (/^\.{1,2}$/.test(path)) return false;
  const name = basename(path);
  if (!name || name.startsWith('-')) return false;
  if (/^\d+(\.\d+)*$/.test(name)) return false; // version numbers like 1.2.3
  if (FILE_EXT.test(name)) {
    // Avoid things like "e.g" or "i.e" and plain domain names like "example.com" without a slash.
    if (!hasDir && /^[a-z]{1,3}\.[a-z]{1,3}$/i.test(name)) return false;
    if (!hasDir && /^(www\.)?[a-z0-9-]+\.(com|org|net|io|dev|ai|app|co)$/i.test(name)) return false;
    return true;
  }
  return KNOWN_BARE.test(name) && hasDir;
}

/** Link targets from markdown: decide whether a href is a web link or a local file. */
export function classifyHref(href: string): { kind: 'url'; url: string } | { kind: 'file'; ref: PathRef } | undefined {
  const h = href.trim();
  if (!h || h.startsWith('#')) return undefined;
  if (/^(https?|mailto|vscode|vscode-insiders):/i.test(h)) return { kind: 'url', url: h };
  if (/^file:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      // file:///C:/x has the path "/C:/x".
      const path = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
      const ref = parsePathRef(path + (u.hash || ''));
      return ref ? { kind: 'file', ref } : { kind: 'file', ref: { path } };
    } catch {
      return undefined;
    }
  }
  if (!isWindowsPath(h) && /^[a-z][a-z0-9+.-]*:/i.test(h)) return undefined; // other schemes (but not C:\): ignore
  let decoded = h;
  try {
    decoded = decodeURI(h);
  } catch {
    // keep raw
  }
  const ref = parsePathRef(decoded);
  if (ref) return { kind: 'file', ref };
  // Directory or extension-less path: still try to open it.
  if (/[\\/]/.test(decoded)) return { kind: 'file', ref: { path: decoded.replace(/#.*$/, '') } };
  return undefined;
}
