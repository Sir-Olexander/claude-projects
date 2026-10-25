import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveRegistry } from '../../src/claude/LiveRegistry';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('LiveRegistry', () => {
  it('keeps live entries whose start time matches (UTC, C locale) and drops reused pids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-reg-'));
    dirs.push(dir);
    const pid = process.pid;
    // Claude Code writes procStart with LC_ALL=C TZ=UTC; the test machine may use another locale/zone.
    const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, cwd: '/x', status: 'busy', procStart }));
    const reg = new LiveRegistry(dir);
    await reg.read();
    expect(reg.entries.map((e) => e.pid)).toEqual([pid]);

    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, cwd: '/x', status: 'busy', procStart: 'Mon Jan  1 00:00:00 2001' }));
    const reg2 = new LiveRegistry(dir);
    await reg2.read();
    expect(reg2.entries).toEqual([]);
    reg.dispose();
    reg2.dispose();
  });

  it('ignores dead pids and malformed files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-reg-'));
    dirs.push(dir);
    writeFileSync(join(dir, '999999.json'), JSON.stringify({ pid: 999999, cwd: '/x', status: 'idle' }));
    writeFileSync(join(dir, '1234.json'), '{not json');
    const reg = new LiveRegistry(dir);
    await reg.read();
    expect(reg.entries).toEqual([]);
    reg.dispose();
  });
});
