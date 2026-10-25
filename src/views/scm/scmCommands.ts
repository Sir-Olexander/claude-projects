import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { Logger } from '../../util/log';
import { errorMessage } from '../../util/log';
import { folderName, tildify } from '../../util/paths';
import { shortAgo } from '../../util/time';
import { runGit } from '../../git/gitCli';
import { EMPTY_REF, toGitUri } from '../../git/GitContentProvider';
import type { BranchInfo, Change } from '../../git/parse';
import {
  checkout,
  checkoutTracking,
  commit,
  createBranch,
  deleteBranch,
  discardTracked,
  ensureOk,
  fetch,
  forgetIntentToAdd,
  getRemotes,
  GitError,
  isValidBranchName,
  parseCheckedOutElsewhere,
  pull,
  push,
  stage,
  stageAll,
  unstage,
  unstageAll,
} from '../../git/repo';
import type { RepoStateService } from '../../git/RepoStateService';
import type { BranchNode, ChangeNode, CommitFileNode, CommitNode, ScmNode, WorktreeNode } from './ScmTreeProvider';

const VIEW_ID = 'claudeProjects.scm';

interface Ctx {
  state: RepoStateService;
  store: ProjectStore;
  tree: vscode.TreeView<ScmNode>;
  log: Logger;
}

/** Refresh the Projects tree (branch names, worktrees). Ignored if that command is not registered. */
export async function refreshProjectsView(): Promise<void> {
  try {
    await vscode.commands.executeCommand('claudeProjects.refresh');
  } catch {
    // Projects view not available
  }
}

export function showGitError(err: unknown, log: Logger): void {
  const msg = err instanceof GitError ? err.message : errorMessage(err);
  log.error(msg);
  void vscode.window.showErrorMessage(msg.length > 600 ? msg.slice(0, 600) + '…' : msg);
}

function isChangeNode(n: unknown): n is ChangeNode {
  return !!n && typeof n === 'object' && (n as ScmNode).kind === 'change';
}

export function registerScmCommands(ctx: Ctx): vscode.Disposable {
  const { state, store, tree, log } = ctx;

  /** Root of the selected repository, loading the git state first if the views have not done it yet. */
  const repoRoot = async (): Promise<string | undefined> => {
    const sel = store.selection;
    if (!sel) {
      void vscode.window.showWarningMessage('Select a project in the Projects view first.');
      return undefined;
    }
    const s = state.snapshot;
    if (s.folder !== sel.path || s.loading || !s.repo) await state.refresh('all');
    const r = state.snapshot.repo?.root;
    if (!r) void vscode.window.showWarningMessage('The selected folder is not a git repository.');
    return r;
  };

  /** Clicked node + multi-selection → the change nodes to act on, limited to the given groups. */
  const pickChanges = (node: unknown, nodes: unknown, groups: Change['group'][]): ChangeNode[] => {
    let list: unknown[] = [];
    if (Array.isArray(nodes) && nodes.length && (!node || nodes.includes(node))) list = nodes;
    else if (node) list = [node];
    else list = [...tree.selection];
    return list.filter(isChangeNode).filter((n) => groups.includes(n.change.group));
  };

  /** Runs a git action, reports errors, then refreshes. */
  const op = async (fn: () => Promise<unknown>, opts: { progress?: string; refreshProjects?: boolean } = {}) => {
    try {
      if (opts.progress) {
        await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title: opts.progress }, fn);
      } else {
        await fn();
      }
    } catch (err) {
      showGitError(err, log);
    } finally {
      await state.refresh('all');
      if (opts.refreshProjects) await refreshProjectsView();
    }
  };

  const open = (uri: vscode.Uri, opts: vscode.TextDocumentShowOptions = { preview: true }) => vscode.commands.executeCommand('vscode.open', uri, opts);

  const diff = (left: vscode.Uri, right: vscode.Uri, title: string) => vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });

  const git = (root: string, rel: string, ref: string) => toGitUri(join(root, rel), { repo: root, ref, rel });

  const openChange = async (node?: ScmNode) => {
    const n = node && isChangeNode(node) ? node : pickChanges(undefined, undefined, ['staged', 'unstaged', 'untracked', 'conflict'])[0];
    if (!n) return;
    const { change: c, root } = n;
    const abs = join(root, c.path);
    const file = vscode.Uri.file(abs);
    const name = basename(c.path);
    switch (c.group) {
      case 'untracked':
        await open(file);
        return;
      case 'conflict':
        if (existsSync(abs)) await open(file);
        else await open(git(root, c.path, c.status === 'DU' ? '~3' : '~2'));
        return;
      case 'unstaged':
        if (c.status === 'D') await diff(git(root, c.path, ''), git(root, c.path, EMPTY_REF), `${name} (Deleted)`);
        else if (c.status === 'A') await diff(git(root, c.path, EMPTY_REF), file, `${name} (Working Tree)`);
        else await diff(git(root, c.path, ''), file, `${name} (Working Tree)`);
        return;
      case 'staged':
        if (c.status === 'A' || c.status === 'C') await diff(git(root, c.path, EMPTY_REF), git(root, c.path, ''), `${name} (Index)`);
        else if (c.status === 'D') await diff(git(root, c.path, 'HEAD'), git(root, c.path, EMPTY_REF), `${name} (Deleted)`);
        else if (c.status === 'R' && c.origPath) await diff(git(root, c.origPath, 'HEAD'), git(root, c.path, ''), `${name} (Index)`);
        else await diff(git(root, c.path, 'HEAD'), git(root, c.path, ''), `${name} (Index)`);
        return;
    }
  };

  const openFile = async (node?: ScmNode, nodes?: ScmNode[]) => {
    const list = pickChanges(node, nodes, ['staged', 'unstaged', 'untracked', 'conflict']);
    for (const n of list) {
      const abs = join(n.root, n.change.path);
      if (existsSync(abs)) await open(vscode.Uri.file(abs), { preview: list.length === 1 });
      else await open(git(n.root, n.change.path, 'HEAD'), { preview: list.length === 1 });
    }
  };

  const openCommitFile = async (node: CommitFileNode) => {
    const { commit: c, file: f, root } = node;
    const parent = c.parents[0];
    const left = f.status === 'A' || !parent ? git(root, f.path, EMPTY_REF) : git(root, f.origPath ?? f.path, parent);
    const right = f.status === 'D' ? git(root, f.path, EMPTY_REF) : git(root, f.path, c.hash);
    await diff(left, right, `${basename(f.path)} (${c.short})`);
  };

  const hasConflictMarkers = async (abs: string) => {
    try {
      const text = await readFile(abs, 'utf8');
      return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
    } catch {
      return false;
    }
  };

  const stageCmd = async (node?: ScmNode, nodes?: ScmNode[]) => {
    const list = pickChanges(node, nodes, ['unstaged', 'untracked', 'conflict']);
    if (!list.length) return;
    const root = list[0].root;
    for (const n of list.filter((x) => x.change.group === 'conflict')) {
      if (await hasConflictMarkers(join(root, n.change.path))) {
        const ok = await vscode.window.showWarningMessage(`"${basename(n.change.path)}" still contains conflict markers. Stage it anyway?`, { modal: true }, 'Stage');
        if (ok !== 'Stage') return;
      }
    }
    await op(async () => ensureOk(await stage(root, list.map((n) => n.change.path)), 'Stage'));
  };

  const unstageCmd = async (node?: ScmNode, nodes?: ScmNode[]) => {
    const list = pickChanges(node, nodes, ['staged']);
    if (!list.length) return;
    const root = list[0].root;
    const paths = list.flatMap((n) => (n.change.origPath ? [n.change.path, n.change.origPath] : [n.change.path]));
    await op(async () => ensureOk(await unstage(root, paths, state.snapshot.hasHead), 'Unstage'));
  };

  const trash = async (root: string, rels: string[]) => {
    const queue = [...rels];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length) {
        const rel = queue.shift()!;
        await vscode.workspace.fs.delete(vscode.Uri.file(join(root, rel)), { recursive: true, useTrash: true });
      }
    });
    await Promise.all(workers);
  };

  const discardChanges = async (list: ChangeNode[], all: boolean) => {
    if (!list.length) return;
    const root = list[0].root;
    const tracked = list.filter((n) => n.change.group === 'unstaged' && n.change.status !== 'A').map((n) => n.change.path);
    const intent = list.filter((n) => n.change.group === 'unstaged' && n.change.status === 'A').map((n) => n.change.path);
    const untracked = list.filter((n) => n.change.group === 'untracked').map((n) => n.change.path);
    const deleting = untracked.length + intent.length;
    let message: string;
    let button: string;
    let detail: string | undefined;
    if (list.length === 1 && tracked.length === 1) {
      message = `Are you sure you want to discard changes in "${basename(tracked[0])}"?`;
      button = 'Discard File';
    } else if (list.length === 1) {
      message = `Are you sure you want to delete "${basename((untracked[0] ?? intent[0])!)}"?`;
      detail = 'The file is not tracked by git. It will be moved to the Trash.';
      button = 'Move to Trash';
    } else {
      message = all ? `Are you sure you want to discard ALL ${list.length} changes?` : `Are you sure you want to discard changes in ${list.length} files?`;
      detail = deleting ? `${deleting} untracked file${deleting === 1 ? '' : 's'} will be moved to the Trash.` : undefined;
      button = all ? 'Discard All' : 'Discard Files';
    }
    const ok = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
    if (ok !== button) return;
    await op(async () => {
      if (tracked.length) ensureOk(await discardTracked(root, tracked), 'Discard');
      if (intent.length) ensureOk(await forgetIntentToAdd(root, intent), 'Discard');
      if (untracked.length || intent.length) await trash(root, [...untracked, ...intent]);
    });
  };

  const commitCmd = async (forceAll: boolean) => {
    const root = await repoRoot();
    if (!root) return;
    await state.refresh('status');
    const s = state.snapshot;
    if (s.changes.conflicts.length) {
      void vscode.window.showWarningMessage('Resolve the merge conflicts (and stage the files) before committing.');
      return;
    }
    const pending = s.changes.unstaged.length + s.changes.untracked.length;
    let all = forceAll;
    if (!s.changes.staged.length && !all) {
      if (!pending) {
        void vscode.window.showInformationMessage('There are no changes to commit.');
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        'There are no staged changes to commit. Stage all your changes and commit them directly?',
        { modal: true },
        'Stage All & Commit',
      );
      if (pick !== 'Stage All & Commit') return;
      all = true;
    }
    if (all && !pending && !s.changes.staged.length) {
      void vscode.window.showInformationMessage('There are no changes to commit.');
      return;
    }
    const branch = s.status?.branch.head ?? 'detached HEAD';
    const count = all ? s.changes.staged.length + pending : s.changes.staged.length;
    const message = await vscode.window.showInputBox({
      title: `Commit to ${branch} — ${folderName(root)}`,
      prompt: `${count} file${count === 1 ? '' : 's'}${all ? ' (all changes will be staged)' : ' staged'}`,
      placeHolder: 'Commit message',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Please enter a commit message.'),
    });
    if (!message?.trim()) return;
    await op(
      async () => {
        if (all) ensureOk(await stageAll(root), 'Stage');
        ensureOk(await commit(root, message), 'Commit');
      },
      { progress: 'Committing…', refreshProjects: true },
    );
  };

  /** After a "branch is checked out elsewhere" error, offer to show that worktree. */
  const handleCheckedOutElsewhere = async (stderr: string): Promise<boolean> => {
    const wt = parseCheckedOutElsewhere(stderr);
    if (!wt) return false;
    const pick = await vscode.window.showWarningMessage(`That branch is already checked out in the worktree ${tildify(wt)}.`, 'Show Worktree');
    if (pick === 'Show Worktree') selectPath(wt);
    return true;
  };

  const selectPath = (path: string) => {
    const projectId = store.selection?.projectId ?? store.findContaining(path)?.id;
    if (projectId) store.select(projectId, path);
  };

  const checkoutBranchInfo = async (b: BranchInfo) => {
    const root = await repoRoot();
    if (!root || b.isCurrent) return;
    if (!b.isRemote && b.worktreePath && b.worktreePath !== root) {
      await handleCheckedOutElsewhere(`already checked out at '${b.worktreePath}'`);
      return;
    }
    let result;
    if (b.isRemote) {
      const localName = b.name.slice((b.remote?.length ?? 0) + 1) || b.name;
      const existing = state.snapshot.branches.find((x) => !x.isRemote && x.name === localName);
      result = existing ? await checkout(root, localName) : await checkoutTracking(root, b.name, localName);
    } else {
      result = await checkout(root, b.name);
    }
    if (result.code !== 0 && (await handleCheckedOutElsewhere(result.stderr))) return;
    await op(async () => ensureOk(result, 'Checkout'), { refreshProjects: true });
  };

  const createBranchCmd = async () => {
    const root = await repoRoot();
    if (!root) return;
    const existing = new Set(state.snapshot.branches.filter((b) => !b.isRemote).map((b) => b.name));
    const name = await vscode.window.showInputBox({
      title: `New branch from ${state.snapshot.status?.branch.head ?? 'HEAD'}`,
      prompt: 'The new branch is created from the current commit and checked out.',
      placeHolder: 'Branch name',
      ignoreFocusOut: true,
      validateInput: async (v) => {
        const t = v.trim();
        if (!t) return 'Please enter a branch name.';
        if (existing.has(t)) return `A branch named "${t}" already exists.`;
        return (await isValidBranchName(root, t)) ? undefined : `"${t}" is not a valid branch name.`;
      },
    });
    if (!name?.trim()) return;
    await op(async () => ensureOk(await createBranch(root, name.trim()), 'Create branch'), { refreshProjects: true });
  };

  const checkoutPicker = async () => {
    const root = await repoRoot();
    if (!root) return;
    type Item = vscode.QuickPickItem & { branch?: BranchInfo; action?: 'create' };
    const s = state.snapshot;
    const local = s.branches.filter((b) => !b.isRemote).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || (b.committerDate ?? 0) - (a.committerDate ?? 0));
    const remote = s.branches.filter((b) => b.isRemote).sort((a, b) => a.name.localeCompare(b.name));
    const describe = (b: BranchInfo) =>
      [b.hash, b.committerDate ? shortAgo(b.committerDate) : '', b.isCurrent ? 'current' : '', b.worktreePath && !b.isCurrent ? `in ${folderName(b.worktreePath)}` : '']
        .filter(Boolean)
        .join(' · ');
    const items: Item[] = [
      { label: '$(plus) Create new branch…', action: 'create', alwaysShow: true },
      { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
      ...local.map((b) => ({ label: `${b.isCurrent ? '$(check)' : '$(git-branch)'} ${b.name}`, description: describe(b), detail: b.subject, branch: b })),
    ];
    if (remote.length) {
      items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
      items.push(...remote.map((b) => ({ label: `$(cloud) ${b.name}`, description: describe(b), detail: b.subject, branch: b })));
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `Switch branch — ${folderName(root)}`,
      placeHolder: 'Select a branch to check out',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;
    if (pick.action === 'create') await createBranchCmd();
    else if (pick.branch) await checkoutBranchInfo(pick.branch);
  };

  const deleteBranchCmd = async (node?: BranchNode) => {
    const root = await repoRoot();
    const b = node?.branch;
    if (!root || !b || b.isRemote || b.isCurrent) return;
    const ok = await vscode.window.showWarningMessage(`Delete branch "${b.name}"?`, { modal: true }, 'Delete Branch');
    if (ok !== 'Delete Branch') return;
    const r = await deleteBranch(root, b.name);
    if (r.code !== 0 && /not fully merged/.test(r.stderr)) {
      const force = await vscode.window.showWarningMessage(
        `The branch "${b.name}" is not fully merged. Delete it anyway?`,
        { modal: true, detail: 'Commits that only exist on this branch will be lost.' },
        'Force Delete',
      );
      if (force !== 'Force Delete') return;
      await op(async () => ensureOk(await deleteBranch(root, b.name, true), 'Delete branch'), { refreshProjects: true });
      return;
    }
    await op(async () => ensureOk(r, 'Delete branch'), { refreshProjects: true });
  };

  const pushCmd = async () => {
    const root = await repoRoot();
    if (!root) return;
    const branch = state.snapshot.status?.branch;
    if (!branch?.head) {
      void vscode.window.showWarningMessage('Cannot push a detached HEAD. Check out a branch first.');
      return;
    }
    let setUpstream: { remote: string; branch: string } | undefined;
    if (!branch.upstream) {
      const remotes = await getRemotes(root);
      if (!remotes.length) {
        void vscode.window.showWarningMessage('This repository has no remote to push to.');
        return;
      }
      const remote =
        remotes.length === 1
          ? remotes[0]
          : await vscode.window.showQuickPick(remotes, { title: `Publish ${branch.head}`, placeHolder: 'Pick a remote to publish the branch to' });
      if (!remote) return;
      setUpstream = { remote, branch: branch.head };
    }
    await op(async () => ensureOk(await push(root, setUpstream), 'Push'), {
      progress: setUpstream ? `Publishing ${branch.head}…` : `Pushing ${branch.head}…`,
      refreshProjects: true,
    });
  };

  const pullCmd = async () => {
    const root = await repoRoot();
    if (!root) return;
    const branch = state.snapshot.status?.branch;
    if (branch && !branch.upstream) {
      const pick = await vscode.window.showWarningMessage(`The branch "${branch.head ?? 'HEAD'}" has no upstream branch to pull from.`, 'Publish Branch');
      if (pick === 'Publish Branch') await pushCmd();
      return;
    }
    await op(async () => ensureOk(await pull(root), 'Pull'), { progress: 'Pulling…', refreshProjects: true });
  };

  const fetchCmd = async () => {
    const root = await repoRoot();
    if (!root) return;
    await op(async () => ensureOk(await fetch(root), 'Fetch'), { progress: 'Fetching…' });
  };

  const reg = vscode.commands.registerCommand;
  return vscode.Disposable.from(
    reg('claudeProjects.scm.refresh', () => state.refresh('all')),
    reg('claudeProjects.scm.openChange', openChange),
    reg('claudeProjects.scm.openFile', openFile),
    reg('claudeProjects.scm.openCommitFile', openCommitFile),
    reg('claudeProjects.scm.stage', stageCmd),
    reg('claudeProjects.scm.unstage', unstageCmd),
    reg('claudeProjects.scm.stageAll', async () => {
      const root = await repoRoot();
      if (root) await op(async () => ensureOk(await stageAll(root), 'Stage all'));
    }),
    reg('claudeProjects.scm.unstageAll', async () => {
      const root = await repoRoot();
      if (root) await op(async () => ensureOk(await unstageAll(root, state.snapshot.hasHead), 'Unstage all'));
    }),
    reg('claudeProjects.scm.discard', (node?: ScmNode, nodes?: ScmNode[]) => discardChanges(pickChanges(node, nodes, ['unstaged', 'untracked']), false)),
    reg('claudeProjects.scm.discardAll', async () => {
      const root = await repoRoot();
      if (!root) return;
      const s = state.snapshot;
      const list: ChangeNode[] = [...s.changes.unstaged, ...s.changes.untracked].map((c) => ({
        kind: 'change',
        id: '',
        change: c,
        root,
        path: join(root, c.path),
      }));
      if (!list.length) {
        void vscode.window.showInformationMessage('There are no changes to discard.');
        return;
      }
      await discardChanges(list, true);
    }),
    reg('claudeProjects.scm.commit', () => commitCmd(false)),
    reg('claudeProjects.scm.commitAll', () => commitCmd(true)),
    reg('claudeProjects.scm.checkout', checkoutPicker),
    reg('claudeProjects.scm.checkoutBranch', (node?: BranchNode) => (node?.branch ? checkoutBranchInfo(node.branch) : checkoutPicker())),
    reg('claudeProjects.scm.createBranch', createBranchCmd),
    reg('claudeProjects.scm.deleteBranch', deleteBranchCmd),
    reg('claudeProjects.scm.pull', pullCmd),
    reg('claudeProjects.scm.push', pushCmd),
    reg('claudeProjects.scm.fetch', fetchCmd),
    reg('claudeProjects.scm.copyCommitHash', async (node?: CommitNode) => {
      if (!node?.commit) return;
      await vscode.env.clipboard.writeText(node.commit.hash);
      void vscode.window.setStatusBarMessage(`Copied ${node.commit.short}`, 2000);
    }),
    reg('claudeProjects.scm.selectWorktree', (node?: WorktreeNode | { path?: string }) => {
      const p = node && 'worktree' in node ? node.worktree.path : node?.path;
      if (p) selectPath(p);
    }),
    reg('claudeProjects.scm.initRepo', async (node?: { path?: string }) => {
      const folder = node?.path ?? store.selection?.path;
      if (!folder) return;
      await op(async () => ensureOk(await runGit(folder, ['init']), 'git init'), { refreshProjects: true });
    }),
  );
}
