import { describe, expect, it } from 'vitest';
import { isLimitMessage, parseLimitReset } from '../../src/sessions/usageLimit';

const at = (iso: string) => Date.parse(iso);

describe('usage limit messages', () => {
  it('recognises Claude Code limit messages', () => {
    expect(isLimitMessage("You've hit your session limit · resets 7:30am (Europe/Lisbon)")).toBe(true);
    expect(isLimitMessage("You've hit your weekly limit · resets Oct 24 at 8pm (Europe/Lisbon)")).toBe(true);
    expect(isLimitMessage("You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your session limit resets 2:10am (Europe/Zagreb)")).toBe(true);
    expect(isLimitMessage('Echo: hit your limit')).toBe(false);
  });

  it('reads a time of day in the given zone', () => {
    // 25 Oct 2026: Lisbon is back on UTC.
    expect(parseLimitReset("You've hit your session limit · resets 7:30am (Europe/Lisbon)", at('2026-10-25T05:00:00Z'))).toBe(at('2026-10-25T07:30:00Z'));
    expect(parseLimitReset("You've hit your session limit · resets 11am (Europe/Zagreb)", at('2026-07-01T05:00:00Z'))).toBe(at('2026-07-01T09:00:00Z'));
    expect(parseLimitReset("You've hit your session limit · resets 12am (America/New_York)", at('2026-07-01T12:00:00Z'))).toBe(at('2026-07-02T04:00:00Z'));
    expect(parseLimitReset("You've hit your session limit · resets 12:20pm (Europe/Lisbon)", at('2026-07-01T09:00:00Z'))).toBe(at('2026-07-01T11:20:00Z'));
  });

  it('moves a time that has already passed to the next day', () => {
    expect(parseLimitReset("You've hit your session limit · resets 7:30am (Europe/Lisbon)", at('2026-10-25T08:00:00Z'))).toBe(at('2026-10-26T07:30:00Z'));
  });

  it('reads a date, including the year change', () => {
    expect(parseLimitReset("You've hit your weekly limit · resets Oct 24 at 8pm (Europe/Lisbon)", at('2026-10-20T10:00:00Z'))).toBe(at('2026-10-24T19:00:00Z'));
    expect(parseLimitReset("You've hit your weekly limit · resets Jan 2 at 9am (Europe/Lisbon)", at('2026-12-30T10:00:00Z'))).toBe(at('2027-01-02T09:00:00Z'));
  });

  it('reads the session reset inside a spend-limit message', () => {
    expect(parseLimitReset("You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 2:10am (Europe/Zagreb)", at('2026-09-22T22:00:00Z'))).toBe(at('2026-09-23T00:10:00Z'));
  });

  it('gives up without a time', () => {
    expect(parseLimitReset("You've hit your limit", at('2026-10-25T05:00:00Z'))).toBeUndefined();
  });
});
