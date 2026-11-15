import type { SessionFlagName } from './protocol';

/** Session flags in menu order. */
export const SESSION_FLAGS: readonly SessionFlagName[] = ['main', 'review', 'waiting', 'parked', 'trash'];

/** Label, codicon and meaning of each flag (Projects view, hub, dashboard). */
export const FLAG_INFO: Record<SessionFlagName, { label: string; icon: string; description: string }> = {
  main: { label: 'Main', icon: 'star-full', description: 'The anchor session of its project; pinned first' },
  review: { label: 'Review', icon: 'eye', description: 'Claude is done; check the result' },
  waiting: { label: 'Waiting', icon: 'watch', description: 'Blocked on something outside: a PR, CI, a person' },
  parked: { label: 'Parked', icon: 'debug-pause', description: 'Not now; come back later' },
  trash: { label: 'Trash', icon: 'trash', description: 'To delete' },
};

export function isSessionFlag(v: unknown): v is SessionFlagName {
  return typeof v === 'string' && (SESSION_FLAGS as readonly string[]).includes(v);
}
