import * as vscode from 'vscode';
import { dirname, isAbsolute, relative } from 'node:path';
import { statSync } from 'node:fs';
import type { ProjectStore } from '../projects/ProjectStore';
import { folderName, fsPathOf, normalizeDrive } from '../util/paths';

/**
 * Pulls a filesystem path out of whatever a command was invoked with:
 * a string, a Uri, one of our tree nodes ({ path } or { resourceUri }), or nothing
 * (then the current selection).
 */
export function resolvePathArg(arg: unknown, store?: ProjectStore): string | undefined {
  if (!arg) return store?.selection?.path;
  if (typeof arg === 'string') return arg;
  if (arg instanceof vscode.Uri) return fsPathOf(arg);
  if (typeof arg === 'object') {
    const a = arg as { path?: unknown; fsPath?: unknown; scheme?: unknown; resourceUri?: unknown; uri?: unknown };
    // Our tree nodes carry a file system path; a Uri-like object's .path is a URI path ("/c:/…" on Windows).
    if (typeof a.path === 'string' && typeof a.scheme !== 'string' && isAbsolute(a.path)) return a.path;
    if (typeof a.fsPath === 'string') return normalizeDrive(a.fsPath);
    if (a.resourceUri instanceof vscode.Uri) return fsPathOf(a.resourceUri);
    if (a.uri instanceof vscode.Uri) return fsPathOf(a.uri);
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

/**
 * Terminal title for a folder: the project's name, plus the folder inside it
 * ("CVFast", "CVFast · backend", "CVFast · feature-x" for a worktree).
 */
export function terminalName(cwd: string, store: ProjectStore): string {
  const project = store.findContaining(cwd);
  if (!project) {
    // A worktree outside the project folder still belongs to the selected project.
    const sel = store.selection;
    const owner = sel && sel.path === cwd ? store.get(sel.projectId) : undefined;
    return owner ? `${owner.name} · ${folderName(cwd)}` : folderName(cwd);
  }
  const rel = relative(project.path, cwd);
  return rel ? `${project.name} · ${rel}` : project.name;
}

/** Opens an integrated terminal in a folder (or in a file's folder), titled after its project. */
export function openTerminalAt(path: string, store: ProjectStore): vscode.Terminal {
  const cwd = isDirectory(path) ? path : dirname(path);
  const where = vscode.workspace.getConfiguration('claudeProjects').get<'editor' | 'panel'>('terminal.location', 'editor');
  const t = vscode.window.createTerminal({
    name: terminalName(cwd, store),
    cwd,
    iconPath: new vscode.ThemeIcon('terminal'),
    // "editor": a tab next to the Claude sessions; "panel": the bottom terminal panel.
    location: where === 'panel' ? vscode.TerminalLocation.Panel : { viewColumn: vscode.ViewColumn.Active },
  });
  t.show();
  return t;
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
    // Same command, titled "Reveal in Finder" on macOS and "Reveal in File Explorer" on Windows.
    ...['claudeProjects.revealInFinder', 'claudeProjects.revealInExplorer'].map((id) =>
      vscode.commands.registerCommand(id, async (arg?: unknown) => {
        const p = resolvePathArg(arg, store);
        if (p) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
      }),
    ),
    vscode.commands.registerCommand('claudeProjects.openTerminal', (arg?: unknown) => {
      const p = resolvePathArg(arg, store);
      if (p) openTerminalAt(p, store);
    }),
    vscode.commands.registerCommand('claudeProjects.files.openRootInTerminal', () => {
      const p = store.selection?.path;
      if (p) openTerminalAt(p, store);
      else void vscode.window.showInformationMessage('Select a project in the Projects view first.');
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
