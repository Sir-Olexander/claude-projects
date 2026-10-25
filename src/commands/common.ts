import * as vscode from 'vscode';
import { relative } from 'node:path';
import { statSync } from 'node:fs';
import type { ProjectStore } from '../projects/ProjectStore';
import { folderName } from '../util/paths';

/**
 * Pulls a filesystem path out of whatever a command was invoked with:
 * a string, a Uri, one of our tree nodes ({ path } or { resourceUri }), or nothing
 * (then the current selection).
 */
export function resolvePathArg(arg: unknown, store?: ProjectStore): string | undefined {
  if (!arg) return store?.selection?.path;
  if (typeof arg === 'string') return arg;
  if (arg instanceof vscode.Uri) return arg.fsPath;
  if (typeof arg === 'object') {
    const a = arg as { path?: unknown; fsPath?: unknown; resourceUri?: unknown; uri?: unknown };
    if (typeof a.path === 'string' && a.path.startsWith('/')) return a.path;
    if (typeof a.fsPath === 'string') return a.fsPath;
    if (a.resourceUri instanceof vscode.Uri) return a.resourceUri.fsPath;
    if (a.uri instanceof vscode.Uri) return a.uri.fsPath;
  }
  return store?.selection?.path;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Shared commands used by several views (Projects, Source Control, Files). */
export function registerCommonCommands(store: ProjectStore): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('claudeProjects.openInNewWindow', async (arg?: unknown) => {
      const p = resolvePathArg(arg, store);
      if (!p) return;
      const target = isDirectory(p) ? p : undefined;
      if (!target) {
        void vscode.window.showWarningMessage(`"${folderName(p)}" is not a folder.`);
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('claudeProjects.revealInFinder', async (arg?: unknown) => {
      const p = resolvePathArg(arg, store);
      if (p) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
    }),
    vscode.commands.registerCommand('claudeProjects.openTerminal', (arg?: unknown) => {
      const p = resolvePathArg(arg, store);
      if (!p) return;
      const cwd = isDirectory(p) ? p : vscode.Uri.file(p).with({ path: vscode.Uri.joinPath(vscode.Uri.file(p), '..').path }).fsPath;
      const t = vscode.window.createTerminal({ name: folderName(cwd), cwd });
      t.show();
    }),
    vscode.commands.registerCommand('claudeProjects.copyPath', async (arg?: unknown) => {
      const p = resolvePathArg(arg, store);
      if (p) await vscode.env.clipboard.writeText(p);
    }),
    vscode.commands.registerCommand('claudeProjects.copyRelativePath', async (arg?: unknown) => {
      const p = resolvePathArg(arg, store);
      if (!p) return;
      const root = store.findContaining(p)?.path ?? store.selection?.path;
      await vscode.env.clipboard.writeText(root ? relative(root, p) || '.' : p);
    }),
  );
}
