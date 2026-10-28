import * as vscode from 'vscode';
import { accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../util/exec';
import { toastScript, toastXml } from './windowsToast';
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
 * Native system notifications.
 *
 * macOS: terminal-notifier when installed (click opens the right session
 * through our URI handler); otherwise AppleScript's `display notification`
 * (click just focuses Script Editor's sender, so we keep it informative).
 *
 * Windows: a toast shown through Windows PowerShell; clicking it opens our URI
 * like terminal-notifier does.
 *
 * Elsewhere: VS Code's own notification.
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
    if (process.platform === 'win32') {
      if (await this.windowsToast(req)) return;
      void vscode.window.showInformationMessage(`${req.title}: ${req.message}`);
      return;
    }
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

  /** Shows a Windows toast; false when it could not be shown. */
  private async windowsToast(req: NotificationRequest): Promise<boolean> {
    const xml = toastXml({
      title: req.title,
      lines: [req.subtitle, req.message].filter((l): l is string => !!l),
      launch: req.openPath ? this.uriFor(req.openPath) : undefined,
      image: this.iconPath ? pathToFileURL(this.iconPath).toString() : undefined,
      sound: !!req.sound,
    });
    // Toasts with the same tag replace each other (one per session), like terminal-notifier's -group.
    const tag = req.group ? createHash('sha1').update(req.group).digest('hex').slice(0, 32) : undefined;
    const script = toastScript(xml, tag);
    // Windows PowerShell 5.1 (not pwsh): it is always installed and can load the WinRT toast types.
    const powershell = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const r = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeoutMs: 15_000 });
      if (r.code === 0) return true;
      this.log.warn(`Windows toast failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`);
    } catch (err) {
      this.log.warn(`Windows toast failed: ${(err as Error).message}`);
    }
    return false;
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
