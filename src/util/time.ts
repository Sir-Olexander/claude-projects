/** Locale for dates and times (VS Code's display language, so text isn't mixed-language). */
let locale: string | undefined;
export function setTimeLocale(l: string | undefined): void {
  locale = l || undefined;
}

/** Short relative time: "now", "45s", "12m", "3h", "2d", "Oct 12". */
export function shortAgo(epochMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(epochMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Longer relative time for tooltips: "5 minutes ago". */
export function longAgo(epochMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(epochMs).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Countdown: "2h 14m", "45m", "3d 4h". */
export function countdown(targetMs: number, now = Date.now()): string {
  let s = Math.max(0, Math.round((targetMs - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

/** "14:05" or "Fri 14:05" when not today. */
export function clockTime(targetMs: number, now = Date.now()): string {
  const t = new Date(targetMs);
  const n = new Date(now);
  const time = t.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const sameDay = t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth() && t.getDate() === n.getDate();
  if (sameDay) return time;
  const weekday = t.toLocaleDateString(locale, { weekday: 'short' });
  if (targetMs - now < 6 * 86400_000) return `${weekday} ${time}`;
  return `${t.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

/** "12s", "3m 05s", "1h 02m" */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
