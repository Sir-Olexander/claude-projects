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

/** Home directory guessed from the cwd (/Users/name/... or /home/name/...). */
function guessHome(cwd: string): string | undefined {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(cwd);
  return m?.[1];
}

/** Path relative to the session cwd when inside it, else ~-shortened absolute path. */
export function displayPath(p: string | undefined, cwd: string): string {
  if (!p) return '';
  const c = cwd.replace(/\/+$/, '');
  if (p === c) return '.';
  if (c && p.startsWith(c + '/')) return p.slice(c.length + 1);
  const home = guessHome(cwd);
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
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
  if (!path || path.endsWith('/')) return false;
  if (/^\.{1,2}$/.test(path)) return false;
  const name = basename(path);
  if (!name || name.startsWith('-')) return false;
  if (/^\d+(\.\d+)*$/.test(name)) return false; // version numbers like 1.2.3
  if (FILE_EXT.test(name)) {
    // Avoid things like "e.g" or "i.e" and plain domain names like "example.com" without a slash.
    if (!path.includes('/') && /^[a-z]{1,3}\.[a-z]{1,3}$/i.test(name)) return false;
    if (!path.includes('/') && /^(www\.)?[a-z0-9-]+\.(com|org|net|io|dev|ai|app|co)$/i.test(name)) return false;
    return true;
  }
  return KNOWN_BARE.test(name) && path.includes('/');
}

/** Link targets from markdown: decide whether a href is a web link or a local file. */
export function classifyHref(href: string): { kind: 'url'; url: string } | { kind: 'file'; ref: PathRef } | undefined {
  const h = href.trim();
  if (!h || h.startsWith('#')) return undefined;
  if (/^(https?|mailto|vscode|vscode-insiders):/i.test(h)) return { kind: 'url', url: h };
  if (/^file:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      const ref = parsePathRef(decodeURIComponent(u.pathname) + (u.hash || ''));
      return ref ? { kind: 'file', ref } : { kind: 'file', ref: { path: decodeURIComponent(u.pathname) } };
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return undefined; // other schemes: ignore
  let decoded = h;
  try {
    decoded = decodeURI(h);
  } catch {
    // keep raw
  }
  const ref = parsePathRef(decoded);
  if (ref) return { kind: 'file', ref };
  // Directory or extension-less path: still try to open it.
  if (decoded.includes('/')) return { kind: 'file', ref: { path: decoded.replace(/#.*$/, '') } };
  return undefined;
}
