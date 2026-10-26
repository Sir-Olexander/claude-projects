import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isSameOrInside } from '../../util/paths';
import { copyName, transferProblem, type TransferMode } from './transferRules';

export type { TransferMode } from './transferRules';

export interface TransferResult {
  /** Paths that were created in the destination. */
  done: string[];
  /** Items left alone, with the reason. */
  skipped: { path: string; reason: string }[];
}

/**
 * Moves or copies files and folders into destDir. A name that already exists
 * there asks whether to replace it. Moves go through a WorkspaceEdit, so open
 * editors follow the file (and language extensions can update imports).
 */
export async function transferInto(sources: string[], destDir: string, mode: TransferMode): Promise<TransferResult> {
  const result: TransferResult = { done: [], skipped: [] };
  // A folder and something inside it: only the folder needs to go.
  const list = [...new Set(sources)].filter((p, _, all) => !all.some((o) => o !== p && isSameOrInside(p, o)));
  for (const source of list) {
    const problem = transferProblem(source, destDir, mode);
    if (problem) {
      result.skipped.push({ path: source, reason: problem });
      continue;
    }
    let name = basename(source);
    if (mode === 'copy' && dirname(source) === destDir) name = copyName(destDir, name);
    const target = join(destDir, name);
    let overwrite = false;
    if (existsSync(target)) {
      const pick = await vscode.window.showWarningMessage(
        `"${name}" already exists in "${basename(destDir)}". Replace it?`,
        { modal: true, detail: 'The existing item is moved to the Trash.' },
        'Replace',
      );
      if (pick !== 'Replace') {
        result.skipped.push({ path: source, reason: 'kept the existing item' });
        continue;
      }
      await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
      overwrite = true;
    }
    const from = vscode.Uri.file(source);
    const to = vscode.Uri.file(target);
    if (mode === 'copy') {
      await vscode.workspace.fs.copy(from, to, { overwrite });
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(from, to, { overwrite });
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) await vscode.workspace.fs.rename(from, to, { overwrite });
    }
    result.done.push(target);
  }
  return result;
}
