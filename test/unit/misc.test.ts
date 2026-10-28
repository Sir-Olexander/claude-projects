import { describe, expect, it } from 'vitest';
import { encodeProjectDirName, isUuid } from '../../src/claude/paths';
import { parseLiveEntry } from '../../src/claude/LiveRegistry';
import { permissionOptions } from '../../src/sessions/permissionText';
import { describeToolActivity, prettyModelName } from '../../src/sessions/toolText';
import { toView } from '../../src/usage/usageView';
import { buildArgs, buildChildEnv } from '../../src/claude/ClaudeProcess';
import { scorePath } from '../../src/panels/fileSuggestions';
import { sourceOf } from '../../src/sessions/sources';
import { countdown, shortAgo } from '../../src/util/time';
import { isInHiddenFolder, normalizeDrive, stripTrailingSep } from '../../src/util/paths';

describe('paths', () => {
  it('encodes cwd like Claude Code', () => {
    expect(encodeProjectDirName('/Users/x/Documents/my-project')).toBe('-Users-x-Documents-my-project');
    expect(encodeProjectDirName('/Users/x/FeBundi/.dev-home/repos/landing-page')).toBe('-Users-x-FeBundi--dev-home-repos-landing-page');
    const long = '/very/' + 'deep/'.repeat(60) + 'folder';
    const enc = encodeProjectDirName(long);
    expect(enc.length).toBeLessThan(220);
    expect(enc.startsWith(long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200) + '-')).toBe(true);
  });
  it('encodes Windows cwds like Claude Code', () => {
    expect(encodeProjectDirName('C:\\Users\\x\\my-project')).toBe('C--Users-x-my-project');
  });
  it('spells Windows drive letters one way', () => {
    expect(normalizeDrive('c:\\Users\\x', 'win32')).toBe('C:\\Users\\x');
    expect(normalizeDrive('C:\\Users\\x', 'win32')).toBe('C:\\Users\\x');
    expect(normalizeDrive('c:/x', 'darwin')).toBe('c:/x');
    expect(normalizeDrive('/Users/x', 'win32')).toBe('/Users/x');
  });
  it('keeps filesystem roots', () => {
    expect(stripTrailingSep('/')).toBe('/');
    expect(stripTrailingSep('C:\\')).toBe('C:\\');
    expect(stripTrailingSep('/a/b/')).toBe('/a/b');
  });
  it('spots folders inside hidden folders (app scratch folders, worktrees)', () => {
    expect(isInHiddenFolder('/Users/x/Febundi-Ads-Studio/.data/wp4/users/usr-a/work/dsk-1huk')).toBe(true);
    expect(isInHiddenFolder('/Users/x/app/.claude/worktrees/feature')).toBe(true);
    expect(isInHiddenFolder('C:\\Users\\x\\.data\\work')).toBe(true);
    expect(isInHiddenFolder('/Users/x/Documents/my-project')).toBe(false);
    expect(isInHiddenFolder('/Users/x/Documents/site.com')).toBe(false);
  });
  it('recognizes uuids', () => {
    expect(isUuid('6e2ec9ee-ee1e-4ebf-b68c-edacd2ef5569')).toBe(true);
    expect(isUuid('memory')).toBe(false);
  });
});

describe('live registry entries', () => {
  it('parses the fields we use', () => {
    const e = parseLiveEntry({ pid: 77310, sessionId: 's', cwd: '/c', status: 'waiting', waitingFor: 'permission prompt', entrypoint: 'claude-vscode', kind: 'interactive', statusUpdatedAt: 5, procStart: 'Sat Oct 24 21:23:10 2026' });
    expect(e).toMatchObject({ pid: 77310, status: 'waiting', waitingFor: 'permission prompt', entrypoint: 'claude-vscode' });
    expect(parseLiveEntry({ pid: 'x', cwd: '/c' })).toBeUndefined();
    expect(parseLiveEntry({ pid: 1 })).toBeUndefined();
  });
  it('maps entrypoints to sources', () => {
    expect(sourceOf('cli').source).toBe('terminal');
    expect(sourceOf('claude-vscode').source).toBe('vscode');
    expect(sourceOf('claude-desktop').source).toBe('desktop');
    expect(sourceOf('sdk-ts').source).toBe('sdk');
  });
});

describe('permission options', () => {
  it('words Bash rules like the CLI', () => {
    const opts = permissionOptions([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }], '/Users/me/app', false);
    expect(opts.map((o) => o.label)).toEqual(['Yes', "Yes, and don't ask again for npm test commands in app"]);
  });
  it('offers "allow all edits" for edit prompts', () => {
    const opts = permissionOptions([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], '/a', false);
    expect(opts[1]).toMatchObject({ id: 'allow-always', label: 'Yes, allow all edits during this session' });
  });
  it('respects suppress_always_allow_rule', () => {
    expect(permissionOptions([{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }], '/a', true)).toHaveLength(1);
  });
});

describe('tool text', () => {
  it('describes activity', () => {
    expect(describeToolActivity('Bash', { command: 'npm test' })).toBe('Running npm test');
    expect(describeToolActivity('Edit', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('Editing src/a.ts');
    expect(describeToolActivity('mcp__github__create_issue', {})).toBe('github: create_issue');
  });
  it('prettifies model ids', () => {
    expect(prettyModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)');
    expect(prettyModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettyModelName('gpt-x')).toBe('gpt-x');
  });
});

describe('usage view', () => {
  it('converts get_usage', () => {
    const v = toView({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 23.4, resets_at: '2026-10-25T02:20:00Z' },
        seven_day: { utilization: 3, resets_at: '2026-10-31T19:00:00Z' },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-10-31T19:00:00Z' }],
      },
    });
    expect(v).toEqual({
      fiveHour: { percent: 23, resetsAt: '2026-10-25T02:20:00Z' },
      sevenDay: { percent: 3, resetsAt: '2026-10-31T19:00:00Z' },
      others: [{ label: 'Fable', window: { percent: 0, resetsAt: '2026-10-31T19:00:00Z' } }],
      subscription: 'max',
    });
  });
  it('explains API-key logins', () => {
    expect(toView({ rate_limits_available: false, rate_limits: null, subscription_type: null }).error).toMatch(/subscription/);
  });
});

describe('process args and env', () => {
  it('builds the stream-json command line', () => {
    const args = buildArgs({ cliPath: 'claude', cwd: '/', resume: 'abc', forkSession: true, permissionMode: 'plan', model: 'opus', thinkingDisplay: 'summarized' });
    expect(args.slice(0, 7)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool=stdio']);
    expect(args).toContain('--include-partial-messages');
    expect(args.join(' ')).toContain('--resume abc --fork-session');
    expect(args.join(' ')).toContain('--permission-mode plan');
    expect(args.join(' ')).toContain('--model opus');
    expect(buildArgs({ cliPath: 'c', cwd: '/', sessionId: 'new-id' }).join(' ')).toContain('--session-id new-id');
  });
  it('removes VS Code / Electron variables', () => {
    const env = buildChildEnv({ PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '1', NODE_OPTIONS: '--x', CLAUDECODE: '1', TERM_PROGRAM: 'vscode' }, { pathEnv: '/usr/bin:/bin' });
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/h', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.VSCODE_PID).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.TERM_PROGRAM).toBeUndefined();
  });
});

describe('misc helpers', () => {
  it('scores file paths for @-mentions', () => {
    expect(scorePath('src/app.ts', 'app')).toBeGreaterThan(scorePath('src/application/x.ts', 'app'));
    expect(scorePath('src/app.ts', 'zzz')).toBe(-1);
    expect(scorePath('src/components/Button.tsx', 'scb')).toBeGreaterThan(-1);
  });
  it('formats times', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    expect(shortAgo(now - 5_000, now)).toBe('now');
    expect(shortAgo(now - 3 * 60_000, now)).toBe('3m');
    expect(countdown(now + (2 * 3600 + 14 * 60) * 1000, now)).toBe('2h 14m');
    expect(countdown(now + 3 * 86400_000 + 4 * 3600_000, now)).toBe('3d 4h');
  });
});
