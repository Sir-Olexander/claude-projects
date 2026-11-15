import { Emitter } from '../util/events';
import type { SessionFlagName } from '../shared/protocol';
import { isSessionFlag } from '../shared/flags';

/**
 * A mark the user puts on a session, separate from its automatic status
 * (needs you, running, finished, idle, error): what they mean to do with it.
 */
export type SessionFlag = SessionFlagName;

/** Where flags are saved (global state in VS Code, a Map in tests). */
export interface FlagStorage {
  load(): Record<string, SessionFlag>;
  save(flags: Record<string, SessionFlag>): void;
}

/** Session flags by session id, shared by all windows through global state. */
export class SessionFlags {
  private flags: Record<string, SessionFlag>;
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly storage: FlagStorage) {
    this.flags = clean(storage.load());
  }

  get(sessionId: string | undefined): SessionFlag | undefined {
    return sessionId ? this.flags[sessionId] : undefined;
  }

  /** Sets a session's flag; `undefined` clears it. */
  set(sessionId: string, flag: SessionFlag | undefined): void {
    if (this.flags[sessionId] === flag) return;
    if (flag) this.flags[sessionId] = flag;
    else delete this.flags[sessionId];
    this.storage.save({ ...this.flags });
    this._onDidChange.fire();
  }

  /** Session ids carrying a flag. */
  withFlag(flag: SessionFlag): string[] {
    return Object.keys(this.flags).filter((id) => this.flags[id] === flag);
  }

  /** Picks up changes made in other windows. */
  reload(): void {
    const next = clean(this.storage.load());
    if (JSON.stringify(next) === JSON.stringify(this.flags)) return;
    this.flags = next;
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function clean(raw: Record<string, unknown> | undefined): Record<string, SessionFlag> {
  const out: Record<string, SessionFlag> = {};
  for (const [id, f] of Object.entries(raw ?? {})) if (isSessionFlag(f)) out[id] = f;
  return out;
}
