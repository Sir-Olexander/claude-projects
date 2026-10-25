import * as vscode from 'vscode';
import { showFile } from './repo';

/** URI scheme for read-only file versions shown in diff editors. */
export const GIT_SCHEME = 'claude-projects-git';

/** Ref meaning "no file" (the empty side of an added/deleted file diff). */
export const EMPTY_REF = '~empty';

export interface GitUriParams {
  /** Repository (worktree) root the ref is resolved in. */
  repo: string;
  /** '' = index, '~1'/'~2'/'~3' = merge stages, EMPTY_REF = empty, otherwise a revision. */
  ref: string;
  /** Repo-relative path, forward slashes. */
  rel: string;
}

/** The URI path is the real file path so the editor picks the right language and icon. */
export function toGitUri(absPath: string, params: GitUriParams): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: absPath, query: JSON.stringify(params) });
}

export function fromGitUri(uri: vscode.Uri): GitUriParams | undefined {
  try {
    const p = JSON.parse(uri.query) as Partial<GitUriParams>;
    if (typeof p.repo === 'string' && typeof p.ref === 'string' && typeof p.rel === 'string') return p as GitUriParams;
  } catch {
    // fall through
  }
  return undefined;
}

const BINARY_SNIFF = 8000;

export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  /** Open documents whose content can change (index / HEAD), by uri string. */
  private readonly mutable = new Map<string, vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === GIT_SCHEME) this.mutable.delete(doc.uri.toString());
      }),
    );
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = fromGitUri(uri);
    if (!p || p.ref === EMPTY_REF) return '';
    if (p.ref === '' || p.ref === 'HEAD' || /^~[123]$/.test(p.ref)) this.mutable.set(uri.toString(), uri);
    const content = await showFile(p.repo, p.ref, p.rel);
    if (content === undefined) return '';
    const head = content.slice(0, BINARY_SNIFF);
    if (head.includes('\0')) return `Binary file (${content.length.toLocaleString()} bytes) — not shown.`;
    return content;
  }

  /** Tell open diff editors that index/HEAD content of this repo may have changed. */
  refreshRepo(repoRoot: string): void {
    for (const uri of this.mutable.values()) {
      const p = fromGitUri(uri);
      if (p?.repo === repoRoot) this._onDidChange.fire(uri);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
