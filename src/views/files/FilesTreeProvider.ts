import * as vscode from 'vscode';
import { dirname } from 'node:path';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { Logger } from '../../util/log';
import { errorMessage } from '../../util/log';
import { isSameOrInside, tildify } from '../../util/paths';
import { filesResourceUri } from '../../git/GitDecorationProvider';
import type { RepoStateService } from '../../git/RepoStateService';
import { buildExcludeMatcher, listDirectory, type ExcludeConfig, type ExcludeMatcher } from './fsModel';

/** Entries shown per folder before "… more" (huge folders would make the tree sluggish). */
const MAX_ENTRIES = 3000;

export interface FileNode {
  kind: 'entry' | 'more';
  /** Absolute path (for 'more': the folder it belongs to). */
  path: string;
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  /** For 'more': how many entries were left out. */
  hidden?: number;
}

export class FilesTreeProvider implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _root: string | undefined;
  /** Node objects by path; VS Code identifies elements by reference, so we reuse them. */
  private readonly nodes = new Map<string, FileNode>();
  private exclude: ExcludeMatcher = () => false;
  private readonly pendingDirs = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly state: RepoStateService,
    private readonly store: ProjectStore,
    private readonly log: Logger,
  ) {
    this.setRoot(store.selection?.path);
    this.disposables.push(
      store.onDidChangeSelection((sel) => this.setRoot(sel?.path)),
      state.onDidCreateOrDelete((uri) => this.queueRefresh(dirname(uri.fsPath))),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('files.exclude')) {
          this.rebuildExclude();
          this.refreshAll();
        }
      }),
    );
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
    this._onDidChangeTreeData.dispose();
  }

  get root(): string | undefined {
    return this._root;
  }

  private setRoot(root: string | undefined): void {
    if (root === this._root) return;
    this._root = root;
    this.nodes.clear();
    this.pendingDirs.clear();
    this.rebuildExclude();
    this._onDidChangeTreeData.fire();
  }

  private rebuildExclude(): void {
    const scope = this._root ? vscode.Uri.file(this._root) : undefined;
    const cfg = vscode.workspace.getConfiguration('files', scope).get<ExcludeConfig>('exclude');
    this.exclude = buildExcludeMatcher(cfg);
  }

  refreshAll(): void {
    this.nodes.clear();
    this._onDidChangeTreeData.fire();
  }

  /** Re-read one folder soon (batched). */
  private queueRefresh(dir: string): void {
    if (!this._root || !isSameOrInside(dir, this._root)) return;
    this.pendingDirs.add(dir);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const dirs = [...this.pendingDirs];
      this.pendingDirs.clear();
      if (dirs.length > 40 || dirs.includes(this._root!)) {
        this._onDidChangeTreeData.fire();
        return;
      }
      for (const d of dirs) {
        const node = this.nodes.get(d);
        if (node) this._onDidChangeTreeData.fire(node);
      }
    }, 300);
  }

  /** The node object for a path, if VS Code has been given one. */
  nodeFor(path: string): FileNode | undefined {
    return this.nodes.get(path);
  }

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    const root = this._root;
    if (!root) return [];
    if (element && (element.kind !== 'entry' || !element.isDirectory)) return [];
    const dir = element ? element.path : root;
    try {
      const { entries, total } = await listDirectory(dir, { root, exclude: this.exclude, limit: MAX_ENTRIES });
      if (this._root !== root) return [];
      const out: FileNode[] = entries.map((e) => {
        let n = this.nodes.get(e.path);
        if (!n || n.kind !== 'entry') {
          n = { kind: 'entry', path: e.path, name: e.name, isDirectory: e.isDirectory, isSymlink: e.isSymlink };
          this.nodes.set(e.path, n);
        } else {
          n.isDirectory = e.isDirectory;
          n.isSymlink = e.isSymlink;
        }
        return n;
      });
      if (total > entries.length) {
        out.push({ kind: 'more', path: dir, name: '', isDirectory: false, isSymlink: false, hidden: total - entries.length });
      }
      return out;
    } catch (err) {
      if (!element) this.log.warn(`Files view: cannot read ${dir}: ${errorMessage(err)}`);
      return [];
    }
  }

  getParent(element: FileNode): FileNode | undefined {
    if (!this._root || element.path === this._root) return undefined;
    const parent = dirname(element.path);
    if (parent === this._root || !isSameOrInside(parent, this._root)) return undefined;
    return this.nodes.get(parent);
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    if (node.kind === 'more') {
      const item = new vscode.TreeItem(`${node.hidden!.toLocaleString()} more items not shown`, vscode.TreeItemCollapsibleState.None);
      item.id = `files:more:${node.path}`;
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.tooltip = 'This folder has too many entries to list here. Use Reveal in Finder or Quick Open (⌘P) instead.';
      return item;
    }
    const item = new vscode.TreeItem(
      node.name,
      node.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `files:${node.path}`;
    item.resourceUri = filesResourceUri(node.path, node.isDirectory);
    item.iconPath = node.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    item.contextValue = node.isDirectory ? 'files.folder' : 'files.file';
    item.tooltip = tildify(node.path) + (node.isSymlink ? ' (symlink)' : '');
    if (!node.isDirectory) {
      item.command = { command: 'claudeProjects.files.openFile', title: 'Open', arguments: [node] };
    }
    return item;
  }
}
