import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { Emitter, type Event, debounce } from '../util/events';
import type { Logger } from '../util/log';
import { silentLogger } from '../util/log';
import { isUuid } from './paths';
import { parseSessionInfo, readHeadTail, type SessionInfo } from './sessionInfo';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  info: SessionInfo | undefined;
}

export interface SessionIndexChange {
  /** cwds whose session list changed. */
  cwds: Set<string>;
}

/**
 * Index of every Claude Code session on this machine, grouped by working
 * directory. Reads ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl and keeps
 * it up to date with a recursive file watcher.
 */
export class SessionIndex {
  private readonly cache = new Map<string, CacheEntry>();
  private byCwd = new Map<string, SessionInfo[]>();
  private byId = new Map<string, SessionInfo>();
  private watcher: FSWatcher | undefined;
  private dirtyFiles = new Set<string>();
  private dirtyDirs = new Set<string>();
  private scanning: Promise<void> | undefined;
  private readonly log: Logger;
  private ready = false;

  private readonly _onDidChange = new Emitter<SessionIndexChange>();
  readonly onDidChange: Event<SessionIndexChange> = this._onDidChange.event;

  private readonly flushDirty = debounce(() => void this.processDirty(), 400);

  constructor(
    readonly projectsDir: string,
    log?: Logger,
  ) {
    this.log = log ?? silentLogger;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Full scan of every project directory. */
  async scanAll(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const started = Date.now();
      let dirs: string[] = [];
      try {
        dirs = (await readdir(this.projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(this.projectsDir, d.name));
      } catch {
        dirs = [];
      }
      const files: string[] = [];
      for (const dir of dirs) {
        try {
          for (const f of await readdir(dir)) if (f.endsWith('.jsonl') && isUuid(f.slice(0, -6))) files.push(join(dir, f));
        } catch {
          // ignore unreadable dirs
        }
      }
      const seen = new Set(files);
      for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key);
      await mapLimit(files, 8, (f) => this.updateFile(f));
      this.rebuild();
      this.ready = true;
      this.log.info(`session index: ${this.byId.size} sessions in ${this.byCwd.size} folders (${Date.now() - started} ms)`);
      this._onDidChange.fire({ cwds: new Set(this.byCwd.keys()) });
    })().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  /** Re-reads one transcript if it changed. Returns true when its info changed. */
  private async updateFile(filePath: string): Promise<boolean> {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      const had = this.cache.delete(filePath);
      return had;
    }
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return false;
    const ht = await readHeadTail(filePath);
    const sessionId = basename(filePath, '.jsonl');
    const info = ht ? parseSessionInfo(sessionId, filePath, ht) : undefined;
    this.cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, info });
    return true;
  }

  private rebuild(): Set<string> {
    const before = this.byCwd;
    const byCwd = new Map<string, SessionInfo[]>();
    const byId = new Map<string, SessionInfo>();
    for (const { info } of this.cache.values()) {
      if (!info) continue;
      const cwd = info.cwd ?? dirname(info.filePath);
      const list = byCwd.get(cwd);
      if (list) list.push(info);
      else byCwd.set(cwd, [info]);
      const prev = byId.get(info.sessionId);
      if (!prev || prev.lastModified < info.lastModified) byId.set(info.sessionId, info);
    }
    for (const list of byCwd.values()) list.sort((a, b) => b.lastModified - a.lastModified);
    const changed = new Set<string>();
    for (const [cwd, list] of byCwd) {
      const old = before.get(cwd);
      if (!old || old.length !== list.length || old.some((o, i) => o.sessionId !== list[i].sessionId || o.lastModified !== list[i].lastModified || o.title !== list[i].title)) changed.add(cwd);
    }
    for (const cwd of before.keys()) if (!byCwd.has(cwd)) changed.add(cwd);
    this.byCwd = byCwd;
    this.byId = byId;
    return changed;
  }

  /** Sessions whose cwd is exactly `cwd`, newest first. */
  sessionsFor(cwd: string): readonly SessionInfo[] {
    return this.byCwd.get(cwd) ?? [];
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.byId.get(sessionId);
  }

  /** Most recently active sessions first, keeping those `keep` accepts, up to `limit`. */
  recent(limit: number, keep: (info: SessionInfo) => boolean): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const info of [...this.byId.values()].sort((a, b) => b.lastModified - a.lastModified)) {
      if (out.length >= limit) break;
      if (keep(info)) out.push(info);
    }
    return out;
  }

  /** Every known cwd with its session count and latest activity. */
  allCwds(): { cwd: string; count: number; lastModified: number }[] {
    return [...this.byCwd.entries()].map(([cwd, list]) => ({ cwd, count: list.length, lastModified: list[0]?.lastModified ?? 0 }));
  }

  /** Force re-reading a transcript soon (e.g. after our own process wrote to it). */
  touch(filePath: string): void {
    this.dirtyFiles.add(filePath);
    this.flushDirty();
  }

  startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.projectsDir, { recursive: true }, (_event, filename) => {
        if (!filename) {
          this.dirtyDirs.add('*');
          this.flushDirty();
          return;
        }
        const rel = filename.toString();
        const parts = rel.split(sep);
        if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
          this.dirtyFiles.add(join(this.projectsDir, rel));
          this.flushDirty();
        } else if (parts.length === 1) {
          this.dirtyDirs.add(join(this.projectsDir, rel));
          this.flushDirty();
        }
      });
      this.watcher.on('error', (err) => {
        this.log.warn(`session index watcher error: ${err.message}`);
      });
    } catch (err) {
      this.log.warn(`cannot watch ${this.projectsDir}: ${(err as Error).message}`);
    }
  }

  private async processDirty(): Promise<void> {
    if (this.dirtyDirs.has('*')) {
      this.dirtyDirs.clear();
      this.dirtyFiles.clear();
      const before = new Set(this.byCwd.keys());
      await this.scanAll();
      void before;
      return;
    }
    const files = new Set(this.dirtyFiles);
    this.dirtyFiles.clear();
    for (const dir of this.dirtyDirs) {
      try {
        for (const f of await readdir(dir)) if (f.endsWith('.jsonl') && isUuid(f.slice(0, -6))) files.add(join(dir, f));
      } catch {
        // dir removed: drop its files
        for (const key of [...this.cache.keys()]) if (dirname(key) === dir) files.add(key);
      }
    }
    this.dirtyDirs.clear();
    let any = false;
    await mapLimit([...files], 8, async (f) => {
      if (await this.updateFile(f)) any = true;
    });
    if (!any) return;
    const changed = this.rebuild();
    if (changed.size) this._onDidChange.fire({ cwds: changed });
  }

  dispose(): void {
    this.flushDirty.cancel();
    this.watcher?.close();
    this.watcher = undefined;
    this._onDidChange.dispose();
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch {
        // keep going
      }
    }
  });
  await Promise.all(workers);
}
