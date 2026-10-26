import * as vscode from 'vscode';
import type { ProjectStore } from '../projects/ProjectStore';
import type { Logger } from '../util/log';
import { folderName, tildify } from '../util/paths';
import { GitContentProvider, GIT_SCHEME } from '../git/GitContentProvider';
import { GitDecorationProvider } from '../git/GitDecorationProvider';
import { RepoStateService } from '../git/RepoStateService';
import { ScmTreeProvider, type ScmNode } from './scm/ScmTreeProvider';
import { registerScmCommands } from './scm/scmCommands';
import { registerWorktreeCommands } from './scm/worktreeCommands';
import { FilesDragAndDrop } from './files/filesDragAndDrop';
import { FilesTreeProvider, type FileNode } from './files/FilesTreeProvider';
import { registerFilesCommands } from './files/filesCommands';

const SCM_VIEW = 'claudeProjects.scm';
const FILES_VIEW = 'claudeProjects.files';

const OPERATION_MESSAGES: Record<string, string> = {
  merge: 'Merge in progress: resolve the conflicts, stage the files, then commit.',
  rebase: 'Rebase in progress. Finish or abort it in a terminal (git rebase --continue / --abort).',
  'cherry-pick': 'Cherry-pick in progress: resolve the conflicts, stage the files, then commit.',
  revert: 'Revert in progress: resolve the conflicts, stage the files, then commit.',
  bisect: 'Bisect in progress.',
};

export interface GitViewsInternals {
  state: RepoStateService;
  scm: ScmTreeProvider;
  scmView: vscode.TreeView<ScmNode>;
  files: FilesTreeProvider;
  filesView: vscode.TreeView<FileNode>;
  filesDnd: FilesDragAndDrop;
  decorations: GitDecorationProvider;
  content: GitContentProvider;
}

let internals: GitViewsInternals | undefined;

/** For integration tests only: the objects behind the last registered views. */
export function getGitViewsForTesting(): GitViewsInternals | undefined {
  return internals;
}

/**
 * Registers the per-project Source Control and Files views. Both follow the
 * project/worktree selected in the Projects view (ProjectStore.selection).
 */
export function registerGitViews(_context: vscode.ExtensionContext, store: ProjectStore, log: Logger): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  const content = new GitContentProvider();
  disposables.push(content, vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, content));

  const state = new RepoStateService(store, content, log);
  disposables.push(state);

  const decorations = new GitDecorationProvider(state);
  disposables.push(decorations, vscode.window.registerFileDecorationProvider(decorations));

  const scm = new ScmTreeProvider(state, store);
  const scmView = vscode.window.createTreeView<ScmNode>(SCM_VIEW, { treeDataProvider: scm, canSelectMany: true });
  const files = new FilesTreeProvider(state, store, log);
  const filesDnd = new FilesDragAndDrop(files, log);
  const filesView = vscode.window.createTreeView<FileNode>(FILES_VIEW, { treeDataProvider: files, canSelectMany: true, showCollapseAll: true, dragAndDropController: filesDnd });
  disposables.push(scm, scmView, files, filesView);

  const updateViewText = () => {
    const sel = store.selection;
    const project = sel ? store.get(sel.projectId) : undefined;
    const s = state.snapshot;
    if (!sel || !project) {
      scmView.description = filesView.description = undefined;
      scmView.message = filesView.message = store.projects.length
        ? 'Select a project or worktree in the Projects view.'
        : 'Add a project in the Projects view to see its source control and files.';
      return;
    }
    const isWorktree = sel.path !== project.path;
    const place = isWorktree ? `${project.name} · ${folderName(sel.path)}` : project.name;
    filesView.description = place;
    if (!s.folderExists && s.folder === sel.path && !s.loading) {
      scmView.description = place;
      scmView.message = filesView.message = `Folder not found: ${tildify(sel.path)}`;
      return;
    }
    filesView.message = undefined;
    if (s.loading || s.folder !== sel.path) {
      scmView.description = place;
      scmView.message = undefined;
      return;
    }
    if (!s.repo) {
      scmView.description = place;
      scmView.message = `${folderName(sel.path)} is not a git repository.`;
      return;
    }
    const b = s.status?.branch;
    const branch = b?.head ?? (b?.oid ? `${b.oid.slice(0, 7)} (detached)` : undefined);
    scmView.description = isWorktree ? place : branch ? `${project.name} · ${branch}` : project.name;
    scmView.message = s.operation ? OPERATION_MESSAGES[s.operation] : undefined;
  };
  disposables.push(
    state.onDidChange(updateViewText),
    store.onDidChangeSelection(updateViewText),
    store.onDidChangeProjects(updateViewText),
  );
  updateViewText();

  // Only keep git data fresh while one of the views is on screen.
  state.setViewVisible(SCM_VIEW, scmView.visible);
  state.setViewVisible(FILES_VIEW, filesView.visible);
  disposables.push(
    scmView.onDidChangeVisibility((e) => state.setViewVisible(SCM_VIEW, e.visible)),
    filesView.onDidChangeVisibility((e) => state.setViewVisible(FILES_VIEW, e.visible)),
  );

  disposables.push(
    registerScmCommands({ state, store, tree: scmView, log }),
    registerWorktreeCommands(state, store, log),
    registerFilesCommands({ provider: files, tree: filesView, store, state, log }),
  );

  if (scmView.visible || filesView.visible) void state.refresh('all');

  internals = { state, scm, scmView, files, filesView, filesDnd, decorations, content };
  disposables.push({ dispose: () => (internals = undefined) });
  return vscode.Disposable.from(...disposables);
}
