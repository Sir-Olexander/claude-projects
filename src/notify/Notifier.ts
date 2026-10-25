import * as vscode from 'vscode';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../util/exec';
import type { Logger } from '../util/log';

export interface NotificationRequest {
  title: string;
  subtitle?: string;
  message: string;
  /** Notifications with the same group replace each other (one per session). */
  group?: string;
  /** Our URI path + query to open when clicked, e.g. "/session?key=…". */
  openPath?: string;
  sound?: boolean;
}

/**
 * Native macOS notifications. Uses terminal-notifier when installed (click
 * opens the right session through our URI handler); otherwise AppleScript's
 * `display notification` (click just focuses Script Editor's sender, so we
 * keep it informative).
 */
export class Notifier {
  private terminalNotifier: string | undefined | null = null;

  constructor(
    private readonly extensionId: string,
    private readonly iconPath: string | undefined,
    private readonly log: Logger,
  ) {}

  private findTerminalNotifier(): string | undefined {
    if (this.terminalNotifier !== null) return this.terminalNotifier;
    const candidates = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier', ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'terminal-notifier'))];
    this.terminalNotifier = candidates.find((c) => {
      try {
        accessSync(c, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    return this.terminalNotifier;
  }

  uriFor(path: string): string {
    return `${vscode.env.uriScheme}://${this.extensionId}${path}`;
  }

  async notify(req: NotificationRequest): Promise<void> {
    if (process.platform !== 'darwin') {
      // Elsewhere VS Code's own notification is the best we have.
      void vscode.window.showInformationMessage(`${req.title}: ${req.message}`);
      return;
    }
    const tn = this.findTerminalNotifier();
    try {
      if (tn) {
        const args = ['-title', req.title, '-message', safeLead(req.message || ' ')];
        if (req.subtitle) args.push('-subtitle', safeLead(req.subtitle));
        if (req.group) args.push('-group', `claude-projects-${req.group}`);
        if (req.openPath) args.push('-open', this.uriFor(req.openPath));
        else args.push('-activate', vscode.env.appName.includes('Insiders') ? 'com.microsoft.VSCodeInsiders' : 'com.microsoft.VSCode');
        if (req.sound) args.push('-sound', 'default');
        if (this.iconPath) args.push('-contentImage', pathToFileURL(this.iconPath).toString());
        const r = await run(tn, args, { timeoutMs: 10_000 });
        if (r.code === 0) return;
        this.log.warn(`terminal-notifier failed (${r.code}): ${r.stderr.trim()}`);
      }
      const script = `display notification ${appleString(req.message)} with title ${appleString(req.title)}${req.subtitle ? ` subtitle ${appleString(req.subtitle)}` : ''}${req.sound ? ' sound name "Glass"' : ''}`;
      const r = await run('osascript', ['-e', script], { timeoutMs: 10_000 });
      if (r.code !== 0) this.log.warn(`osascript notification failed: ${r.stderr.trim()}`);
    } catch (err) {
      this.log.warn(`notification failed: ${(err as Error).message}`);
    }
  }
}

function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

/** terminal-notifier treats a leading "-" or "[" specially. */
function safeLead(s: string): string {
  const one = s.replace(/[\r\n]+/g, ' ');
  return /^[-[]/.test(one) ? `\u200b${one}` : one;
}
