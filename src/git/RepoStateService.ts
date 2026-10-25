import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { ProjectStore } from '../projects/ProjectStore';
import type { ProjectSelection, Worktree } from '../shared/types';
import type { Logger } from '../util/log';
import { isSameOrInside } from '../util/paths';
import { listWorktrees } from './gitCli';
import type { GitContentProvider } from './GitContentProvider';
import {
  changeLabel,
  changeLetter,
  groupChanges,
  makeIgnoredLookup,
  type BranchInfo,
  type Change,
  type CommitInfo,
  type GroupedChanges,
  type ParsedStatus,
} from './parse';
import { getBranches, getLog, getRepoInfo, getRepoOperation, getStatus, type RepoInfo, type RepoOperation } from './repo';

/** Max untracked files listed (a huge untracked build folder would otherwise flood the view). */
const MAX_UNTRACKED = 5000;
const COMMIT_COUNT = 30;

export interface RepoSnapshot {
  version: number;
  selection?: ProjectSelection;
  /** Folder shown by the views (selection.path). */
  folder?: string;
  folderExists: boolean;
  /** Undefined when the folder is not inside a git repository. */
  repo?: RepoInfo;
  status?: ParsedStatus;
  changes: GroupedChanges;
  branches: BranchInfo[];
  worktrees: Worktree[];
  commits: CommitInfo[];
  operation?: RepoOperation;
  /** False on a branch without commits yet. */
  hasHead: boolean;
  /** Untracked files left out of `changes.untracked`. */
  untrackedOmitted: number;
  /** Whether the ignored list was requested for this snapshot. */
  hasIgnored: boolean;
  loading: boolean;
}

export interface FileDeco {
  letter?: string;
  colorId?: string;
  tooltip?: string;
}

type RefreshKind = 'all' | 'status';

const EMPTY_CHANGES: GroupedChanges = { conflicts: [], staged: [], unstaged: [], untracked: [] };

export const GIT_COLORS = {
  modified: 'gitDecoration.modifiedResourceForeground',
  stageModified: 'gitDecoration.stageModifiedResourceForeground',
  added: 'gitDecoration.addedResourceForeground',
  deleted: 'gitDecoration.deletedResourceForeground',
  stageDeleted: 'gitDecoration.stageDeletedResourceForeground',
  renamed: 'gitDecoration.renamedResourceForeground',
  untracked: 'gitDecoration.untrackedResourceForeground',
  ignored: 'gitDecoration.ignoredResourceForeground',
  conflicting: 'gitDecoration.conflictingResourceForeground',
  submodule: 'gitDecoration.submoduleResourceForeground',
} as const;

/** Color for a change letter in a given list ("staged", "unstaged", "untracked", "conflict", or "commit"). */
export function colorForChange(group: string, letter: string): string | undefined {
  if (group === 'untracked' || letter === 'U') return GIT_COLORS.untracked;
  if (group === 'conflict' || letter === '!') return GIT_COLORS.conflicting;
  const staged = group === 'staged';
  switch (letter) {
    case 'M':
    case 'T':
      return staged ? GIT_COLORS.stageModified : GIT_COLORS.modified;
    case 'A':
    case 'C':
      return GIT_COLORS.added;
    case 'D':
      return staged ? GIT_COLORS.stageDeleted : GIT_COLORS.deleted;
    case 'R':
      return GIT_COLORS.renamed;
  }
  return undefined;
}

/** Folder tint priority (higher wins). */
const FOLDER_PRIORITY: Record<string, number> = {
  [GIT_COLORS.conflicting]: 5,
  [GIT_COLORS.deleted]: 2,
  [GIT_COLORS.stageDeleted]: 2,
  [GIT_COLORS.modified]: 4,
  [GIT_COLORS.stageModified]: 3,
  [GIT_COLORS.renamed]: 3,
  [GIT_COLORS.added]: 1,
  [GIT_COLORS.untracked]: 1,
};

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Git state of the folder selected in the Projects view, shared by the Source
 * Control view, the Files view and the file decorations. Refreshes are
 * coalesced: file events are debounced (with a max wait so a long build still
 * shows progress), and nothing runs while both views are hidden.
 */
export class RepoStateService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<RepoSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  /** Files/folders created or deleted under the selected folder (for the Files tree). */
  private readonly _onDidCreateOrDelete = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidCreateOrDelete = this._onDidCreateOrDelete.event;

  private version = 0;
  private signature = '';
  private _snapshot: RepoSnapshot;

  private visibleViews = new Set<string>();
  private stale = true;
  private pendingKind: RefreshKind | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstEventAt: number | undefined;
  private running: Promise<void> | undefined;

  private watchedFolder: string | undefined;
  private watchedRepoRoot: string | undefined;
  private watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  // Decoration lookups for the Files view, rebuilt on every snapshot.
  private fileDecos = new Map<string, FileDeco>();
  private folderColors = new Map<string, string>();
  private ignoredLookup: (rel: string) => boolean = () => false;

  constructor(
    private readonly store: ProjectStore,
    private readonly content: GitContentProvider,
    private readonly log: Logger,
  ) {
    this._snapshot = this.emptySnapshot(undefined);
    this.disposables.push(
      store.onDidChangeSelection(() => this.onSelectionChanged()),
      store.onDidChangeProjects(() => {
        // Renamed project → new description; removed project → selection changes separately.
        this.schedule('status', 50);
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.disposeWatchers();
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
    this._onDidCreateOrDelete.dispose();
  }

  get snapshot(): RepoSnapshot {
    return this._snapshot;
  }

  /** Called by the views when their visibility changes. */
  setViewVisible(viewId: string, visible: boolean): void {
    const wasActive = this.isActive();
    if (visible) this.visibleViews.add(viewId);
    else this.visibleViews.delete(viewId);
    if (!wasActive && this.isActive() && (this.stale || this.pendingKind)) {
      this.stale = false;
      void this.refresh(this.pendingKind ?? 'all');
    } else if (visible && viewId === 'claudeProjects.files' && this._snapshot.repo && !this._snapshot.hasIgnored) {
      // The Files view needs the ignored list for dimming.
      this.schedule('status', 0);
    }
  }

  private isActive(): boolean {
    return this.visibleViews.size > 0;
  }

  private get wantIgnored(): boolean {
    return this.visibleViews.has('claudeProjects.files');
  }

  /** Refresh now (or right after the refresh in progress). Resolves when the data is up to date. */
  async refresh(kind: RefreshKind = 'all'): Promise<void> {
    this.pendingKind = mergeKind(this.pendingKind, kind);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.firstEventAt = undefined;
    }
    await this.flush();
  }

  /** Debounced refresh for file-system events. */
  schedule(kind: RefreshKind, delayMs = 400, maxWaitMs = 2000): void {
    this.pendingKind = mergeKind(this.pendingKind, kind);
    if (!this.isActive()) {
      this.stale = true;
      return;
    }
    const now = Date.now();
    this.firstEventAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delayMs, this.firstEventAt + maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.firstEventAt = undefined;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    while (this.running) {
      await this.running.catch(() => undefined);
    }
    const kind = this.pendingKind;
    if (!kind) return;
    this.pendingKind = undefined;
    this.running = this.doRefresh(kind).catch((err) => this.log.error(`Git refresh failed: ${String(err)}`));
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private onSelectionChanged(): void {
    this.disposeWatchers();
    this.stale = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.firstEventAt = undefined;
    // Show the new folder right away (empty while loading) so the views never show the old project.
    this.setSnapshot({ ...this.emptySnapshot(this.store.selection), loading: true }, true);
    if (this.isActive()) {
      this.stale = false;
      void this.refresh('all');
    }
  }

  private emptySnapshot(selection: ProjectSelection | undefined): RepoSnapshot {
    return {
      version: this.version,
      selection,
      folder: selection?.path,
      folderExists: selection ? isDirectory(selection.path) : false,
      changes: EMPTY_CHANGES,
      branches: [],
      worktrees: [],
      commits: [],
      hasHead: false,
      untrackedOmitted: 0,
      hasIgnored: false,
      loading: false,
    };
  }

  private async doRefresh(kind: RefreshKind): Promise<void> {
    const selection = this.store.selection;
    if (!selection) {
      this.disposeWatchers();
      this.setSnapshot(this.emptySnapshot(undefined));
      return;
    }
    const folder = selection.path;
    if (!isDirectory(folder)) {
      this.disposeWatchers();
      this.setSnapshot(this.emptySnapshot(selection));
      return;
    }
    const prev = this._snapshot.folder === folder ? this._snapshot : undefined;
    const repo = kind === 'all' || !prev?.repo ? await getRepoInfo(folder) : prev.repo;
    if (this.store.selection?.path !== folder) return; // selection moved on
    this.ensureWatchers(folder, repo);
    if (!repo) {
      this.setSnapshot({ ...this.emptySnapshot(selection), folderExists: true });
      return;
    }
    const full = kind === 'all' || !prev?.repo || prev.repo.root !== repo.root;
    const wantIgnored = this.wantIgnored;
    const [status, branches, worktrees, commits] = await Promise.all([
      getStatus(repo.root, { ignored: wantIgnored }),
      full ? getBranches(repo.root) : Promise.resolve(prev!.branches),
      full ? listWorktrees(repo.root) : Promise.resolve(prev!.worktrees),
      full ? getLog(repo.root, COMMIT_COUNT) : Promise.resolve(prev!.commits),
    ]);
    if (this.store.selection?.path !== folder) return;

    const changes = status ? groupChanges(status.entries) : EMPTY_CHANGES;
    let untrackedOmitted = 0;
    if (changes.untracked.length > MAX_UNTRACKED) {
      untrackedOmitted = changes.untracked.length - MAX_UNTRACKED;
      changes.untracked = changes.untracked.slice(0, MAX_UNTRACKED);
    }
    this.setSnapshot({
      version: this.version,
      selection,
      folder,
      folderExists: true,
      repo,
      status,
      changes,
      branches,
      worktrees,
      commits,
      operation: getRepoOperation(repo.gitDir),
      hasHead: !!status && !status.branch.initial,
      untrackedOmitted,
      hasIgnored: wantIgnored,
      loading: false,
    });
    this.content.refreshRepo(repo.root);
  }

  private setSnapshot(next: RepoSnapshot, force = false): void {
    const sig = signatureOf(next);
    if (!force && sig === this.signature) return;
    this.signature = sig;
    this.version++;
    this._snapshot = { ...next, version: this.version };
    this.rebuildDecorations();
    this._onDidChange.fire(this._snapshot);
  }

  // -------------------------------------------------------------------------
  // Watchers
  // -------------------------------------------------------------------------

  private disposeWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.watchedFolder = undefined;
    this.watchedRepoRoot = undefined;
  }

  private ensureWatchers(folder: string, repo: RepoInfo | undefined): void {
    if (this.watchedFolder === folder && this.watchedRepoRoot === repo?.root) return;
    this.disposeWatchers();
    this.watchedFolder = folder;
    this.watchedRepoRoot = repo?.root;

    const gitDirs = repo ? [repo.gitDir, repo.commonDir] : [];
    const inGitDir = (p: string) => gitDirs.some((d) => isSameOrInside(p, d)) || p.split(sep).includes('.git');

    // Working tree (recursive; VS Code applies files.watcherExclude to it).
    const treeRoot = repo && isSameOrInside(folder, repo.root) ? repo.root : folder;
    const tree = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(treeRoot), '**'));
    const onTree = (uri: vscode.Uri, createdOrDeleted: boolean) => {
      if (inGitDir(uri.fsPath)) return;
      if (createdOrDeleted && isSameOrInside(uri.fsPath, folder)) this._onDidCreateOrDelete.fire(uri);
      if (repo) this.schedule('status');
    };
    tree.onDidCreate((u) => onTree(u, true));
    tree.onDidDelete((u) => onTree(u, true));
    tree.onDidChange((u) => onTree(u, false));
    this.watchers.push(tree);

    if (repo) {
      // Simple (non-recursive) patterns are never filtered by files.watcherExclude.
      const head = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(repo.gitDir), '{HEAD,index,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,REBASE_HEAD,ORIG_HEAD}'),
      );
      const onHead = (uri: vscode.Uri) => this.schedule(uri.fsPath.endsWith(`${sep}index`) ? 'status' : 'all', 300);
      head.onDidCreate(onHead);
      head.onDidChange(onHead);
      head.onDidDelete(onHead);
      this.watchers.push(head);

      const refsRoot = vscode.Uri.file(repo.commonDir);
      const refs = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(refsRoot, '{packed-refs,FETCH_HEAD,refs/**,worktrees/*/HEAD}'));
      const onRefs = (uri: vscode.Uri) => {
        if (uri.fsPath.endsWith('.lock')) return;
        this.schedule('all', 500);
      };
      refs.onDidCreate(onRefs);
      refs.onDidChange(onRefs);
      refs.onDidDelete(onRefs);
      this.watchers.push(refs);
      // Rebase in progress markers live in directories.
      const ops = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repo.gitDir), '{rebase-merge,rebase-apply}'));
      ops.onDidCreate(() => this.schedule('all', 300));
      ops.onDidDelete(() => this.schedule('all', 300));
      this.watchers.push(ops);
    }
  }

  // -------------------------------------------------------------------------
  // Decorations for the Files view
  // -------------------------------------------------------------------------

  private rebuildDecorations(): void {
    const s = this._snapshot;
    this.fileDecos = new Map();
    this.folderColors = new Map();
    this.ignoredLookup = () => false;
    if (!s.repo) return;
    const root = s.repo.root;
    const put = (c: Change, override: boolean) => {
      const abs = join(root, c.path);
      if (!override && this.fileDecos.has(abs)) return;
      const letter = changeLetter(c);
      this.fileDecos.set(abs, { letter, colorId: colorForChange(c.group, letter), tooltip: changeLabel(c) });
    };
    for (const c of s.changes.staged) put(c, false);
    for (const c of s.changes.unstaged) put(c, true);
    for (const c of s.changes.untracked) put(c, true);
    for (const c of s.changes.conflicts) put(c, true);
    for (const [abs, deco] of this.fileDecos) {
      if (!deco.colorId) continue;
      const pr = FOLDER_PRIORITY[deco.colorId] ?? 0;
      let dir = dirname(abs);
      while (dir.length >= root.length && isSameOrInside(dir, root)) {
        const cur = this.folderColors.get(dir);
        if (cur && (FOLDER_PRIORITY[cur] ?? 0) >= pr) break;
        this.folderColors.set(dir, deco.colorId);
        if (dir === root) break;
        dir = dirname(dir);
      }
    }
    if (s.status?.ignored.length) {
      const lookup = makeIgnoredLookup(s.status.ignored);
      const prefix = root.endsWith(sep) ? root : root + sep;
      this.ignoredLookup = (abs: string) => abs.startsWith(prefix) && lookup(abs.slice(prefix.length).split(sep).join('/'));
    }
  }

  /** Decoration for a path shown in the Files view. */
  decorationFor(absPath: string, isDirectory: boolean): FileDeco | undefined {
    if (!isDirectory) {
      const d = this.fileDecos.get(absPath);
      if (d) return d;
    } else {
      const color = this.folderColors.get(absPath);
      if (color) return { colorId: color, tooltip: 'Contains changes' };
    }
    if (this.ignoredLookup(absPath)) return { colorId: GIT_COLORS.ignored, tooltip: 'Ignored by git' };
    return undefined;
  }
}

function mergeKind(a: RefreshKind | undefined, b: RefreshKind): RefreshKind {
  return a === 'all' || b === 'all' ? 'all' : 'status';
}

function signatureOf(s: RepoSnapshot): string {
  const parts: unknown[] = [
    s.selection?.projectId,
    s.folder,
    s.folderExists,
    s.repo?.root,
    s.loading,
    s.operation,
    s.hasHead,
    s.hasIgnored,
    s.untrackedOmitted,
    s.status?.branch,
    s.status?.entries.map((e) => `${e.kind}${e.x}${e.y}${e.path}\u0000${e.origPath ?? ''}`),
    s.status?.ignored,
    s.branches.map((b) => `${b.ref} ${b.hash} ${b.isCurrent} ${b.upstream} ${b.ahead} ${b.behind} ${b.worktreePath ?? ''}`),
    s.worktrees.map((w) => `${w.path} ${w.branch} ${w.head} ${w.locked} ${w.prunable}`),
    s.commits.map((c) => c.hash),
  ];
  return JSON.stringify(parts);
}
