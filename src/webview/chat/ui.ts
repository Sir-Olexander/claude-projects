import { useCallback, useState } from 'preact/hooks';
import { getPersisted, setPersisted } from '../common/vscodeApi';

/**
 * UI-only state that survives the webview being destroyed and recreated
 * (VS Code drops hidden webviews): message draft, expanded blocks, scroll.
 */
/** Read by the extension's panel serializer to restore the tab after a reload. */
export interface PersistedSession {
  key: string;
  sessionId?: string;
  cwd: string;
  title: string;
  /** A fork that hasn't sent its first message. */
  forkFrom?: { sessionId: string; at: string; title: string };
}

interface PersistedUi {
  v: 1;
  /** Top-level on purpose: the extension's webview serializer reads it. */
  session?: PersistedSession;
  draft?: string;
  expanded?: Record<string, boolean>;
  scrollTop?: number;
  /** Whether the list was scrolled to the bottom. */
  atBottom?: boolean;
}

const loaded = getPersisted<PersistedUi>();
const ui: PersistedUi = loaded && loaded.v === 1 ? { ...loaded, expanded: { ...(loaded.expanded ?? {}) } } : { v: 1, expanded: {} };

let timer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const exp = ui.expanded ?? {};
    const keys = Object.keys(exp);
    if (keys.length > 1500) {
      for (const k of keys.slice(0, keys.length - 1500)) delete exp[k];
    }
    setPersisted(ui);
  }, 250);
}

/** Records which session this panel shows; written right away (not debounced). */
export function saveSession(s: PersistedSession): void {
  const cur = ui.session;
  if (cur && cur.key === s.key && cur.sessionId === s.sessionId && cur.cwd === s.cwd && cur.title === s.title && cur.forkFrom?.at === s.forkFrom?.at) return;
  ui.session = { key: s.key, sessionId: s.sessionId, cwd: s.cwd, title: s.title, forkFrom: s.forkFrom };
  setPersisted(ui);
}

export function getDraft(): string {
  return ui.draft ?? '';
}

export function saveDraft(text: string): void {
  if (ui.draft === text) return;
  ui.draft = text;
  persistSoon();
}

export function getScroll(): { scrollTop?: number; atBottom?: boolean } {
  return { scrollTop: ui.scrollTop, atBottom: ui.atBottom };
}

export function saveScroll(scrollTop: number, atBottom: boolean): void {
  ui.scrollTop = Math.round(scrollTop);
  ui.atBottom = atBottom;
  persistSoon();
}

export function isExpanded(id: string, fallback: boolean): boolean {
  const v = ui.expanded?.[id];
  return v === undefined ? fallback : v;
}

export function setExpanded(id: string, value: boolean): void {
  ui.expanded ??= {};
  ui.expanded[id] = value;
  persistSoon();
}

/** Collapsible state for a block, remembered across webview reloads. */
export function useExpanded(id: string, fallback: boolean): [boolean, (v?: boolean) => void] {
  const [open, setOpen] = useState(() => isExpanded(id, fallback));
  const toggle = useCallback(
    (v?: boolean) => {
      setOpen((cur) => {
        const next = v === undefined ? !cur : v;
        setExpanded(id, next);
        return next;
      });
    },
    [id],
  );
  return [open, toggle];
}
