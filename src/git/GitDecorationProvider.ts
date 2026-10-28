import * as vscode from 'vscode';
import { fsPathOf } from '../util/paths';
import { colorForChange, type RepoStateService } from './RepoStateService';

/**
 * Status letters and colors for the Source Control and Files views.
 *
 * Only URIs carrying our query marker are decorated (`?cp=scm…` / `?cp=files…`),
 * so the regular Explorer and the built-in git decorations are unaffected.
 */
export const SCM_MARK = 'scm';
export const FILES_MARK = 'files';

export function scmResourceUri(absPath: string, letter: string, group: string, tooltip: string): vscode.Uri {
  const q = new URLSearchParams({ cp: SCM_MARK, s: letter, g: group, t: tooltip });
  return vscode.Uri.file(absPath).with({ query: q.toString() });
}

export function filesResourceUri(absPath: string, isDirectory: boolean): vscode.Uri {
  return vscode.Uri.file(absPath).with({ query: isDirectory ? `cp=${FILES_MARK}&d=1` : `cp=${FILES_MARK}` });
}

export class GitDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly state: RepoStateService) {
    // Any change in git state may recolor files in the Files view.
    this.sub = state.onDidChange(() => this._onDidChange.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !uri.query.startsWith('cp=')) return undefined;
    const q = new URLSearchParams(uri.query);
    const mark = q.get('cp');
    if (mark === SCM_MARK) {
      const letter = q.get('s') ?? '';
      const group = q.get('g') ?? '';
      const color = colorForChange(group, letter);
      return new vscode.FileDecoration(letter || undefined, q.get('t') ?? undefined, color ? new vscode.ThemeColor(color) : undefined);
    }
    if (mark === FILES_MARK) {
      const d = this.state.decorationFor(fsPathOf(uri), q.get('d') === '1');
      if (!d) return undefined;
      return new vscode.FileDecoration(d.letter, d.tooltip, d.colorId ? new vscode.ThemeColor(d.colorId) : undefined);
    }
    return undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}
