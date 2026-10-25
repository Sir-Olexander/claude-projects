/**
 * Parsers for git's machine-readable output. Pure functions, no I/O, no vscode,
 * so they can be unit-tested in plain Node.
 */

// ---------------------------------------------------------------------------
// git status --porcelain=v2 -z --branch [--ignored=matching] [-uall]
// ---------------------------------------------------------------------------

export interface StatusBranch {
  /** Commit hash of HEAD; undefined on an unborn branch (no commits yet). */
  oid?: string;
  /** Branch name; undefined when detached. */
  head?: string;
  detached: boolean;
  /** True when the branch has no commits yet. */
  initial: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export type StatusEntryKind = 'ordinary' | 'rename' | 'unmerged' | 'untracked' | 'ignored';

export interface StatusEntry {
  kind: StatusEntryKind;
  /** Repo-relative path, forward slashes. Ignored directories end with "/". */
  path: string;
  /** Previous path for renames/copies. */
  origPath?: string;
  /** Index status letter ('.' = unchanged). */
  x: string;
  /** Working tree status letter ('.' = unchanged). */
  y: string;
  submodule: boolean;
}

export interface ParsedStatus {
  branch: StatusBranch;
  entries: StatusEntry[];
  /** Ignored paths (directories end with "/"). */
  ignored: string[];
}

export function parseStatusV2(output: string): ParsedStatus {
  const branch: StatusBranch = { detached: false, initial: false };
  const entries: StatusEntry[] = [];
  const ignored: string[] = [];
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const c = t[0];
    if (c === '#') {
      const m = /^# (branch\.\w+|stash) (.*)$/.exec(t);
      if (!m) continue;
      const [, key, val] = m;
      switch (key) {
        case 'branch.oid':
          if (val === '(initial)') branch.initial = true;
          else branch.oid = val;
          break;
        case 'branch.head':
          if (val === '(detached)') branch.detached = true;
          else branch.head = val;
          break;
        case 'branch.upstream':
          branch.upstream = val;
          break;
        case 'branch.ab': {
          const ab = /^\+(\d+) -(\d+)$/.exec(val);
          if (ab) {
            branch.ahead = Number(ab[1]);
            branch.behind = Number(ab[2]);
          }
          break;
        }
      }
      continue;
    }
    if (c === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = t.split(' ');
      if (parts.length < 9) continue;
      entries.push({
        kind: 'ordinary',
        x: parts[1][0],
        y: parts[1][1],
        submodule: parts[2][0] === 'S',
        path: parts.slice(8).join(' '),
      });
      continue;
    }
    if (c === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const parts = t.split(' ');
      if (parts.length < 10) continue;
      const origPath = tokens[i + 1];
      i++;
      entries.push({
        kind: 'rename',
        x: parts[1][0],
        y: parts[1][1],
        submodule: parts[2][0] === 'S',
        path: parts.slice(9).join(' '),
        origPath,
      });
      continue;
    }
    if (c === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = t.split(' ');
      if (parts.length < 11) continue;
      entries.push({
        kind: 'unmerged',
        x: parts[1][0],
        y: parts[1][1],
        submodule: parts[2][0] === 'S',
        path: parts.slice(10).join(' '),
      });
      continue;
    }
    if (c === '?') {
      entries.push({ kind: 'untracked', x: '?', y: '?', submodule: false, path: t.slice(2) });
      continue;
    }
    if (c === '!') {
      ignored.push(t.slice(2));
      continue;
    }
  }
  return { branch, entries, ignored };
}

/** Which list a change belongs to in the Source Control view. */
export type ChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'conflict';

export interface Change {
  group: ChangeGroup;
  /** Repo-relative path. */
  path: string;
  /** Repo-relative previous path (renames/copies in the index). */
  origPath?: string;
  /**
   * Status letter as git reports it for this side:
   * staged: M A D R C T · unstaged: M D T A (intent to add) R (intent to rename) · untracked: ? ·
   * conflict: the two-letter code (UU, AA, DD, AU, UA, DU, UD).
   */
  status: string;
  submodule: boolean;
}

export interface GroupedChanges {
  conflicts: Change[];
  staged: Change[];
  unstaged: Change[];
  untracked: Change[];
}

export function groupChanges(entries: StatusEntry[]): GroupedChanges {
  const out: GroupedChanges = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  for (const e of entries) {
    switch (e.kind) {
      case 'unmerged':
        out.conflicts.push({ group: 'conflict', path: e.path, status: e.x + e.y, submodule: e.submodule });
        break;
      case 'untracked':
        out.untracked.push({ group: 'untracked', path: e.path, status: '?', submodule: false });
        break;
      case 'ordinary':
      case 'rename':
        if (e.x !== '.') {
          out.staged.push({
            group: 'staged',
            path: e.path,
            origPath: e.kind === 'rename' ? e.origPath : undefined,
            status: e.x,
            submodule: e.submodule,
          });
        }
        if (e.y !== '.') {
          out.unstaged.push({ group: 'unstaged', path: e.path, status: e.y, submodule: e.submodule });
        }
        break;
      case 'ignored':
        break;
    }
  }
  const byPath = (a: Change, b: Change) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true });
  out.conflicts.sort(byPath);
  out.staged.sort(byPath);
  out.unstaged.sort(byPath);
  out.untracked.sort(byPath);
  return out;
}

/** Display letter for a change (what VS Code shows next to the file). */
export function changeLetter(c: Pick<Change, 'group' | 'status'>): string {
  if (c.group === 'untracked') return 'U';
  if (c.group === 'conflict') return '!';
  switch (c.status) {
    case 'M':
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
      return c.status;
    default:
      return c.status || 'M';
  }
}

const CONFLICT_LABELS: Record<string, string> = {
  UU: 'Both modified',
  AA: 'Both added',
  DD: 'Both deleted',
  AU: 'Added by us',
  UA: 'Added by them',
  DU: 'Deleted by us',
  UD: 'Deleted by them',
};

/** Human label, e.g. "Modified", "Index Added", "Untracked", "Both modified". */
export function changeLabel(c: Pick<Change, 'group' | 'status'>): string {
  if (c.group === 'untracked') return 'Untracked';
  if (c.group === 'conflict') return CONFLICT_LABELS[c.status] ?? 'Conflict';
  const base: Record<string, string> = {
    M: 'Modified',
    A: c.group === 'unstaged' ? 'Intent to add' : 'Added',
    D: 'Deleted',
    R: c.group === 'unstaged' ? 'Intent to rename' : 'Renamed',
    C: 'Copied',
    T: 'Type changed',
  };
  const label = base[c.status] ?? 'Changed';
  return c.group === 'staged' ? `Index ${label}` : label;
}

// ---------------------------------------------------------------------------
// git for-each-ref (branches)
// ---------------------------------------------------------------------------

/** Field separator used in our for-each-ref / log formats. */
export const FS = '\x1f';
/** Record separator used in our log format. */
export const RS = '\x1e';

export const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname)',
  '%(refname:short)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(objectname:short)',
  '%(committerdate:unix)',
  '%(worktreepath)',
  '%(contents:subject)',
].join('%1f');

export interface BranchInfo {
  /** Short name: "main", "origin/main". */
  name: string;
  /** Full ref: refs/heads/main, refs/remotes/origin/main. */
  ref: string;
  isRemote: boolean;
  /** Remote name for remote branches. */
  remote?: string;
  isCurrent: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Upstream branch was deleted. */
  upstreamGone?: boolean;
  hash: string;
  /** Epoch ms of the tip commit. */
  committerDate?: number;
  subject?: string;
  /** Absolute path of the worktree where this branch is checked out (if any). */
  worktreePath?: string;
}

export function parseAheadBehind(track: string): { ahead?: number; behind?: number; gone?: boolean } {
  const out: { ahead?: number; behind?: number; gone?: boolean } = {};
  if (!track) return out;
  if (/\bgone\b/.test(track)) out.gone = true;
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  if (a) out.ahead = Number(a[1]);
  if (b) out.behind = Number(b[1]);
  if (!out.gone && (a || b)) {
    out.ahead ??= 0;
    out.behind ??= 0;
  }
  return out;
}

export function parseBranches(output: string): BranchInfo[] {
  const out: BranchInfo[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(FS);
    if (f.length < 9) continue;
    const [head, ref, short, upstream, track, hash, date, worktreePath, ...subjectParts] = f;
    if (ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD')) continue;
    const isRemote = ref.startsWith('refs/remotes/');
    const ab = parseAheadBehind(track);
    out.push({
      name: short,
      ref,
      isRemote,
      remote: isRemote ? ref.slice('refs/remotes/'.length).split('/')[0] : undefined,
      isCurrent: head === '*',
      upstream: upstream || undefined,
      ahead: ab.ahead,
      behind: ab.behind,
      upstreamGone: ab.gone,
      hash,
      committerDate: date ? Number(date) * 1000 : undefined,
      subject: subjectParts.join(FS) || undefined,
      worktreePath: worktreePath || undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------

export const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%s', '%b'].join('%x1f') + '%x1e';

export interface CommitInfo {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Epoch ms (author date). */
  date: number;
  subject: string;
  body: string;
}

export function parseLog(output: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const rec of output.split(RS)) {
    const r = rec.replace(/^\n+/, '');
    if (!r.trim()) continue;
    const f = r.split(FS);
    if (f.length < 8) continue;
    const [hash, short, parents, author, email, at, subject, ...body] = f;
    out.push({
      hash,
      short,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      date: Number(at) * 1000,
      subject,
      body: body.join(FS).trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// git diff-tree --name-status -z
// ---------------------------------------------------------------------------

export interface CommitFileChange {
  /** A, M, D, R, C, T, U, X */
  status: string;
  path: string;
  origPath?: string;
}

export function parseNameStatusZ(output: string): CommitFileChange[] {
  const out: CommitFileChange[] = [];
  const t = output.split('\0');
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (!s) continue;
    const letter = s[0];
    if (!/^[ACDMRTUXB]/.test(letter)) continue;
    if (letter === 'R' || letter === 'C') {
      const from = t[i + 1];
      const to = t[i + 2];
      i += 2;
      if (to !== undefined) out.push({ status: letter, path: to, origPath: from });
    } else {
      const p = t[i + 1];
      i += 1;
      if (p !== undefined) out.push({ status: letter, path: p });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ignore lookups
// ---------------------------------------------------------------------------

/**
 * Builds a fast "is this repo-relative path ignored?" check from the ignored
 * list of `git status --ignored=matching` (directories end with "/").
 */
export function makeIgnoredLookup(ignored: string[]): (rel: string, isDirectory?: boolean) => boolean {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const p of ignored) {
    if (p.endsWith('/')) dirs.add(p.slice(0, -1));
    else files.add(p);
  }
  if (!files.size && !dirs.size) return () => false;
  return (rel: string) => {
    if (files.has(rel) || dirs.has(rel)) return true;
    let i = rel.lastIndexOf('/');
    while (i > 0) {
      if (dirs.has(rel.slice(0, i))) return true;
      i = rel.lastIndexOf('/', i - 1);
    }
    return false;
  };
}
