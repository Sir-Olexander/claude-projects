import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Emitter, type Event, debounce } from '../util/events';
import { normalizeDrive } from '../util/paths';
import { run } from '../util/exec';
import type { Logger } from '../util/log';
import { silentLogger } from '../util/log';

/**
 * One running Claude Code process, as Claude Code itself advertises it in
 * ~/.claude/sessions/<pid>.json (terminal, VS Code extension, desktop app, SDK).
 */
export interface LiveEntry {
  pid: number;
  sessionId?: string;
  cwd: string;
  /** "busy" | "idle" | "waiting" (newer CLIs may add values). */
  status?: string;
  /** When status is "waiting": "permission prompt", "input needed", "dialog open", … */
  waitingFor?: string;
  name?: string;
  nameSource?: string;
  /** "cli", "claude-vscode", "claude-desktop", "sdk-ts", … */
  entrypoint?: string;
  kind?: string;
  startedAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
  version?: string;
  procStart?: string;
}

export function parseLiveEntry(raw: unknown): LiveEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const pid = typeof o.pid === 'number' ? o.pid : Number(o.pid);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof o.cwd !== 'string') return undefined;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
  return {
    pid,
    sessionId: str('sessionId'),
    cwd: normalizeDrive(o.cwd),
    status: str('status'),
    waitingFor: str('waitingFor'),
    name: str('name'),
    nameSource: str('nameSource'),
    entrypoint: str('entrypoint'),
    kind: str('kind'),
    startedAt: num('startedAt'),
    updatedAt: num('updatedAt'),
    statusUpdatedAt: num('statusUpdatedAt'),
    version: str('version'),
    procStart: str('procStart'),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class LiveRegistry {
  private entriesByPid = new Map<number, LiveEntry>();
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** pid -> procStart verified with `ps` (to detect reused pids from stale files). */
  private verified = new Map<number, string | null>();
  private readonly log: Logger;
  private reading = false;
  private rereadQueued = false;

  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  private readonly scheduleRead = debounce(() => void this.read(), 150);

  constructor(
    readonly dir: string,
    log?: Logger,
  ) {
    this.log = log ?? silentLogger;
  }

  get entries(): LiveEntry[] {
    return [...this.entriesByPid.values()];
  }

  bySessionId(sessionId: string): LiveEntry[] {
    return this.entries.filter((e) => e.sessionId === sessionId);
  }

  start(pollMs = 4000): void {
    void this.read();
    try {
      this.watcher = watch(this.dir, () => this.scheduleRead());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // The directory may not exist yet; polling covers it.
    }
    this.pollTimer = setInterval(() => {
      if (!this.watcher) {
        try {
          this.watcher = watch(this.dir, () => this.scheduleRead());
        } catch {
          // still missing
        }
      }
      void this.read();
    }, pollMs);
  }

  async read(): Promise<void> {
    if (this.reading) {
      this.rereadQueued = true;
      return;
    }
    this.reading = true;
    try {
      let files: string[] = [];
      try {
        files = (await readdir(this.dir)).filter((f) => /^\d+\.json$/.test(f));
      } catch {
        files = [];
      }
      const next = new Map<number, LiveEntry>();
      await Promise.all(
        files.map(async (f) => {
          try {
            const entry = parseLiveEntry(JSON.parse(await readFile(join(this.dir, f), 'utf8')));
            if (entry && isAlive(entry.pid)) next.set(entry.pid, entry);
          } catch {
            // being written; next read picks it up
          }
        }),
      );
      await this.dropReusedPids(next);
      if (!sameEntries(this.entriesByPid, next)) {
        this.entriesByPid = next;
        this._onDidChange.fire();
      }
    } finally {
      this.reading = false;
      if (this.rereadQueued) {
        this.rereadQueued = false;
        this.scheduleRead();
      }
    }
  }

  /** A file left behind by a crashed process can point at a pid the OS gave to something else. */
  private async dropReusedPids(entries: Map<number, LiveEntry>): Promise<void> {
    // procStart is `ps` output; Windows has no `ps` to compare it with.
    if (process.platform === 'win32') return;
    const unverified = [...entries.values()].filter((e) => e.procStart && !this.verified.has(e.pid));
    if (unverified.length) {
      try {
        // Same format Claude Code writes: C locale, UTC.
        const r = await run('ps', ['-o', 'pid=,lstart=', '-p', unverified.map((e) => e.pid).join(',')], { timeoutMs: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
        const starts = new Map<number, string>();
        for (const line of r.stdout.split('\n')) {
          const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
          if (m) starts.set(Number(m[1]), m[2].replace(/\s+/g, ' '));
        }
        for (const e of unverified) this.verified.set(e.pid, starts.get(e.pid) ?? null);
      } catch {
        for (const e of unverified) this.verified.set(e.pid, null);
      }
    }
    for (const e of [...entries.values()]) {
      const actual = this.verified.get(e.pid);
      if (!e.procStart || actual === undefined || actual === null) continue;
      if (actual !== e.procStart.replace(/\s+/g, ' ')) {
        this.log.debug(`live registry: ignoring stale entry for reused pid ${e.pid}`);
        entries.delete(e.pid);
      }
    }
    for (const pid of [...this.verified.keys()]) if (!entries.has(pid) && !isAlive(pid)) this.verified.delete(pid);
  }

  dispose(): void {
    this.scheduleRead.cancel();
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this._onDidChange.dispose();
  }
}

function sameEntries(a: Map<number, LiveEntry>, b: Map<number, LiveEntry>): boolean {
  if (a.size !== b.size) return false;
  for (const [pid, e] of b) {
    const o = a.get(pid);
    if (!o) return false;
    if (o.status !== e.status || o.waitingFor !== e.waitingFor || o.name !== e.name || o.sessionId !== e.sessionId || o.statusUpdatedAt !== e.statusUpdatedAt || o.cwd !== e.cwd) return false;
  }
  return true;
}
