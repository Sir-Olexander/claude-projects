import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { Logger } from '../../util/log';
import { errorMessage } from '../../util/log';
import { folderName, isSameOrInside } from '../../util/paths';
import type { RepoStateService } from '../../git/RepoStateService';
import type { FileNode, FilesTreeProvider } from './FilesTreeProvider';
import { transferInto, type TransferMode } from './moveFiles';

interface Ctx {
  provider: FilesTreeProvider;
  tree: vscode.TreeView<FileNode>;
  store: ProjectStore;
  state: RepoStateService;
  log: Logger;
}

const DOUBLE_CLICK_MS = 450;

function isEntry(n: unknown): n is FileNode {
  return !!n && typeof n === 'object' && (n as FileNode).kind === 'entry' && typeof (n as FileNode).path === 'string';
}

export function registerFilesCommands(ctx: Ctx): vscode.Disposable {
  const { provider, tree, store, state, log } = ctx;

  /**
   * Folder that new or pasted items go into: the clicked or selected folder (a
   * selected file's folder), or the root when nothing is selected. A selection
   * that no longer exists or belongs to another project is ignored.
   */
  const targetFolder = (arg?: unknown): string | undefined => {
    const root = provider.root;
    const usable = (n: FileNode | undefined) => !!n && !!root && isSameOrInside(n.path, root) && existsSync(n.path);
    const node = isEntry(arg) ? arg : tree.selection.find((n) => isEntry(n) && usable(n));
    if (node && usable(node)) return node.isDirectory ? node.path : dirname(node.path);
    return root;
  };

  const pick = (node: unknown, nodes: unknown): FileNode[] => {
    if (Array.isArray(nodes) && nodes.length && (!node || nodes.includes(node))) return nodes.filter(isEntry);
    if (isEntry(node)) return [node];
    return tree.selection.filter(isEntry);
  };

  const fail = (what: string, err: unknown) => {
    log.error(`${what}: ${errorMessage(err)}`);
    void vscode.window.showErrorMessage(`${what}: ${errorMessage(err)}`);
  };

  /** Validates a path typed by the user (relative to `folder`) and returns the absolute target, or an error. */
  const resolveNew = (folder: string, value: string, kind: 'file' | 'folder' = 'file'): { path?: string; error?: string } => {
    const v = value.trim();
    if (!v) return { error: 'Please enter a name.' };
    if (isAbsolute(v)) return { error: 'Use a path inside the project, like docs/notes.md.' };
    if (kind === 'file' && /[\\/]$/.test(v)) return { error: `Type a file name after "${v}".` };
    const target = normalize(join(folder, v));
    const root = provider.root ?? folder;
    if (!isSameOrInside(target, root)) return { error: 'The name must stay inside the project folder.' };
    if (existsSync(target)) return { error: `"${v}" already exists.` };
    return { path: target };
  };

  /** `opts.name` skips the input box (tests only). */
  const createEntry = async (kind: 'file' | 'folder', arg?: unknown, opts?: unknown) => {
    const folder = targetFolder(arg);
    const preset = opts && typeof opts === 'object' && !Array.isArray(opts) && typeof (opts as { name?: unknown }).name === 'string' ? (opts as { name: string }).name : undefined;
    if (!folder) {
      void vscode.window.showWarningMessage('Select a project in the Projects view first.');
      return;
    }
    const root = provider.root ?? folder;
    // The box starts with the target folder's path, so it's clear where the new item goes;
    // clearing it puts the item at the top level.
    const prefix = relative(root, folder) ? `${relative(root, folder).split(sep).join('/')}/` : '';
    const value =
      preset !== undefined
        ? prefix + preset
        : await vscode.window.showInputBox({
            title: kind === 'file' ? 'New File' : 'New Folder',
            prompt: `Path inside ${folderName(root)}. ${prefix ? `Delete "${prefix}" to create it at the top level.` : 'Add folder/ in front to put it in a folder.'}`,
            value: prefix,
            valueSelection: [prefix.length, prefix.length],
            placeHolder: kind === 'file' ? 'File name, e.g. notes.md or docs/notes.md' : 'Folder name, e.g. assets or docs/images',
            ignoreFocusOut: true,
            validateInput: (v) => (v === prefix ? undefined : resolveNew(root, v, kind).error),
          });
    if (value === undefined) return;
    const { path, error } = resolveNew(root, value, kind);
    if (!path) {
      if (error) void vscode.window.showWarningMessage(error);
      return;
    }
    try {
      const uri = vscode.Uri.file(path);
      if (kind === 'folder') {
        await vscode.workspace.fs.createDirectory(uri);
      } else {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(path)));
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
      }
    } catch (err) {
      fail(kind === 'file' ? 'Could not create the file' : 'Could not create the folder', err);
    }
  };

  let lastClick: { path: string; at: number } | undefined;
  const openFile = async (node?: FileNode) => {
    if (!isEntry(node) || node.isDirectory) return;
    const now = Date.now();
    // Second click on the same file within the double-click window pins the editor (like the Explorer).
    const pin = lastClick?.path === node.path && now - lastClick.at < DOUBLE_CLICK_MS;
    lastClick = pin ? undefined : { path: node.path, at: now };
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(node.path), { preview: !pin, preserveFocus: !pin });
  };

  const rename = async (node?: unknown) => {
    const n = isEntry(node) ? node : tree.selection.find(isEntry);
    if (!n) return;
    const name = basename(n.path);
    const stem = n.isDirectory ? name.length : name.length - extname(name).length;
    const value = await vscode.window.showInputBox({
      title: `Rename ${n.isDirectory ? 'Folder' : 'File'}`,
      value: name,
      valueSelection: [0, stem > 0 ? stem : name.length],
      ignoreFocusOut: true,
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return 'Please enter a name.';
        if (t.includes('/') || t.includes(sep)) return 'The name cannot contain "/".';
        if (t !== name && t.toLowerCase() !== name.toLowerCase() && existsSync(join(dirname(n.path), t))) return `"${t}" already exists.`;
        return undefined;
      },
    });
    const t = value?.trim();
    if (!t || t === name) return;
    const from = vscode.Uri.file(n.path);
    const to = vscode.Uri.file(join(dirname(n.path), t));
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(from, to, { overwrite: false });
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) await vscode.workspace.fs.rename(from, to, { overwrite: false });
    } catch (err) {
      fail('Could not rename', err);
    }
  };

  const remove = async (node?: unknown, nodes?: unknown) => {
    const list = pick(node, nodes);
    if (!list.length) return;
    const names = list.map((n) => basename(n.path) + (n.isDirectory ? '/' : ''));
    const message =
      list.length === 1
        ? `Are you sure you want to delete "${names[0]}"?`
        : `Are you sure you want to delete the following ${list.length} items?`;
    const detail =
      (list.length > 1 ? names.slice(0, 12).join('\n') + (names.length > 12 ? `\n…and ${names.length - 12} more` : '') + '\n\n' : '') +
      'You can restore from the Trash.';
    const ok = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Move to Trash');
    if (ok !== 'Move to Trash') return;
    for (const n of list) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(n.path), { recursive: true, useTrash: true });
      } catch (err) {
        fail(`Could not delete ${basename(n.path)}`, err);
      }
    }
  };

  // Cut / Copy / Paste, like the Explorer: paste moves (after Cut) or copies (after Copy).
  let clip: { mode: TransferMode; paths: string[] } | undefined;
  const setClip = (c: typeof clip) => {
    clip = c;
    void vscode.commands.executeCommand('setContext', 'claudeProjects.files.canPaste', !!c?.paths.length);
  };
  const cutOrCopy = (mode: TransferMode) => (node?: unknown, nodes?: unknown) => {
    const list = pick(node, nodes);
    if (list.length) setClip({ mode, paths: list.map((n) => n.path) });
  };
  const paste = async (node?: unknown) => {
    if (!clip) return;
    const dest = targetFolder(node);
    if (!dest) return;
    const { mode } = clip;
    const sources = clip.paths.filter((p) => existsSync(p));
    if (!sources.length) {
      setClip(undefined);
      return;
    }
    try {
      const r = await transferInto(sources, dest, mode);
      if (mode === 'move') setClip(undefined);
      const refused = r.skipped.filter((s) => s.reason !== 'already there' && s.reason !== 'kept the existing item');
      if (refused.length) void vscode.window.showWarningMessage(refused.map((s) => s.reason).join(' '));
    } catch (err) {
      fail(mode === 'move' ? 'Could not move' : 'Could not copy', err);
    }
  };

  const reg = vscode.commands.registerCommand;
  return vscode.Disposable.from(
    reg('claudeProjects.files.refresh', async () => {
      provider.refreshAll();
      await state.refresh('status');
    }),
    reg('claudeProjects.files.openFile', openFile),
    reg('claudeProjects.files.newFile', (arg?: unknown, opts?: unknown) => createEntry('file', arg, opts)),
    reg('claudeProjects.files.newFolder', (arg?: unknown, opts?: unknown) => createEntry('folder', arg, opts)),
    reg('claudeProjects.files.openToSide', async (node?: unknown, nodes?: unknown) => {
      for (const n of pick(node, nodes).filter((x) => !x.isDirectory)) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(n.path), { viewColumn: vscode.ViewColumn.Beside, preview: false });
      }
    }),
    reg('claudeProjects.files.rename', rename),
    reg('claudeProjects.files.cut', cutOrCopy('move')),
    reg('claudeProjects.files.copy', cutOrCopy('copy')),
    reg('claudeProjects.files.paste', paste),
    reg('claudeProjects.files.delete', remove),
    reg('claudeProjects.files.openRootInNewWindow', async () => {
      const p = store.selection?.path;
      if (!p) {
        void vscode.window.showWarningMessage('Select a project in the Projects view first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true });
    }),
  );
}
