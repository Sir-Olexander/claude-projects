import * as vscode from 'vscode';
import { basename, dirname } from 'node:path';
import type { Logger } from '../../util/log';
import { errorMessage } from '../../util/log';
import { isSameOrInside } from '../../util/paths';
import type { FileNode, FilesTreeProvider } from './FilesTreeProvider';
import { transferInto, type TransferMode } from './moveFiles';
import { dropFolder } from './transferRules';

/** Our own drag data: the dragged paths. */
export const FILES_MIME = 'application/vnd.code.tree.claudeprojects.files';

/**
 * Drag and drop in the Files view: dragging items onto a folder (or a file in
 * it, or the empty space for the top level) moves them there. Files dragged in
 * from outside the project (Finder, the Explorer) are copied. Dragging files
 * out to the editor opens them.
 */
export class FilesDragAndDrop implements vscode.TreeDragAndDropController<FileNode> {
  readonly dragMimeTypes = ['text/uri-list'];
  readonly dropMimeTypes = [FILES_MIME, 'text/uri-list'];

  constructor(
    private readonly provider: FilesTreeProvider,
    private readonly log: Logger,
  ) {}

  handleDrag(sources: readonly FileNode[], data: vscode.DataTransfer): void {
    const paths = sources.filter((s) => s.kind === 'entry').map((s) => s.path);
    if (!paths.length) return;
    data.set(FILES_MIME, new vscode.DataTransferItem(paths));
    data.set('text/uri-list', new vscode.DataTransferItem(paths.map((p) => vscode.Uri.file(p).toString()).join('\r\n')));
  }

  async handleDrop(target: FileNode | undefined, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const root = this.provider.root;
    if (!root) return;
    const dest = dropFolder(target, root);
    let paths: string[] = [];
    let mode: TransferMode = 'move';
    const ours = data.get(FILES_MIME);
    if (ours) {
      const v = ours.value;
      paths = Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : parsePaths(await ours.asString());
    } else {
      const uris = data.get('text/uri-list');
      if (!uris) return;
      paths = (await uris.asString())
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          try {
            const u = vscode.Uri.parse(l);
            return u.scheme === 'file' ? u.fsPath : '';
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      // Things from inside the project move; things from elsewhere are copied in.
      mode = paths.every((p) => isSameOrInside(p, root)) ? 'move' : 'copy';
    }
    if (!paths.length || token.isCancellationRequested) return;
    if (mode === 'move' && paths.every((p) => dirname(p) === dest)) return; // dropped where it already is

    if (!(await this.confirm(paths, dest, root, mode))) return;
    try {
      const r = await transferInto(paths, dest, mode);
      const refused = r.skipped.filter((s) => s.reason !== 'already there' && s.reason !== 'kept the existing item');
      if (refused.length) void vscode.window.showWarningMessage(refused.map((s) => s.reason).join(' '));
    } catch (err) {
      this.log.error(`Files view: ${mode} failed: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Could not ${mode} the files: ${errorMessage(err)}`);
    }
  }

  private async confirm(paths: string[], dest: string, root: string, mode: TransferMode): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('claudeProjects.files');
    if (!cfg.get<boolean>('confirmDragAndDrop', true)) return true;
    const where = dest === root ? 'the top level' : `"${basename(dest)}"`;
    const what = paths.length === 1 ? `"${basename(paths[0])}"` : `${paths.length} items`;
    const verb = mode === 'move' ? 'Move' : 'Copy';
    const dontAsk = `${verb}, Don't Ask Again`;
    const pick = await vscode.window.showInformationMessage(`${verb} ${what} into ${where}?`, { modal: true }, verb, dontAsk);
    if (pick === dontAsk) await cfg.update('confirmDragAndDrop', false, vscode.ConfigurationTarget.Global);
    return pick === verb || pick === dontAsk;
  }
}

function parsePaths(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
