import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { Worktree } from '../../shared/types';
import type { Logger } from '../../util/log';
import { folderName, fsPathOf, isSameOrInside, tildify } from '../../util/paths';
import { listWorktrees } from '../../git/gitCli';
import type { BranchInfo } from '../../git/parse';
import { ensureExcluded, ensureOk, getBranches, getRepoInfo, isIgnored, isValidBranchName, worktreeAdd, worktreeRemove } from '../../git/repo';
import type { RepoStateService } from '../../git/RepoStateService';
import { refreshProjectsView, showGitError } from './scmCommands';

/** Where Claude Code keeps worktrees, relative to the main worktree. */
const WORKTREES_DIR = '.claude/worktrees';

function argPath(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object') return typeof arg === 'string' ? arg : undefined;
  if (arg instanceof vscode.Uri) return fsPathOf(arg);
  const a = arg as { path?: unknown; worktree?: { path?: unknown }; resourceUri?: unknown };
  if (a.worktree && typeof a.worktree.path === 'string') return a.worktree.path;
  if (typeof a.path === 'string') return a.path;
  if (a.resourceUri instanceof vscode.Uri) return fsPathOf(a.resourceUri);
  return undefined;
}

function argProjectId(arg: unknown): string | undefined {
  const id = arg && typeof arg === 'object' ? (arg as { projectId?: unknown }).projectId : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** Folder name for a branch: "feature/login" → "feature-login". */
export function worktreeDirName(branch: string): string {
  return (
    branch
      .replace(/[/\\]+/g, '-')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'worktree'
  );
}

export function registerWorktreeCommands(state: RepoStateService, store: ProjectStore, log: Logger): vscode.Disposable {
  const createWorktree = async (arg?: unknown) => {
    const base = argPath(arg) ?? store.selection?.path;
    if (!base) {
      void vscode.window.showWarningMessage('Select a project in the Projects view first.');
      return;
    }
    const info = await getRepoInfo(base);
    if (!info) {
      void vscode.window.showWarningMessage(`${folderName(base)} is not a git repository.`);
      return;
    }
    const worktrees = await listWorktrees(info.root);
    const main = worktrees.find((w) => w.isMain)?.path ?? info.root;
    const branches = await getBranches(info.root);
    const localNames = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));

    type Item = vscode.QuickPickItem & { action: 'new' | 'local' | 'remote'; branch?: BranchInfo };
    const free = branches.filter((b) => !b.isRemote && !b.isCurrent && !b.worktreePath);
    const remote = branches.filter((b) => b.isRemote && !localNames.has(b.name.slice((b.remote?.length ?? 0) + 1)));
    const items: Item[] = [{ label: '$(plus) New branch…', description: `from ${branches.find((b) => b.isCurrent)?.name ?? folderName(info.root)}`, action: 'new', alwaysShow: true }];
    if (free.length) {
      items.push({ label: 'Existing branches', kind: vscode.QuickPickItemKind.Separator, action: 'local' });
      items.push(...free.map((b) => ({ label: `$(git-branch) ${b.name}`, description: b.hash, detail: b.subject, action: 'local' as const, branch: b })));
    }
    if (remote.length) {
      items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator, action: 'remote' });
      items.push(...remote.map((b) => ({ label: `$(cloud) ${b.name}`, description: b.hash, detail: b.subject, action: 'remote' as const, branch: b })));
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `Create worktree — ${folderName(main)}`,
      placeHolder: 'Choose the branch the new worktree will check out',
      matchOnDetail: true,
    });
    if (!pick) return;

    let branchName: string;
    let opts: { newBranch?: string; branch?: string; base?: string };
    if (pick.action === 'new') {
      const name = await vscode.window.showInputBox({
        title: 'New worktree branch',
        prompt: `Created from the current commit of ${folderName(info.root)}. The worktree goes in ${WORKTREES_DIR}/.`,
        placeHolder: 'Branch name, e.g. feature/login',
        ignoreFocusOut: true,
        validateInput: async (v) => {
          const t = v.trim();
          if (!t) return 'Please enter a branch name.';
          if (localNames.has(t)) return `A branch named "${t}" already exists. Pick it from the list instead.`;
          return (await isValidBranchName(info.root, t)) ? undefined : `"${t}" is not a valid branch name.`;
        },
      });
      if (!name?.trim()) return;
      branchName = name.trim();
      opts = { newBranch: branchName, base: 'HEAD' };
    } else if (pick.action === 'local' && pick.branch) {
      branchName = pick.branch.name;
      opts = { branch: branchName };
    } else if (pick.branch) {
      branchName = pick.branch.name.slice((pick.branch.remote?.length ?? 0) + 1) || pick.branch.name;
      opts = { newBranch: branchName, base: pick.branch.name };
    } else {
      return;
    }

    const parent = join(main, WORKTREES_DIR);
    const dirName = worktreeDirName(branchName);
    let target = join(parent, dirName);
    for (let i = 2; existsSync(target); i++) target = join(parent, `${dirName}-${i}`);

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating worktree ${branchName}…` },
        async () => {
          await mkdir(parent, { recursive: true });
          if (!(await isIgnored(main, `${WORKTREES_DIR}/${dirName}`))) await ensureExcluded(info.commonDir, `${WORKTREES_DIR}/`);
          // Run from the worktree the user started from so "HEAD" means its current commit.
          ensureOk(await worktreeAdd(opts.base === 'HEAD' ? info.root : main, target, opts), 'Create worktree');
        },
      );
    } catch (err) {
      showGitError(err, log);
      return;
    }

    const projectId = argProjectId(arg) ?? store.findContaining(target)?.id ?? store.selection?.projectId;
    if (projectId) store.select(projectId, target);
    await refreshProjectsView();
    await state.refresh('all');
    const action = await vscode.window.showInformationMessage(
      `Created worktree "${branchName}" at ${tildify(target)}.`,
      'New Claude Session',
      'Open in New Window',
    );
    if (action === 'New Claude Session') {
      await vscode.commands.executeCommand('claudeProjects.newSession', { path: target, projectId });
    } else if (action === 'Open in New Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    }
  };

  const removeWorktree = async (arg?: unknown) => {
    let path = argPath(arg);
    let worktrees: Worktree[] = [];
    if (!path) {
      const sel = store.selection?.path;
      if (!sel) return;
      worktrees = await listWorktrees(sel);
      const linked = worktrees.filter((w) => !w.isMain);
      if (!linked.length) {
        void vscode.window.showInformationMessage('This repository has no other worktrees.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        linked.map((w) => ({ label: w.branch ?? folderName(w.path), description: tildify(w.path), path: w.path })),
        { title: 'Remove worktree', placeHolder: 'Pick the worktree to remove' },
      );
      if (!pick) return;
      path = pick.path;
    } else {
      worktrees = await listWorktrees(path);
    }
    const main = worktrees.find((w) => w.isMain);
    const wt = worktrees.find((w) => w.path === path);
    if (!main || !wt) {
      void vscode.window.showWarningMessage(`${tildify(path)} is not a git worktree.`);
      return;
    }
    if (wt.isMain) {
      void vscode.window.showWarningMessage('The main worktree cannot be removed.');
      return;
    }
    const label = wt.branch ?? folderName(wt.path);
    const ok = await vscode.window.showWarningMessage(
      `Remove the worktree "${label}"?`,
      { modal: true, detail: `The folder ${tildify(wt.path)} will be deleted.${wt.branch ? ` The branch "${wt.branch}" is kept.` : ''}` },
      'Remove Worktree',
    );
    if (ok !== 'Remove Worktree') return;
    let r = await worktreeRemove(main.path, wt.path);
    if (r.code !== 0 && /modified or untracked|--force|is locked|dirty/i.test(r.stderr)) {
      const force = await vscode.window.showWarningMessage(
        `The worktree "${label}" has uncommitted changes or is locked.`,
        { modal: true, detail: 'Force removing it deletes those changes permanently.' },
        'Force Remove',
      );
      if (force !== 'Force Remove') return;
      r = await worktreeRemove(main.path, wt.path, true);
    }
    try {
      ensureOk(r, 'Remove worktree');
    } catch (err) {
      showGitError(err, log);
      return;
    }
    const sel = store.selection;
    if (sel && isSameOrInside(sel.path, wt.path)) {
      const project = store.get(sel.projectId);
      store.select(sel.projectId, project && !isSameOrInside(project.path, wt.path) ? project.path : main.path);
    }
    await refreshProjectsView();
    await state.refresh('all');
    void vscode.window.setStatusBarMessage(`Removed worktree ${label}`, 3000);
  };

  return vscode.Disposable.from(
    vscode.commands.registerCommand('claudeProjects.createWorktree', createWorktree),
    vscode.commands.registerCommand('claudeProjects.removeWorktree', removeWorktree),
  );
}
