import * as vscode from 'vscode';
import { mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { ClaudeProcess } from '../claude/ClaudeProcess';
import type { GetUsageResponse, SdkRateLimitEvent } from '../claude/sdkTypes';
import { toView } from './usageView';
import type { UsageView, UsageWindowView } from '../shared/protocol';
import { Emitter } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import { clockTime, countdown, longAgo, setTimeLocale } from '../util/time';

interface CacheFile {
  fetchedAt: number;
  usage: UsageView;
}

export interface UsageDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  getCliPath(): Promise<string | undefined>;
  getPathEnv(): Promise<string>;
  /** A live Claude process we can ask instead of starting a new one. */
  anyLiveProcess(): ClaudeProcess | undefined;
}

/**
 * Plan usage limits (5-hour and weekly) in the status bar. Data comes from
 * the CLI's `get_usage` control request — the same numbers as /usage — so
 * authentication stays inside Claude Code. Results are shared between
 * windows through a small cache file, and live `rate_limit_event`s from
 * running sessions update the bar in between polls.
 */
export class UsageService implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private usage: UsageView | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private fetching: Promise<void> | undefined;
  private watcher: FSWatcher | undefined;
  private readonly cachePath: string;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChange = new Emitter<UsageView | undefined>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly deps: UsageDeps) {
    setTimeLocale(vscode.env.language);
    const dir = deps.context.globalStorageUri.fsPath;
    mkdirSync(dir, { recursive: true });
    this.cachePath = join(dir, 'usage.json');
    this.item = vscode.window.createStatusBarItem('claudeProjects.usage', vscode.StatusBarAlignment.Right, 1000);
    this.item.name = 'Claude Usage';
    this.item.command = 'claudeProjects.openDashboard';
    this.readCache();
    this.render();
    this.applyVisibility();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeProjects.usage')) {
          this.applyVisibility();
          this.restartTimer();
        }
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.isStale()) void this.refresh();
      }),
    );
    try {
      this.watcher = watch(dir, (_e, f) => {
        if (f && f.toString() === 'usage.json') {
          this.readCache();
          this.render();
        }
      });
    } catch {
      // polling still works
    }
  }

  get current(): UsageView | undefined {
    return this.usage;
  }

  start(): void {
    if (this.isStale()) void this.refresh();
    this.restartTimer();
    // Keep the countdown text fresh.
    this.tick = setInterval(() => this.render(), 60_000);
  }

  private intervalMs(): number {
    const min = vscode.workspace.getConfiguration('claudeProjects').get<number>('usage.refreshIntervalMinutes', 5);
    return Math.max(1, min) * 60_000;
  }

  private restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.isStale()) void this.refresh();
    }, Math.min(this.intervalMs(), 60_000));
  }

  private isStale(): boolean {
    return !this.usage?.fetchedAt || Date.now() - this.usage.fetchedAt > this.intervalMs() - 15_000;
  }

  private applyVisibility(): void {
    if (vscode.workspace.getConfiguration('claudeProjects').get<boolean>('usage.showInStatusBar', true)) this.item.show();
    else this.item.hide();
  }

  /** Fetches fresh numbers (deduplicated if a fetch is already running). */
  refresh(force = false): Promise<void> {
    if (!force && this.fetching) return this.fetching;
    this.fetching = this.fetch().finally(() => {
      this.fetching = undefined;
    });
    return this.fetching;
  }

  private async fetch(): Promise<void> {
    this.item.text = this.text() + ' $(sync~spin)';
    try {
      const res = await this.getUsage();
      const usage = toView(res);
      usage.fetchedAt = Date.now();
      this.usage = usage;
      this.writeCache();
    } catch (err) {
      this.deps.log.warn(`usage fetch failed: ${errorMessage(err)}`);
      this.usage = { ...(this.usage ?? { others: [] }), error: errorMessage(err), fetchedAt: Date.now() };
    }
    this.render();
    this._onDidChange.fire(this.usage);
  }

  private async getUsage(): Promise<GetUsageResponse> {
    const live = this.deps.anyLiveProcess();
    if (live?.alive) {
      try {
        return await live.request<GetUsageResponse>({ subtype: 'get_usage', skip_behaviors: true }, 20_000);
      } catch (err) {
        this.deps.log.debug(`get_usage on live process failed, using a utility process: ${errorMessage(err)}`);
      }
    }
    const cliPath = await this.deps.getCliPath();
    if (!cliPath) throw new Error('Claude Code CLI not found');
    const proc = new ClaudeProcess({
      cliPath,
      cwd: this.deps.context.globalStorageUri.fsPath,
      noSessionPersistence: true,
      safeMode: true,
      strictMcpConfig: true,
      includePartialMessages: false,
      pathEnv: await this.deps.getPathEnv(),
      log: this.deps.log,
    });
    proc.start();
    try {
      await proc.initialize();
      return await proc.request<GetUsageResponse>({ subtype: 'get_usage', skip_behaviors: true }, 30_000);
    } finally {
      void proc.close(1500);
    }
  }

  /** Live update from a running session (utilization is 0–1 there). */
  onRateLimitEvent(e: SdkRateLimitEvent): void {
    const windows = e.rate_limit_info?.unifiedWindows;
    if (!windows) return;
    const next: UsageView = { ...(this.usage ?? { others: [] }) };
    const conv = (w: { utilization?: number; resetsAt?: number } | undefined, prev?: UsageWindowView): UsageWindowView | undefined =>
      w && typeof w.utilization === 'number'
        ? { percent: Math.round(w.utilization * 100), resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : (prev?.resetsAt ?? null) }
        : prev;
    next.fiveHour = conv(windows.five_hour, next.fiveHour);
    next.sevenDay = conv(windows.seven_day, next.sevenDay);
    next.error = undefined;
    this.usage = next;
    this.render();
    this._onDidChange.fire(this.usage);
  }

  private readCache(): void {
    try {
      const c = JSON.parse(readFileSync(this.cachePath, 'utf8')) as CacheFile;
      if (c?.usage && (!this.usage?.fetchedAt || c.fetchedAt > this.usage.fetchedAt)) {
        this.usage = { ...c.usage, fetchedAt: c.fetchedAt };
        this._onDidChange.fire(this.usage);
      }
    } catch {
      // no cache yet
    }
  }

  private writeCache(): void {
    if (!this.usage?.fetchedAt) return;
    try {
      writeFileSync(this.cachePath, JSON.stringify({ fetchedAt: this.usage.fetchedAt, usage: this.usage } satisfies CacheFile));
    } catch {
      // ignore
    }
  }

  private text(): string {
    const u = this.usage;
    if (!u || (!u.fiveHour && !u.sevenDay)) return u?.error ? '$(pulse) Claude usage $(warning)' : '$(pulse) Claude usage';
    const part = (label: string, w: UsageWindowView | undefined, short: (ms: number) => string) => {
      if (!w || w.percent === null) return undefined;
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      return `${label} ${w.percent}%${Number.isNaN(reset) ? '' : ` · ${short(reset)}`}`;
    };
    const five = part('5h', u.fiveHour, (t) => countdown(t));
    const week = part('Wk', u.sevenDay, (t) => weekday(t));
    return `$(pulse) ${[five, week].filter(Boolean).join('  ')}`;
  }

  private render(): void {
    const u = this.usage;
    this.item.text = this.text();
    const max = Math.max(u?.fiveHour?.percent ?? 0, u?.sevenDay?.percent ?? 0, ...(u?.others ?? []).map((o) => o.window.percent ?? 0));
    this.item.backgroundColor = max >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground') : max >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.supportThemeIcons = true;
    md.isTrusted = { enabledCommands: ['claudeProjects.refreshUsage', 'claudeProjects.openDashboard'] };
    md.appendMarkdown(`**Claude plan usage**${u?.subscription ? ` · ${capitalize(u.subscription)}` : ''}\n\n`);
    if (!u || (!u.fiveHour && !u.sevenDay)) {
      md.appendMarkdown(u?.error ? `Couldn't read usage: ${escapeMd(u.error)}\n\n` : 'Loading…\n\n');
    } else {
      md.appendMarkdown('| | Used | Resets |\n|:--|--:|:--|\n');
      const row = (label: string, w: UsageWindowView | undefined) => {
        if (!w) return;
        const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
        const when = Number.isNaN(reset) ? '—' : `in ${countdown(reset)} (${clockTime(reset)})`;
        md.appendMarkdown(`| ${label} | ${w.percent === null ? '—' : `${bar(w.percent)} ${w.percent}%`} | ${when} |\n`);
      };
      row('5-hour', u.fiveHour);
      row('Weekly', u.sevenDay);
      for (const o of u.others) row(`Weekly · ${escapeMd(o.label)}`, o.window);
      md.appendMarkdown('\n');
    }
    if (u?.fetchedAt) md.appendMarkdown(`Updated ${longAgo(u.fetchedAt)}${u.error ? ` · last attempt failed` : ''} · `);
    md.appendMarkdown('[$(refresh) Refresh](command:claudeProjects.refreshUsage) · [$(pulse) Sessions dashboard](command:claudeProjects.openDashboard)');
    this.item.tooltip = md;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.tick) clearInterval(this.tick);
    this.watcher?.close();
    for (const d of this.disposables) d.dispose();
    this.item.dispose();
    this._onDidChange.dispose();
  }
}

function bar(pct: number): string {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 10);
  return '▰'.repeat(n) + '▱'.repeat(10 - n);
}

function weekday(t: number): string {
  const d = new Date(t);
  const soon = t - Date.now() < 24 * 3600_000;
  return soon ? countdown(t) : d.toLocaleDateString(vscode.env.language || undefined, { weekday: 'short' });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
