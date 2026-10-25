import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

export const PROPOSED_SCHEME = 'claude-projects-proposed';

/** In-memory documents for "before"/"after" sides of Claude's edits. */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private counter = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? '';
  }

  /** Stores content and returns a URI whose path keeps the file name (for syntax highlighting). */
  put(filePath: string, content: string, label: string): vscode.Uri {
    const id = `${++this.counter}-${label}`;
    this.docs.set(id, content);
    if (this.docs.size > 200) this.docs.delete(this.docs.keys().next().value!);
    return vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: filePath, query: id });
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.docs.clear();
  }
}

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function applyEdits(content: string, edits: EditSpec[]): string | undefined {
  let out = content;
  for (const e of edits) {
    if (e.old_string === '') {
      out = e.new_string + out;
      continue;
    }
    if (!out.includes(e.old_string)) return undefined;
    out = e.replace_all ? out.split(e.old_string).join(e.new_string) : out.replace(e.old_string, () => e.new_string);
  }
  return out;
}

function editsOf(name: string, input: Record<string, unknown>): EditSpec[] | undefined {
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all === true }];
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Array<Record<string, unknown>>)
      .filter((e) => typeof e.old_string === 'string' && typeof e.new_string === 'string')
      .map((e) => ({ old_string: e.old_string as string, new_string: e.new_string as string, replace_all: e.replace_all === true }));
  }
  return undefined;
}

const TRUNCATED = '… (truncated)';

/**
 * Opens VS Code's diff editor for an Edit/MultiEdit/Write tool call.
 * Pending (not yet applied): current file ↔ proposed content.
 * Applied: content before the edit (reconstructed) ↔ current file.
 */
export async function openToolDiff(provider: ProposedContentProvider, cwd: string, tool: { name: string; input: Record<string, unknown>; pending: boolean }): Promise<void> {
  const raw = tool.input.file_path ?? tool.input.notebook_path;
  if (typeof raw !== 'string') {
    void vscode.window.showWarningMessage('This tool call has no file to compare.');
    return;
  }
  const filePath = isAbsolute(raw) ? raw : join(cwd, raw);
  const fileUri = vscode.Uri.file(filePath);
  const name = basename(filePath);
  const current = await readFile(filePath, 'utf8').catch(() => undefined);
  if (JSON.stringify(tool.input).includes(TRUNCATED)) {
    void vscode.window.showWarningMessage('This change is too large to reconstruct; opening the file instead.');
    await vscode.window.showTextDocument(fileUri, { preview: true });
    return;
  }

  if (tool.name === 'Write') {
    const content = typeof tool.input.content === 'string' ? tool.input.content : '';
    if (tool.pending) {
      const left = current === undefined ? provider.put(filePath, '', 'empty') : fileUri;
      await vscode.commands.executeCommand('vscode.diff', left, provider.put(filePath, content, 'proposed'), `${name} (Proposed by Claude)`, { preview: true });
    } else {
      await vscode.window.showTextDocument(fileUri, { preview: true });
    }
    return;
  }

  const edits = editsOf(tool.name, tool.input);
  if (!edits?.length) {
    await vscode.window.showTextDocument(fileUri, { preview: true });
    return;
  }
  if (tool.pending) {
    const proposed = current === undefined ? undefined : applyEdits(current, edits);
    if (proposed === undefined) {
      void vscode.window.showWarningMessage(`The proposed change no longer matches ${name}.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', fileUri, provider.put(filePath, proposed, 'proposed'), `${name} (Proposed by Claude)`, { preview: true });
    return;
  }
  // Applied: undo the edits on the current content to rebuild the "before" side.
  const reversed = edits
    .slice()
    .reverse()
    .map((e) => ({ old_string: e.new_string, new_string: e.old_string, replace_all: e.replace_all }));
  const before = current === undefined ? undefined : applyEdits(current, reversed);
  if (before === undefined) {
    void vscode.window.showInformationMessage(`${name} has changed since this edit; opening the file.`);
    await vscode.window.showTextDocument(fileUri, { preview: true });
    return;
  }
  await vscode.commands.executeCommand('vscode.diff', provider.put(filePath, before, 'before'), fileUri, `${name} (Claude's edit)`, { preview: true });
}
