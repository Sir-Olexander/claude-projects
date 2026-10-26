import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { transcriptPathFor } from '../../src/claude/paths';
import { ClaudeProcess } from '../../src/claude/ClaudeProcess';
import { ManagedSession, forkTitle, type SessionServices } from '../../src/sessions/ManagedSession';
import type { ExtToChatMessage, ToolItem, UserItem } from '../../src/shared/protocol';
import { silentLogger } from '../../src/util/log';
import type { StoredBookmark } from '../../src/sessions/bookmarks';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude.mjs');

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const dirs: string[] = [];
const procs: ClaudeProcess[] = [];
const sessions: ManagedSession[] = [];

afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.close(500)));
  await Promise.all(sessions.splice(0).map((s) => s.stopProcess()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cp-test-'));
  dirs.push(d);
  return d;
}

describe('ClaudeProcess', () => {
  it('initializes, answers control requests and streams a turn', async () => {
    const proc = new ClaudeProcess({ cliPath: FAKE, cwd: tempDir() });
    procs.push(proc);
    const messages: string[] = [];
    proc.onMessage((m) => messages.push(`${m.type}${'subtype' in m && m.subtype ? ':' + m.subtype : ''}`));
    proc.start();
    const init = await proc.initialize();
    expect(init.models?.map((m) => m.value)).toEqual(['default', 'opus', 'haiku']);
    const usage = await proc.request<{ rate_limits: { five_hour: { utilization: number } } }>({ subtype: 'get_usage', skip_behaviors: true });
    expect(usage.rate_limits.five_hour.utilization).toBe(42);
    proc.sendUserMessage({ type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, session_id: '' });
    await waitFor(() => messages.includes('result:success'));
    expect(messages).toContain('system:init');
    expect(messages).toContain('stream_event');
    expect(messages).toContain('assistant');
  });

  it('rejects unknown control requests and reports exits', async () => {
    const proc = new ClaudeProcess({ cliPath: FAKE, cwd: tempDir() });
    procs.push(proc);
    proc.start();
    await expect(proc.request({ subtype: 'nope' })).rejects.toThrow(/unknown nope/);
    const exit = proc.waitForExit();
    await proc.close(1000);
    expect((await exit).code).toBe(0);
  });

  it('reports a missing binary as a spawn error', async () => {
    const proc = new ClaudeProcess({ cliPath: '/definitely/not/claude', cwd: tempDir() });
    proc.start();
    const e = await proc.waitForExit();
    expect(e.spawnError).toMatch(/ENOENT/);
    await expect(proc.initialize()).rejects.toThrow();
  });

  it('passes a clean environment', async () => {
    const dir = tempDir();
    const logFile = join(dir, 'log.jsonl');
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const proc = new ClaudeProcess({ cliPath: FAKE, cwd: dir, permissionMode: 'acceptEdits', sessionId: '11111111-1111-1111-1111-111111111111' });
      procs.push(proc);
      proc.start();
      await proc.initialize();
      const logged = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n')[0]);
      expect(logged.env).toMatchObject({ entry: 'sdk-ts', electron: null });
      expect(logged.args).toContain('--session-id');
      expect(logged.args).toContain('acceptEdits');
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });
});

function memoryBookmarks() {
  const m = new Map<string, StoredBookmark[]>();
  return { load: (id: string) => [...(m.get(id) ?? [])], save: (id: string, l: StoredBookmark[]) => void m.set(id, l), map: m };
}

function services(overrides: Partial<SessionServices> = {}): SessionServices {
  return {
    log: silentLogger,
    getCliPath: async () => FAKE,
    getPathEnv: async () => process.env.PATH ?? '',
    settings: () => ({ defaultPermissionMode: 'default', defaultModel: '', allowBypass: false, showThinking: false, defaultEffort: '', promptPresets: [], autoContinue: false }),
    imageSink: (i) => i,
    sharedInit: {},
    onInitialized: () => {},
    onRateLimit: () => {},
    onTranscriptActivity: () => {},
    bookmarks: memoryBookmarks(),
    probeDefaults: async () => undefined,
    ...overrides,
  };
}

function newSession(cwd = tempDir()) {
  const s = new ManagedSession({ cwd, projectName: 'Test' }, services());
  sessions.push(s);
  const ui: ExtToChatMessage[] = [];
  s.onUiMessage((m) => ui.push(m));
  const attention: string[] = [];
  s.onNeedsAttention((a) => attention.push(a.reason));
  return { s, ui, attention };
}

describe('ManagedSession', () => {
  it('runs a plain turn and becomes idle + unread', async () => {
    const { s, attention } = newSession();
    expect(s.status).toBe('new');
    await s.send('hello there');
    await waitFor(() => s.status === 'idle');
    const items = s.getState().items;
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello there' });
    expect(items.some((i) => i.kind === 'text' && i.text === 'Echo: hello there')).toBe(true);
    expect(items.some((i) => i.kind === 'turn-end')).toBe(true);
    expect(s.unread).toBe(true);
    expect(attention).toEqual(['done']);
    expect(s.title).toBe('hello there');
    expect(s.modelLabel).toBe('Sonnet 5.5');
  });

  it('asks for permission, allows always, and reports the tool result', async () => {
    const { s, attention } = newSession();
    await s.send('please use a tool');
    await waitFor(() => s.status === 'waiting');
    const req = s.pendingRequests[0];
    expect(req).toMatchObject({ kind: 'permission', toolName: 'Bash', input: { command: 'echo hi' } });
    if (req.kind !== 'permission') throw new Error('expected permission');
    expect(req.options.map((o) => o.id)).toEqual(['allow', 'allow-always']);
    expect(attention).toContain('permission');
    const tool = () => s.getState().items.find((i): i is ToolItem => i.kind === 'tool');
    expect(tool()?.status).toBe('waiting-permission');
    s.respondPermission(req.requestId, 'allow-always');
    await waitFor(() => s.status === 'idle');
    expect(tool()).toMatchObject({ status: 'done', result: { text: 'hi', isError: false } });
    expect(s.getState().items.some((i) => i.kind === 'text' && i.text === 'The command printed hi.')).toBe(true);
  });

  it('denies with feedback (turn continues) and without (turn stops)', async () => {
    const { s } = newSession();
    await s.send('use tool please');
    await waitFor(() => s.pendingRequests.length === 1);
    s.respondPermission(s.pendingRequests[0].requestId, 'deny', 'use ls instead');
    await waitFor(() => s.status === 'idle');
    expect(s.getState().items.some((i) => i.kind === 'text' && i.text === 'OK, I will not run it.')).toBe(true);

    await s.send('tool again');
    await waitFor(() => s.pendingRequests.length === 1);
    s.respondPermission(s.pendingRequests[0].requestId, 'deny');
    await waitFor(() => s.status === 'idle');
    const items = s.getState().items;
    expect(items.some((i) => i.kind === 'system' && i.tag === 'interrupted')).toBe(true);
    expect(items.filter((i): i is ToolItem => i.kind === 'tool').map((t) => t.status)).toEqual(['denied', 'denied']);
  });

  it('answers AskUserQuestion', async () => {
    const { s } = newSession();
    await s.send('ask me a question');
    await waitFor(() => s.pendingRequests.length === 1);
    const q = s.pendingRequests[0];
    expect(q.kind).toBe('question');
    s.respondQuestion(q.requestId, { 'Which color?': 'Blue' });
    await waitFor(() => s.status === 'idle');
    expect(s.getState().items.some((i) => i.kind === 'text' && i.text === 'You chose Blue.')).toBe(true);
  });

  it('approves a plan and switches the permission mode', async () => {
    const { s } = newSession();
    await s.setMode('plan');
    await s.send('make a plan');
    await waitFor(() => s.pendingRequests.length === 1);
    const p = s.pendingRequests[0];
    expect(p).toMatchObject({ kind: 'plan', plan: '# Plan\n\n1. Do the thing' });
    s.respondPlan(p.requestId, 'accept-auto');
    await waitFor(() => s.status === 'idle');
    expect(s.permissionMode).toBe('acceptEdits');
  });

  it('interrupts a running turn', async () => {
    const { s } = newSession();
    await s.send('slow please');
    await waitFor(() => s.getState().items.some((i) => i.kind === 'text'));
    await s.interrupt();
    await waitFor(() => s.status === 'idle');
    expect(s.getState().items.some((i) => i.kind === 'turn-end')).toBe(true);
  });

  it('queues messages sent while running and moves them into place when consumed', async () => {
    const { s, ui } = newSession();
    await s.send('slow first');
    await waitFor(() => s.status === 'running');
    await s.send('second message');
    const queued = s.getState().items.find((i): i is UserItem => i.kind === 'user' && i.text === 'second message');
    expect(queued?.queued).toBe(true);
    await waitFor(() => s.status === 'idle' && s.getState().items.filter((i) => i.kind === 'turn-end').length === 2, 10000);
    const items = s.getState().items;
    const second = items.find((i): i is UserItem => i.kind === 'user' && i.text === 'second message');
    expect(second?.queued).toBeUndefined();
    expect(ui.some((m) => m.type === 'remove-items')).toBe(true);
  }, 15000);

  it('reports a crash as an error and recovers on restart', async () => {
    const { s, attention } = newSession();
    await s.send('crash now');
    await waitFor(() => s.status === 'error');
    expect(s.error).toMatch(/simulated crash/);
    expect(attention).toContain('error');
    await s.restart();
    expect(s.status).not.toBe('error');
    await s.send('hello again');
    await waitFor(() => s.status === 'idle');
  });

  it('resumes an existing session with --resume and its id', async () => {
    const dir = tempDir();
    const logFile = join(dir, 'log.jsonl');
    process.env.FAKE_CLAUDE_LOG = logFile;
    try {
      const s = new ManagedSession({ cwd: dir, projectName: 'T', sessionId: '22222222-2222-2222-2222-222222222222' }, services());
      sessions.push(s);
      // No transcript on disk → treated as new id (session-id); fake that one exists:
      (s as unknown as { hasTranscript: boolean }).hasTranscript = true;
      await s.send('hi');
      await waitFor(() => s.status === 'idle');
      const logged = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop()!);
      expect(logged.args.join(' ')).toContain('--resume 22222222-2222-2222-2222-222222222222');
      expect(s.sessionId).toBe('22222222-2222-2222-2222-222222222222');
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it('fails clearly when the CLI is missing', async () => {
    const s = new ManagedSession({ cwd: tempDir(), projectName: 'T' }, services({ getCliPath: async () => undefined }));
    sessions.push(s);
    await s.send('hi');
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/not found/);
  });
});

describe('ManagedSession: effort, MCP input and bookmarks', () => {
  it('reads effort after start, changes it live and resets to default', async () => {
    const { s, ui } = newSession();
    await s.send('hello');
    await waitFor(() => s.status === 'idle');
    expect(s.effort).toBe('high');
    expect(s.getState().availableEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(s.getState().modelValue).toBe('default');
    await s.setEffort('low');
    expect(s.effort).toBe('low');
    await s.setEffort('default');
    expect(s.effort).toBe('high');
    // Haiku has no effort control.
    await s.setModel('haiku');
    expect(s.getState().availableEfforts).toEqual([]);
    expect(s.effort).toBeUndefined();
    expect(ui.some((m) => m.type === 'patch' && 'effort' in m.patch && m.patch.effort === null)).toBe(true);
  });

  it('starts with the chosen effort when picked before the first message', async () => {
    const dir = tempDir();
    const logFile = join(dir, 'log.jsonl');
    process.env.FAKE_CLAUDE_LOG = logFile;
    try {
      const { s } = newSession(dir);
      await s.setEffort('xhigh');
      await s.send('hi');
      await waitFor(() => s.status === 'idle');
      const logged = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop()!);
      expect(logged.args.join(' ')).toContain('--effort xhigh');
      expect(s.effort).toBe('xhigh');
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it('answers an MCP form request', async () => {
    const { s, attention } = newSession();
    await s.send('elicit something');
    await waitFor(() => s.pendingRequests.length === 1);
    const req = s.pendingRequests[0];
    if (req.kind !== 'elicitation') throw new Error('expected elicitation');
    expect(req).toMatchObject({ serverName: 'deploy', title: 'Deploy service', mode: 'form' });
    expect(req.fields.map((f) => f.name)).toEqual(['env', 'replicas', 'notify', 'email']);
    expect(attention).toContain('input');
    expect(s.status).toBe('waiting');
    // Invalid answers are refused with a message and the request stays open.
    expect(s.respondElicitation(req.requestId, 'accept', { env: 'staging' })).toMatch(/Replicas: Required/);
    expect(s.pendingRequests).toHaveLength(1);
    expect(s.respondElicitation(req.requestId, 'accept', { env: 'production', replicas: '2' })).toBeUndefined();
    await waitFor(() => s.status === 'idle');
    const text = s.getState().items.filter((i) => i.kind === 'text').pop();
    expect(text && 'text' in text ? text.text : '').toBe('Elicitation result: {"action":"accept","content":{"env":"production","replicas":2,"notify":false}}');
  });

  it('declines an MCP link request', async () => {
    const { s } = newSession();
    await s.send('elicit-url please');
    await waitFor(() => s.pendingRequests.length === 1);
    const req = s.pendingRequests[0];
    expect(req).toMatchObject({ kind: 'elicitation', mode: 'url', url: 'https://github.com/login/device' });
    s.respondElicitation(req.requestId, 'decline');
    await waitFor(() => s.status === 'idle');
    expect(s.getState().items.some((i) => i.kind === 'text' && i.text === 'Elicitation result: {"action":"decline"}')).toBe(true);
  });

  it('toggles and persists bookmarks', async () => {
    const store = memoryBookmarks();
    const cwd = tempDir();
    const s = new ManagedSession({ cwd, projectName: 'T' }, services({ bookmarks: store }));
    sessions.push(s);
    await s.send('remember this one');
    await waitFor(() => s.status === 'idle');
    const user = s.getState().items.find((i) => i.kind === 'user')!;
    s.toggleBookmark(user.id);
    expect(s.getState().bookmarks).toMatchObject([{ itemId: user.id, kind: 'user', label: 'remember this one' }]);
    expect(store.map.get(s.sessionId)).toHaveLength(1);
    // A new session object for the same id sees it.
    const again = new ManagedSession({ cwd, projectName: 'T', sessionId: s.sessionId }, services({ bookmarks: store }));
    expect(again.getState().bookmarks).toHaveLength(1);
    s.toggleBookmark(user.id);
    expect(s.getState().bookmarks).toEqual([]);
    expect(store.map.get(s.sessionId)).toEqual([]);
  });
});

describe('ManagedSession: defaults before the first message', () => {
  it('shows the model and effort Claude Code will use before the process starts', async () => {
    const probe = async () => ({
      model: 'claude-opus-5-5',
      effort: 'high',
      models: [
        { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'high'] },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      ],
    });
    const s = new ManagedSession({ cwd: tempDir(), projectName: 'T' }, services({ probeDefaults: probe }));
    sessions.push(s);
    await s.loadDefaults();
    const st = s.getState();
    expect(st).toMatchObject({ modelLabel: 'Opus 5.5', modelValue: 'opus', effort: 'high' });
    expect(st.availableEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(s.processAlive).toBe(false);
  });

  it('keeps choices from settings or the pickers', async () => {
    const probe = async () => ({ model: 'claude-opus-5-5', effort: 'high', models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' }] });
    const s = new ManagedSession({ cwd: tempDir(), projectName: 'T', model: 'haiku' }, services({ probeDefaults: probe }));
    sessions.push(s);
    await s.setEffort('low');
    await s.loadDefaults();
    expect(s.getState()).toMatchObject({ modelValue: 'haiku', modelLabel: 'Haiku 5.5', effort: 'low' });
  });
});

describe('ManagedSession: full model ids in settings', () => {
  it('treats "claude-opus-5-5" like the opus alias (label, picker tick, effort levels)', async () => {
    const probe = async () => ({
      model: 'claude-opus-5-5',
      effort: 'high',
      models: [
        { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'high'] },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      ],
    });
    const s = new ManagedSession({ cwd: tempDir(), projectName: 'T', model: 'claude-opus-5-5' }, services({ probeDefaults: probe }));
    sessions.push(s);
    await s.setEffort('high');
    await s.loadDefaults();
    expect(s.getState()).toMatchObject({ modelLabel: 'Opus 5.5', modelValue: 'opus', effort: 'high' });
    expect(s.getState().availableEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('shows a readable name for a model id that is not in the list', async () => {
    const s = new ManagedSession({ cwd: tempDir(), projectName: 'T', model: 'claude-opus-4-8' }, services({ probeDefaults: async () => ({ model: 'claude-opus-4-8', effort: null, models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' }] }) }));
    sessions.push(s);
    await s.loadDefaults();
    expect(s.getState().modelLabel).toBe('Opus 4.8');
  });
});

describe('ManagedSession: a turn cut off by a reload', () => {
  function writeTranscript(): { cwd: string; sessionId: string; restore: () => void } {
    const home = tempDir();
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    const cwd = tempDir();
    const sessionId = '55555555-5555-5555-5555-555555555555';
    const file = transcriptPathFor(cwd, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const t = '2026-10-25T06:24:00.000Z';
    const lines = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd, timestamp: t, message: { role: 'user', content: 'Build it' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd, timestamp: t, message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_cut', name: 'Bash', input: { command: 'npm test' } }] } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return { cwd, sessionId, restore: () => (prev === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = prev)) };
  }

  it('shows the unfinished tool as interrupted, with a note, when nothing is running it', async () => {
    const { cwd, sessionId, restore } = writeTranscript();
    try {
      const s = new ManagedSession({ cwd, projectName: 'T', sessionId }, services());
      sessions.push(s);
      await s.ensureHistory();
      const items = s.getState().items;
      expect(items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'interrupted' });
      expect(items[items.length - 1]).toMatchObject({ kind: 'system', tag: 'interrupted' });
    } finally {
      restore();
    }
  });

  it('leaves it running when the session is live in another app', async () => {
    const { cwd, sessionId, restore } = writeTranscript();
    try {
      const s = new ManagedSession({ cwd, projectName: 'T', sessionId }, services());
      sessions.push(s);
      s.setLiveElsewhere({ source: 'Terminal', pid: 1, status: 'busy' });
      await s.ensureHistory();
      expect(s.getState().items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'pending' });
    } finally {
      restore();
    }
  });
});

describe('ManagedSession: continue automatically after a usage limit', () => {
  const timing = { ...ManagedSession.autoContinueTiming };
  afterEach(() => {
    ManagedSession.autoContinueTiming = { ...timing };
    delete process.env.FAKE_LIMIT_RESET_SECONDS;
  });

  it('shows the limit, and with the toggle on sends "continue" after the reset', async () => {
    ManagedSession.autoContinueTiming = { ...timing, afterResetMs: 0, checkEveryMs: 50 };
    process.env.FAKE_LIMIT_RESET_SECONDS = '1';
    const { s } = newSession();
    await s.send('please hit-limit now');
    await waitFor(() => !!s.limitStop);
    expect(s.getState().limit?.message).toMatch(/hit your session limit/);
    expect(s.limitStop?.resetsAt).toBeGreaterThan(Date.now());
    expect(s.limitStop?.continueAt).toBeUndefined();

    s.setAutoContinue(true);
    expect(s.getState()).toMatchObject({ autoContinue: true, limit: { continueAt: s.limitStop!.resetsAt } });
    await waitFor(() => s.getState().items.some((i) => i.kind === 'text' && i.text === 'Echo: continue'), 5000);
    const items = s.getState().items;
    expect(items.some((i) => i.kind === 'user' && i.text === 'continue')).toBe(true);
    expect(items.some((i) => i.kind === 'system' && i.tag === 'auto-continue')).toBe(true);
    expect(s.getState().limit).toBeUndefined();
  });

  it('does nothing by itself while the toggle is off', async () => {
    ManagedSession.autoContinueTiming = { ...timing, afterResetMs: 0, checkEveryMs: 50 };
    process.env.FAKE_LIMIT_RESET_SECONDS = '1';
    const { s } = newSession();
    await s.send('please hit-limit now');
    await waitFor(() => !!s.limitStop);
    await new Promise((r) => setTimeout(r, 1500));
    expect(s.getState().items.some((i) => i.kind === 'user' && i.text === 'continue')).toBe(false);
    expect(s.getState().limit).toBeDefined();
  });

  it('a message sent by hand clears the limit notice', async () => {
    const { s } = newSession();
    s.setAutoContinue(true);
    await s.send('please hit-limit now');
    await waitFor(() => !!s.limitStop?.continueAt);
    await s.send('hello again');
    expect(s.getState().limit).toBeUndefined();
    await waitFor(() => s.status === 'idle');
  });
});

describe('ManagedSession: forking from a reply', () => {
  it('shows the conversation up to the reply and starts Claude on a cut copy under its own id', async () => {
    const home = tempDir();
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    const log = join(tempDir(), 'args.jsonl');
    process.env.FAKE_CLAUDE_LOG = log;
    try {
      const cwd = tempDir();
      const src = '88888888-8888-8888-8888-888888888888';
      const file = transcriptPathFor(cwd, src);
      mkdirSync(dirname(file), { recursive: true });
      const t = '2026-10-26T10:00:00.000Z';
      const e = (o: object) => ({ sessionId: src, cwd, timestamp: t, ...o });
      writeFileSync(
        file,
        [
          e({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'First question' } }),
          e({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'First answer' }] } }),
          e({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'Second question' } }),
          e({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Second answer' }] } }),
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n',
      );
      const original = new ManagedSession({ cwd, projectName: 'T', sessionId: src, title: 'Original' }, services());
      sessions.push(original);
      await original.ensureHistory();
      const firstAnswer = original.getState().items.find((i) => i.kind === 'text' && i.text === 'First answer')!;
      expect(firstAnswer).toMatchObject({ uuid: 'a1' });
      const from = original.forkPoint(firstAnswer.id)!;
      expect(from).toEqual({ sessionId: src, at: 'a1', title: 'Original' });

      const fork = new ManagedSession({ cwd, projectName: 'T', forkFrom: from }, services());
      sessions.push(fork);
      expect(fork.sessionId).not.toBe(src);
      expect(fork.title).toBe('Original (fork)');
      await fork.ensureHistory();
      const texts = fork.getState().items.filter((i) => i.kind === 'text' || i.kind === 'user').map((i) => (i as { text: string }).text);
      expect(texts).toEqual(['First question', 'First answer']);
      expect(fork.getState().forkFrom).toEqual(from);

      await fork.send('Go on from here');
      await waitFor(() => fork.getState().items.some((i) => i.kind === 'text' && i.text === 'Echo: Go on from here'));
      const args = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args as string[]).pop()!;
      const after = (flag: string) => args[args.indexOf(flag) + 1];
      expect(after('--resume')).toBe(src);
      expect(args).toContain('--fork-session');
      expect(after('--session-id')).toBe(fork.sessionId);
      expect(after('--resume-session-at')).toBe('a1');
      expect(fork.getState().forkFrom).toBeUndefined();

      // Claude copies the original's title into the fork's transcript; the fork keeps its own
      // name and saves it there (as /rename would) once the transcript exists.
      const forkFile = transcriptPathFor(cwd, fork.sessionId);
      writeFileSync(forkFile, JSON.stringify({ type: 'ai-title', aiTitle: 'Original', sessionId: fork.sessionId }) + '\n');
      fork.setTitle('Original', false);
      expect(fork.title).toBe('Original (fork)');
      await fork.send('One more');
      await waitFor(() => readFileSync(forkFile, 'utf8').includes('custom-title'));
      expect(readFileSync(forkFile, 'utf8')).toContain('"customTitle":"Original (fork)"');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });
});

describe('fork names', () => {
  it('adds (fork), then numbers further forks, without stacking suffixes', () => {
    expect(forkTitle('Fix login', [])).toBe('Fix login (fork)');
    expect(forkTitle('Fix login', ['Fix login (fork)'])).toBe('Fix login (fork 2)');
    expect(forkTitle('Fix login (fork)', ['Fix login (fork)', 'Fix login (fork 2)'])).toBe('Fix login (fork 3)');
    expect(forkTitle('Fix login (fork 2)', [])).toBe('Fix login (fork)');
  });
});

describe('ManagedSession: running agents', () => {
  it('counts a background agent until the CLI reports it finished', async () => {
    process.env.FAKE_AGENT_MS = '600';
    try {
      const { s, ui } = newSession();
      await s.send('start a background-agent please');
      await waitFor(() => s.status === 'idle' && s.getState().items.some((i) => i.kind === 'text' && i.text.includes('background')));
      // The turn is over but the agent keeps running.
      expect(s.runningAgents()).toMatchObject([{ type: 'Explore', description: 'Scan the repo', background: true }]);
      expect(s.runningAgents()[0].itemId).toBeTruthy();
      await waitFor(() => s.runningAgents().length === 0, 5000);
      s.flush();
      const patches = ui.filter((m) => m.type === 'patch' && 'agents' in m.patch).map((m) => (m as { patch: { agents: unknown[] | null } }).patch.agents);
      expect(patches.some((a) => Array.isArray(a) && a.length === 1)).toBe(true);
      expect(patches[patches.length - 1]).toEqual([]);
    } finally {
      delete process.env.FAKE_AGENT_MS;
    }
  });
});

describe('ManagedSession: shared .env', () => {
  const lastSpawn = (log: string) => JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!) as { args: string[]; env: { sharedToken: string | null } };
  const env = () => ({ vars: { SHARED_TOKEN: 's3cret-value', OTHER_KEY: 'other' }, skipped: [] });
  const choices = () => {
    const m = new Map<string, string[]>();
    return { load: (id: string) => m.get(id), save: (id: string, n: string[]) => void m.set(id, n), m };
  };

  it('is off by default: Claude gets no shared variables until the chat turns them on', async () => {
    const log = join(tempDir(), 'args.jsonl');
    process.env.FAKE_CLAUDE_LOG = log;
    try {
      const s = new ManagedSession({ cwd: tempDir(), projectName: 'T' }, services({ globalEnv: env, sharedEnvChoice: choices() }));
      sessions.push(s);
      expect(s.getState().sharedEnv).toEqual({ available: ['OTHER_KEY', 'SHARED_TOKEN'], enabled: [] });
      await s.send('hello');
      await waitFor(() => s.status === 'idle');
      const spawn = lastSpawn(log);
      expect(spawn.env.sharedToken).toBeNull();
      expect(spawn.args).not.toContain('--append-system-prompt');
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it('gives Claude only the checked variables, names only in the prompt, and restarts an idle Claude to apply a change', async () => {
    const log = join(tempDir(), 'args.jsonl');
    process.env.FAKE_CLAUDE_LOG = log;
    try {
      const store = choices();
      const s = new ManagedSession({ cwd: tempDir(), projectName: 'T' }, services({ globalEnv: env, sharedEnvChoice: store }));
      sessions.push(s);
      await s.send('hello');
      await waitFor(() => s.status === 'idle');
      expect(s.processAlive).toBe(true);
      // Turn one on while Claude is idle: it restarts, and the next message uses it.
      await s.setSharedEnv(['SHARED_TOKEN']);
      await waitFor(() => !s.processAlive);
      expect(store.m.get(s.sessionId)).toEqual(['SHARED_TOKEN']);
      await s.send('again');
      await waitFor(() => s.status === 'idle' && s.getState().items.some((i) => i.kind === 'text' && i.text === 'Echo: again'));
      const spawn = lastSpawn(log);
      expect(spawn.env.sharedToken).toBe('s3cret-value');
      const prompt = spawn.args[spawn.args.indexOf('--append-system-prompt') + 1];
      expect(prompt).toContain('SHARED_TOKEN');
      expect(prompt).not.toContain('OTHER_KEY');
      expect(spawn.args.join(' ')).not.toContain('s3cret-value');
      expect(spawn.args).toContain('Bash(printenv:*)');
      expect(s.getState().sharedEnv).toMatchObject({ enabled: ['SHARED_TOKEN'], active: ['SHARED_TOKEN'] });
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it('waits for Claude to finish before applying a change', async () => {
    const s = new ManagedSession({ cwd: tempDir(), projectName: 'T' }, services({ globalEnv: env, sharedEnvChoice: choices() }));
    sessions.push(s);
    void s.send('slow answer please');
    await waitFor(() => s.status === 'running');
    await s.setSharedEnv(['OTHER_KEY']);
    expect(s.getState().sharedEnv?.pending).toBe(true);
    expect(s.processAlive).toBe(true); // not cut off mid-answer
    await waitFor(() => s.status === 'idle', 15_000);
    await waitFor(() => !s.processAlive, 5000);
    expect(s.getState().sharedEnv?.pending).toBeUndefined();
  });
});

describe('ManagedSession: Remote Control', () => {
  it('turns on with a link, keeps it while Claude runs, and turns off', async () => {
    const { s } = newSession();
    await s.setRemoteControl(true);
    expect(s.getState().remote).toMatchObject({ state: 'on' });
    expect(s.getState().remote?.url).toMatch(/^https:\/\/claude\.ai\/code\/session_/);
    expect(s.processAlive).toBe(true);
    await s.setRemoteControl(false);
    expect(s.getState().remote).toBeUndefined();
    await s.setRemoteControl(true);
    await s.stopProcess();
    await waitFor(() => !s.processAlive);
    expect(s.getState().remote).toBeUndefined();
    expect(s.getState().items.some((i) => i.kind === 'system' && i.text.startsWith('Remote Control ended'))).toBe(true);
  });

  it('shows why it could not start', async () => {
    process.env.FAKE_REMOTE_FAIL = '1';
    try {
      const { s } = newSession();
      await s.setRemoteControl(true);
      expect(s.getState().remote).toMatchObject({ state: 'error' });
      expect(s.getState().remote?.error).toMatch(/not available/);
    } finally {
      delete process.env.FAKE_REMOTE_FAIL;
    }
  });
});
