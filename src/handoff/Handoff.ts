import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { debounce } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import { realPath, stripTrailingSep } from '../util/paths';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const MAX_AGE_MS = 3 * 60_000;

interface HandoffRequest {
  id: string;
  folder: string;
  /** Session to resume; omitted for a new conversation. */
  sessionId?: string;
  prompt?: string;
  createdAt: number;
}

interface HandoffFile {
  requests: HandoffRequest[];
}

/**
 * "Open in Claude extension": opens the session's folder in its own VS Code
 * window and resumes the session in the official Claude Code extension there
 * (what vscode://anthropic.claude-code/open?session=<id> does).
 *
 * URIs are routed to whichever window was focused last, so instead of firing
 * the URI from here we leave a request in a file shared by all windows. The
 * copy of this extension running in the window that has the folder open picks
 * it up and opens the session in that window.
 */
export class HandoffService implements vscode.Disposable {
  private readonly file: string;
  private watcher: FSWatcher | undefined;
  private readonly check = debounce(() => void this.processPending(), 150);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
  ) {
    const dir = context.globalStorageUri.fsPath;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'handoff.json');
  }

  start(): void {
    void this.processPending();
    try {
      this.watcher = watch(this.context.globalStorageUri.fsPath, (_e, f) => {
        if (f && f.toString() === 'handoff.json') this.check();
      });
    } catch (err) {
      this.log.warn(`handoff watcher failed: ${errorMessage(err)}`);
    }
    // A window that becomes focused (e.g. it already had the folder open) re-checks.
    this.context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && this.check()));
  }

  /** True when the official Claude Code extension is installed. */
  static isClaudeExtensionInstalled(): boolean {
    return !!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  }

  async openInClaudeExtension(folder: string, sessionId?: string, prompt?: string): Promise<void> {
    const target = stripTrailingSep(realPath(folder));
    if (this.isOpenHere(target)) {
      await this.openHere(sessionId, prompt);
      return;
    }
    this.write((f) => {
      f.requests = f.requests.filter((r) => Date.now() - r.createdAt < MAX_AGE_MS && !(r.folder === target && r.sessionId === sessionId));
      f.requests.push({ id: randomUUID(), folder: target, sessionId, prompt, createdAt: Date.now() });
    });
    this.log.info(`handoff: opening ${target} in a new window${sessionId ? ` to resume ${sessionId}` : ''}`);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
  }

  private workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => stripTrailingSep(realPath(f.uri.fsPath)));
  }

  private isOpenHere(folder: string): boolean {
    return this.workspaceFolders().includes(folder);
  }

  private read(): HandoffFile {
    try {
      const f = JSON.parse(readFileSync(this.file, 'utf8')) as HandoffFile;
      return Array.isArray(f?.requests) ? f : { requests: [] };
    } catch {
      return { requests: [] };
    }
  }

  private write(mutate: (f: HandoffFile) => void): void {
    const f = this.read();
    mutate(f);
    try {
      writeFileSync(this.file, JSON.stringify(f));
    } catch (err) {
      this.log.warn(`handoff write failed: ${errorMessage(err)}`);
    }
  }

  private async processPending(): Promise<void> {
    const folders = this.workspaceFolders();
    if (!folders.length) return;
    const now = Date.now();
    const all = this.read().requests;
    const mine = all.filter((r) => now - r.createdAt < MAX_AGE_MS && folders.includes(r.folder));
    if (!mine.length) {
      if (all.some((r) => now - r.createdAt >= MAX_AGE_MS)) this.write((f) => (f.requests = f.requests.filter((r) => now - r.createdAt < MAX_AGE_MS)));
      return;
    }
    const ids = new Set(mine.map((r) => r.id));
    this.write((f) => (f.requests = f.requests.filter((r) => !ids.has(r.id) && now - r.createdAt < MAX_AGE_MS)));
    for (const r of mine) await this.openHere(r.sessionId, r.prompt);
  }

  /** Opens the session in the official extension in this window. */
  private async openHere(sessionId?: string, prompt?: string): Promise<void> {
    const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
    if (!ext) {
      void vscode.window.showErrorMessage('The Claude Code extension (anthropic.claude-code) is not installed, so the session cannot be opened there.');
      return;
    }
    try {
      await ext.activate();
    } catch (err) {
      this.log.warn(`activating Claude Code failed: ${errorMessage(err)}`);
    }
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId, prompt);
      return;
    } catch (err) {
      this.log.warn(`claude-vscode.primaryEditor.open failed (${errorMessage(err)}); using the URI handler`);
    }
    const query = new URLSearchParams();
    if (sessionId) query.set('session', sessionId);
    if (prompt) query.set('prompt', prompt);
    await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://${CLAUDE_EXTENSION_ID}/open?${query.toString()}`));
  }

  dispose(): void {
    this.check.cancel();
    this.watcher?.close();
  }
}
