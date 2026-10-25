import { randomUUID, createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface PresenceFile {
  id: string;
  /** Extension host pid (to detect windows that crashed without cleaning up). */
  pid: number;
  focused: boolean;
  updatedAt: number;
  /** Claude processes this window runs ("Open here" sessions). */
  claudePids: number[];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Lets the copies of this extension running in different VS Code windows
 * coordinate through small files in the shared global storage folder:
 * which window is focused, which Claude processes belong to which window,
 * and who sends a given notification (so it is sent once, not once per window).
 */
export class WindowPresence {
  readonly id = randomUUID();
  private readonly dir: string;
  private readonly lockDir: string;
  private focused = false;
  private claudePids: number[] = [];

  constructor(storageDir: string) {
    this.dir = join(storageDir, 'windows');
    this.lockDir = join(storageDir, 'notify-locks');
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.lockDir, { recursive: true });
    this.cleanup();
  }

  private file(id = this.id): string {
    return join(this.dir, `${id}.json`);
  }

  private write(): void {
    const data: PresenceFile = { id: this.id, pid: process.pid, focused: this.focused, updatedAt: Date.now(), claudePids: this.claudePids };
    try {
      writeFileSync(this.file(), JSON.stringify(data));
    } catch {
      // ignore
    }
  }

  setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.write();
  }

  setClaudePids(pids: number[]): void {
    const sorted = [...pids].sort((a, b) => a - b);
    if (sorted.join(',') === this.claudePids.join(',')) return;
    this.claudePids = sorted;
    this.write();
  }

  start(focused: boolean): void {
    this.focused = focused;
    this.write();
  }

  private others(): PresenceFile[] {
    const out: PresenceFile[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const f of files) {
      if (!f.endsWith('.json') || f === `${this.id}.json`) continue;
      try {
        const p = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as PresenceFile;
        if (p && typeof p.pid === 'number' && alive(p.pid)) out.push(p);
      } catch {
        // being written
      }
    }
    return out;
  }

  /** True when another VS Code window (running this extension) has focus. */
  anotherWindowFocused(): boolean {
    return this.others().some((p) => p.focused);
  }

  /** Claude processes run by Claude Projects in other windows. */
  otherWindowsClaudePids(): Set<number> {
    const pids = new Set<number>();
    for (const p of this.others()) for (const pid of p.claudePids ?? []) pids.add(pid);
    return pids;
  }

  /**
   * Returns true for exactly one window per key (atomic file creation), so a
   * notification about a shared event is sent once.
   */
  claim(key: string): boolean {
    const name = createHash('sha1').update(key).digest('hex').slice(0, 20);
    try {
      closeSync(openSync(join(this.lockDir, name), 'wx'));
      return true;
    } catch {
      return false;
    }
  }

  /** Removes presence files of dead windows and old notification locks. */
  cleanup(): void {
    const now = Date.now();
    try {
      for (const f of readdirSync(this.lockDir)) {
        const p = join(this.lockDir, f);
        try {
          if (now - statSync(p).mtimeMs > 6 * 3600_000) unlinkSync(p);
        } catch {
          // ignore
        }
      }
      for (const f of readdirSync(this.dir)) {
        const p = join(this.dir, f);
        try {
          const data = JSON.parse(readFileSync(p, 'utf8')) as PresenceFile;
          if (!alive(data.pid)) unlinkSync(p);
        } catch {
          try {
            if (now - statSync(p).mtimeMs > 3600_000) unlinkSync(p);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  dispose(): void {
    try {
      unlinkSync(this.file());
    } catch {
      // ignore
    }
  }
}
