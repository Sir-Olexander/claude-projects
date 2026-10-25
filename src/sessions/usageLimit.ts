/**
 * Claude's own message when a turn stops at a usage limit, for example
 *   "You've hit your session limit · resets 7:30am (Europe/Lisbon)"
 *   "You've hit your weekly limit · resets Oct 24 at 8pm (Europe/Lisbon)"
 */
const LIMIT_RE = /^You['’]ve hit your [^·]*limit/i;

export function isLimitMessage(text: string): boolean {
  return LIMIT_RE.test(text.trim());
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET_RE = /resets\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Wall-clock parts of an instant in a time zone. */
function zoned(tz: string, at: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(at))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** The instant a wall-clock time in `tz` stands for. */
function fromZoned(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const offsetAt = (t: number) => {
    const z = zoned(tz, t);
    return Date.UTC(z.y, z.mo, z.d, z.h, z.mi, z.s) - Math.floor(t / 1000) * 1000;
  };
  let t = wall - offsetAt(wall);
  const again = wall - offsetAt(t); // across a DST change the first guess can be an hour off
  if (again !== t) t = again;
  return t;
}

/**
 * When the limit in a limit message resets (epoch ms), or undefined when the
 * message has no time. `now` is when the message was written: a time of day
 * that has already passed then means the next day.
 */
export function parseLimitReset(text: string, now = Date.now()): number | undefined {
  const m = RESET_RE.exec(text);
  if (!m) return undefined;
  const [, monthName, dayStr, yearStr, hourStr, minStr, ampm, zone] = m;
  let tz = zone?.trim() || systemZone();
  try {
    zoned(tz, now);
  } catch {
    tz = systemZone();
  }
  let h = Number(hourStr);
  const mi = minStr ? Number(minStr) : 0;
  if (h > 23 || mi > 59) return undefined;
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  const today = zoned(tz, now);
  if (monthName) {
    const mo = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (mo < 0) return undefined;
    const d = Number(dayStr);
    let y = yearStr ? Number(yearStr) : today.y;
    let t = fromZoned(tz, y, mo, d, h, mi);
    // "resets Jan 2" written in late December.
    if (!yearStr && t < now - 2 * 86_400_000) t = fromZoned(tz, ++y, mo, d, h, mi);
    return t;
  }
  let t = fromZoned(tz, today.y, today.mo, today.d, h, mi);
  if (t <= now - 60_000) t = fromZoned(tz, today.y, today.mo, today.d + 1, h, mi);
  return t;
}
