import * as vscode from 'vscode';
import { basename, dirname, join } from 'node:path';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { Worktree } from '../../shared/types';
import { folderName, tildify } from '../../util/paths';
import { longAgo, shortAgo } from '../../util/time';
import { scmResourceUri } from '../../git/GitDecorationProvider';
import { changeLabel, changeLetter, type BranchInfo, type Change, type CommitFileChange, type CommitInfo } from '../../git/parse';
import { getCommitFiles } from '../../git/repo';
import type { RepoSnapshot, RepoStateService } from '../../git/RepoStateService';

export type ScmGroupKind = 'conflicts' | 'staged' | 'unstaged' | 'branches' | 'remotes' | 'worktrees' | 'commits';

interface Base {
  id: string;
  /** Absolute path — what the shared path commands (reveal, copy path…) act on. */
  path: string;
}

export type ScmNode =
  | (Base & { kind: 'head' })
  | (Base & { kind: 'init' })
  | (Base & { kind: 'info'; text: string; tooltip?: string; icon?: string })
  | (Base & { kind: 'group'; group: ScmGroupKind })
  | (Base & { kind: 'change'; change: Change; root: string })
  | (Base & { kind: 'branch'; branch: BranchInfo; root: string })
  | (Base & { kind: 'worktree'; worktree: Worktree })
  | (Base & { kind: 'commit'; commit: CommitInfo; root: string })
  | (Base & { kind: 'commitFile'; commit: CommitInfo; file: CommitFileChange; root: string });

export type ChangeNode = Extract<ScmNode, { kind: 'change' }>;
export type BranchNode = Extract<ScmNode, { kind: 'branch' }>;
export type WorktreeNode = Extract<ScmNode, { kind: 'worktree' }>;
export type CommitNode = Extract<ScmNode, { kind: 'commit' }>;
export type CommitFileNode = Extract<ScmNode, { kind: 'commitFile' }>;

const byPath = (a: Change, b: Change) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true });

export class ScmTreeProvider implements vscode.TreeDataProvider<ScmNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ScmNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly commitFilesCache = new Map<string, CommitFileChange[]>();
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly state: RepoStateService,
    private readonly store: ProjectStore,
  ) {
    this.sub = state.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }

  private get s(): RepoSnapshot {
    return this.state.snapshot;
  }

  // -------------------------------------------------------------------------

  getChildren(element?: ScmNode): ScmNode[] | Promise<ScmNode[]> {
    const s = this.s;
    if (!element) return this.rootNodes(s);
    const root = s.repo?.root;
    if (!root) return [];
    switch (element.kind) {
      case 'group':
        return this.groupChildren(element.group, s, root);
      case 'commit':
        return this.commitChildren(element);
      default:
        return [];
    }
  }

  private rootNodes(s: RepoSnapshot): ScmNode[] {
    if (!s.selection || !s.folderExists || s.loading) return [];
    if (!s.repo) return [{ kind: 'init', id: 'scm:init', path: s.folder! }];
    const root = s.repo.root;
    const nodes: ScmNode[] = [{ kind: 'head', id: 'scm:head', path: root }];
    if (s.changes.conflicts.length) nodes.push(this.group('conflicts', root));
    if (s.changes.staged.length) nodes.push(this.group('staged', root));
    nodes.push(this.group('unstaged', root));
    nodes.push(this.group('branches', root), this.group('worktrees', root), this.group('commits', root));
    return nodes;
  }

  private group(group: ScmGroupKind, root: string): ScmNode {
    return { kind: 'group', id: `scm:group:${group}`, group, path: root };
  }

  private changeNode(c: Change, root: string): ChangeNode {
    return { kind: 'change', id: `scm:${c.group}:${c.path}`, change: c, root, path: join(root, c.path) };
  }

  private groupChildren(group: ScmGroupKind, s: RepoSnapshot, root: string): ScmNode[] {
    switch (group) {
      case 'conflicts':
        return s.changes.conflicts.map((c) => this.changeNode(c, root));
      case 'staged':
        return s.changes.staged.map((c) => this.changeNode(c, root));
      case 'unstaged': {
        const nodes: ScmNode[] = [...s.changes.unstaged, ...s.changes.untracked].sort(byPath).map((c) => this.changeNode(c, root));
        if (s.untrackedOmitted > 0) {
          nodes.push({
            kind: 'info',
            id: 'scm:info:untracked-omitted',
            path: root,
            text: `${s.untrackedOmitted.toLocaleString()} more untracked files not shown`,
            tooltip: 'Add the folder to .gitignore to hide it.',
            icon: 'warning',
          });
        }
        return nodes;
      }
      case 'branches': {
        const local = s.branches.filter((b) => !b.isRemote);
        local.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || (b.committerDate ?? 0) - (a.committerDate ?? 0));
        const nodes: ScmNode[] = local.map((b) => ({ kind: 'branch', id: `scm:branch:${b.ref}`, branch: b, root, path: root }));
        if (s.branches.some((b) => b.isRemote)) nodes.push(this.group('remotes', root));
        return nodes;
      }
      case 'remotes':
        return s.branches
          .filter((b) => b.isRemote)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((b) => ({ kind: 'branch', id: `scm:branch:${b.ref}`, branch: b, root, path: root }));
      case 'worktrees':
        return s.worktrees.map((w) => ({ kind: 'worktree', id: `scm:worktree:${w.path}`, worktree: w, path: w.path }));
      case 'commits':
        if (!s.commits.length) {
          return [{ kind: 'info', id: 'scm:info:no-commits', path: root, text: s.hasHead ? 'No commits' : 'No commits yet', icon: 'info' }];
        }
        return s.commits.map((c) => ({ kind: 'commit', id: `scm:commit:${c.hash}`, commit: c, root, path: root }));
    }
  }

  private async commitChildren(node: CommitNode): Promise<ScmNode[]> {
    const key = `${node.root}\u0000${node.commit.hash}`;
    let files = this.commitFilesCache.get(key);
    if (!files) {
      files = await getCommitFiles(node.root, node.commit);
      this.commitFilesCache.set(key, files);
      if (this.commitFilesCache.size > 200) this.commitFilesCache.delete(this.commitFilesCache.keys().next().value!);
    }
    if (!files.length) return [{ kind: 'info', id: `scm:info:empty:${node.commit.hash}`, path: node.root, text: 'No file changes', icon: 'info' }];
    return files.map((f) => ({
      kind: 'commitFile',
      id: `scm:commit:${node.commit.hash}:${f.path}`,
      commit: node.commit,
      file: f,
      root: node.root,
      path: join(node.root, f.path),
    }));
  }

  // -------------------------------------------------------------------------

  getTreeItem(node: ScmNode): vscode.TreeItem {
    switch (node.kind) {
      case 'head':
        return this.headItem(node);
      case 'init': {
        const item = new vscode.TreeItem('Initialize Git Repository', vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.tooltip = `Run "git init" in ${tildify(node.path)}`;
        item.command = { command: 'claudeProjects.scm.initRepo', title: 'Initialize Repository', arguments: [node] };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.tooltip = node.tooltip;
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        item.contextValue = 'scm.info';
        return item;
      }
      case 'group':
        return this.groupItem(node);
      case 'change':
        return this.changeItem(node);
      case 'branch':
        return this.branchItem(node);
      case 'worktree':
        return this.worktreeItem(node);
      case 'commit':
        return this.commitItem(node);
      case 'commitFile':
        return this.commitFileItem(node);
    }
  }

  private headItem(node: ScmNode): vscode.TreeItem {
    const s = this.s;
    const b = s.status?.branch;
    const label = b?.head ?? (b?.oid ? b.oid.slice(0, 8) : 'HEAD');
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.contextValue = 'scm.head';
    item.iconPath = new vscode.ThemeIcon(b?.detached ? 'git-commit' : 'git-branch');
    const parts: string[] = [];
    if (s.operation) parts.push(OPERATION_LABELS[s.operation]);
    if (b?.detached) parts.push('detached HEAD');
    else if (b?.initial) parts.push('no commits yet');
    if (b?.upstream) {
      const arrows = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
      parts.push(arrows ? `${arrows} · ${b.upstream}` : b.upstream);
    } else if (b && !b.detached && !b.initial) {
      parts.push('not published');
    }
    item.description = parts.join(' · ');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`$(git-branch) **${escapeMd(label)}**`);
    if (b?.upstream) {
      md.appendMarkdown(` → ${escapeMd(b.upstream)}\n\n`);
      md.appendMarkdown(`${b.ahead ?? 0} ahead, ${b.behind ?? 0} behind\n\n`);
    } else {
      md.appendMarkdown('\n\n');
    }
    if (s.operation) md.appendMarkdown(`**${OPERATION_LABELS[s.operation]}** in progress\n\n`);
    if (s.commits[0]) md.appendMarkdown(`Last commit: ${escapeMd(s.commits[0].subject)} (${shortAgoText(s.commits[0].date)})\n\n`);
    if (s.repo) md.appendMarkdown(`${escapeMd(tildify(s.repo.root))}\n\nClick to switch branch.`);
    item.tooltip = md;
    item.command = { command: 'claudeProjects.scm.checkout', title: 'Checkout Branch…', arguments: [] };
    return item;
  }

  private groupItem(node: Extract<ScmNode, { kind: 'group' }>): vscode.TreeItem {
    const s = this.s;
    const E = vscode.TreeItemCollapsibleState.Expanded;
    const C = vscode.TreeItemCollapsibleState.Collapsed;
    const N = vscode.TreeItemCollapsibleState.None;
    let label = '';
    let count = 0;
    let state = C;
    let icon = '';
    switch (node.group) {
      case 'conflicts':
        label = 'Merge Changes';
        count = s.changes.conflicts.length;
        state = E;
        icon = 'git-branch-conflicts';
        break;
      case 'staged':
        label = 'Staged Changes';
        count = s.changes.staged.length;
        state = E;
        icon = 'git-branch-staged-changes';
        break;
      case 'unstaged':
        label = 'Changes';
        count = s.changes.unstaged.length + s.changes.untracked.length + s.untrackedOmitted;
        state = count ? E : N;
        icon = 'git-branch-changes';
        break;
      case 'branches':
        label = 'Branches';
        count = s.branches.filter((b) => !b.isRemote).length;
        icon = 'git-branch';
        break;
      case 'remotes':
        label = 'Remote Branches';
        count = s.branches.filter((b) => b.isRemote).length;
        icon = 'cloud';
        break;
      case 'worktrees':
        label = 'Worktrees';
        count = s.worktrees.length;
        icon = 'worktree';
        break;
      case 'commits':
        label = 'Recent Commits';
        count = s.commits.length;
        icon = 'history';
        break;
    }
    const item = new vscode.TreeItem(label, state);
    item.id = node.id;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = `scm.group.${node.group}`;
    if (node.group === 'unstaged' && count === 0) item.description = 'No changes';
    else if (node.group === 'commits') item.description = count ? `last ${count}` : '';
    else item.description = String(count);
    return item;
  }

  private changeItem(node: ChangeNode): vscode.TreeItem {
    const c = node.change;
    const letter = changeLetter(c);
    const label = changeLabel(c);
    const item = new vscode.TreeItem(basename(c.path), vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.resourceUri = scmResourceUri(node.path, letter, c.group, label);
    item.iconPath = vscode.ThemeIcon.File;
    const dir = dirname(c.path);
    item.description = c.origPath ? `${dir === '.' ? '' : dir + ' '}← ${c.origPath}`.trim() : dir === '.' ? '' : dir;
    item.tooltip = `${tildify(node.path)} • ${label}${c.origPath ? ` (from ${c.origPath})` : ''}`;
    item.contextValue = `scm.change.${c.group}`;
    item.command = { command: 'claudeProjects.scm.openChange', title: 'Open Changes', arguments: [node] };
    return item;
  }

  private branchItem(node: BranchNode): vscode.TreeItem {
    const b = node.branch;
    const item = new vscode.TreeItem(b.name, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.contextValue = b.isCurrent ? 'scm.branch.current' : b.isRemote ? 'scm.branch.remote' : 'scm.branch.local';
    item.iconPath = new vscode.ThemeIcon(b.isCurrent ? 'check' : b.isRemote ? 'cloud' : 'git-branch');
    const parts: string[] = [];
    if (b.ahead || b.behind) parts.push([b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' '));
    if (b.upstreamGone) parts.push('upstream gone');
    if (b.worktreePath && !b.isCurrent) parts.push(`in worktree ${folderName(b.worktreePath)}`);
    if (b.committerDate) parts.push(shortAgoText(b.committerDate));
    item.description = parts.join(' · ');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`$(${b.isRemote ? 'cloud' : 'git-branch'}) **${escapeMd(b.name)}**${b.isCurrent ? ' (current)' : ''}\n\n`);
    if (b.upstream) md.appendMarkdown(`Tracks ${escapeMd(b.upstream)}${b.ahead || b.behind ? ` — ${b.ahead ?? 0} ahead, ${b.behind ?? 0} behind` : ''}\n\n`);
    if (b.subject) md.appendMarkdown(`${escapeMd(b.hash)} ${escapeMd(b.subject)}${b.committerDate ? ` — ${longAgo(b.committerDate)}` : ''}\n\n`);
    if (b.worktreePath) md.appendMarkdown(`Checked out in ${escapeMd(tildify(b.worktreePath))}`);
    item.tooltip = md;
    return item;
  }

  private worktreeItem(node: WorktreeNode): vscode.TreeItem {
    const w = node.worktree;
    const viewing = this.store.selection?.path === w.path;
    const label = w.branch ?? (w.bare ? '(bare)' : w.head ? `${w.head.slice(0, 8)} (detached)` : folderName(w.path));
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.contextValue = w.isMain ? 'scm.worktree.main' : 'scm.worktree.linked';
    item.iconPath = new vscode.ThemeIcon(viewing ? 'eye' : w.isMain ? 'repo' : 'worktree');
    const flags = [viewing ? 'viewing' : '', w.isMain ? 'main' : '', w.locked ? 'locked' : '', w.prunable ? 'prunable' : ''].filter(Boolean);
    item.description = [flags.join(', '), tildify(w.path)].filter(Boolean).join(' · ');
    item.tooltip = `${tildify(w.path)}${w.branch ? `\nBranch: ${w.branch}` : ''}${w.isMain ? '\nMain worktree' : ''}\nClick to show this worktree in the Source Control and Files views.`;
    item.command = { command: 'claudeProjects.scm.selectWorktree', title: 'Show This Worktree', arguments: [node] };
    return item;
  }

  private commitItem(node: CommitNode): vscode.TreeItem {
    const c = node.commit;
    const item = new vscode.TreeItem(c.subject || '(no message)', vscode.TreeItemCollapsibleState.Collapsed);
    item.id = node.id;
    item.contextValue = 'scm.commit';
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.description = `${c.author}, ${shortAgoText(c.date)}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`$(git-commit) \`${c.short}\` — **${escapeMd(c.author)}** <${escapeMd(c.email)}>\n\n`);
    md.appendMarkdown(`${new Date(c.date).toLocaleString()} (${longAgo(c.date)})\n\n`);
    md.appendMarkdown(`**${escapeMd(c.subject)}**`);
    if (c.body) md.appendMarkdown(`\n\n${escapeMd(c.body)}`);
    item.tooltip = md;
    return item;
  }

  private commitFileItem(node: CommitFileNode): vscode.TreeItem {
    const f = node.file;
    const item = new vscode.TreeItem(basename(f.path), vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.contextValue = 'scm.commitFile';
    const label = COMMIT_STATUS_LABELS[f.status] ?? 'Changed';
    item.resourceUri = scmResourceUri(node.path, f.status, 'commit', label);
    item.iconPath = vscode.ThemeIcon.File;
    const dir = dirname(f.path);
    item.description = f.origPath ? `${dir === '.' ? '' : dir + ' '}← ${f.origPath}`.trim() : dir === '.' ? '' : dir;
    item.tooltip = `${f.path} • ${label}${f.origPath ? ` (from ${f.origPath})` : ''}`;
    item.command = { command: 'claudeProjects.scm.openCommitFile', title: 'Open Changes', arguments: [node] };
    return item;
  }
}

const OPERATION_LABELS: Record<string, string> = {
  merge: 'Merging',
  rebase: 'Rebasing',
  'cherry-pick': 'Cherry-picking',
  revert: 'Reverting',
  bisect: 'Bisecting',
};

const COMMIT_STATUS_LABELS: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
};

function shortAgoText(ms: number): string {
  const s = shortAgo(ms);
  if (s === 'now') return 'just now';
  return /^\d/.test(s) ? `${s} ago` : s;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
