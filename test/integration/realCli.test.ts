/**
 * Runs ManagedSession against the real `claude` CLI (uses a few cheap Haiku
 * turns on your account). Opt-in:
 *   CLAUDE_INTEGRATION=1 npx vitest run --config vitest.integration.mts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ManagedSession, type SessionServices } from '../../src/sessions/ManagedSession';
import { transcriptDirFor, transcriptPathFor } from '../../src/claude/paths';
import { ChatBuilder } from '../../src/sessions/chatBuilder';
import { loadTranscriptFile } from '../../src/claude/transcript';
import type { ToolItem } from '../../src/shared/protocol';
import { consoleLogger } from '../../src/util/log';

const CLI = process.env.CLAUDE_CLI ?? join(homedir(), '.local', 'bin', 'claude');
const enabled = process.env.CLAUDE_INTEGRATION === '1' && existsSync(CLI);

function waitFor(cond: () => boolean, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cp-real-')));
const created: string[] = [];

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  // Remove the test transcripts so they don't clutter the user's session list.
  for (const f of created) rmSync(f, { force: true });
  rmSync(transcriptDirFor(dir), { recursive: true, force: true });
});

const services = (): SessionServices => ({
  log: process.env.VERBOSE ? consoleLogger : { ...consoleLogger, info: () => {} },
  getCliPath: async () => CLI,
  getPathEnv: async () => process.env.PATH ?? '',
  settings: () => ({ defaultPermissionMode: 'default', defaultModel: 'haiku', allowBypass: false, showThinking: true, defaultEffort: '' }),
  imageSink: (i) => i,
  sharedInit: {},
  onInitialized: () => {},
  onRateLimit: () => {},
  onTranscriptActivity: () => {},
  bookmarks: { load: () => [], save: () => {} },
});

describe.runIf(enabled)('real Claude CLI', () => {
  let sessionId = '';

  it('runs a turn, asks permission for Bash, and records the transcript', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'notes.txt'), 'hello\n');
    const s = new ManagedSession({ cwd: dir, projectName: 'Integration' }, services());
    sessionId = s.sessionId;
    created.push(transcriptPathFor(dir, sessionId));
    await s.send('Use the Bash tool to run exactly this command: echo integration-ok > out.txt   Then reply with the single word: done');
    // The CLI reports requires_action just before it sends the permission request.
    await waitFor(() => s.pendingRequests.length > 0 || s.status === 'idle' || s.status === 'error');
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('waiting');
    const req = s.pendingRequests[0];
    expect(req.kind).toBe('permission');
    if (req.kind !== 'permission') return;
    expect(req.toolName).toBe('Bash');
    expect(String(req.input.command)).toContain('integration-ok');
    s.respondPermission(req.requestId, 'allow');
    await waitFor(() => s.status === 'idle' || s.status === 'error');
    expect(s.error).toBeUndefined();
    expect(readFileSync(join(dir, 'out.txt'), 'utf8').trim()).toBe('integration-ok');
    const items = s.getState().items;
    const tool = items.find((i): i is ToolItem => i.kind === 'tool' && i.name === 'Bash');
    expect(tool?.status).toBe('done');
    expect(items.some((i) => i.kind === 'turn-end')).toBe(true);
    expect(s.modelLabel).toMatch(/Haiku/i);
    await s.stopProcess();
    expect(existsSync(transcriptPathFor(dir, sessionId))).toBe(true);

    // The transcript replays into the same kind of items.
    const b = new ChatBuilder();
    await loadTranscriptFile(transcriptPathFor(dir, sessionId), b);
    expect(b.items.some((i) => i.kind === 'tool' && i.name === 'Bash' && i.status === 'done')).toBe(true);
  }, 180_000);

  it('resumes the same session in a new process', async () => {
    const s = new ManagedSession({ cwd: dir, projectName: 'Integration', sessionId }, services());
    await s.ensureHistory();
    expect(s.getState().items.length).toBeGreaterThan(2);
    await s.send('What exact text did the command you ran write to out.txt? Reply with just that text.');
    await waitFor(() => s.status === 'idle' || s.status === 'error');
    expect(s.error).toBeUndefined();
    expect(s.sessionId).toBe(sessionId);
    const last = [...s.getState().items].reverse().find((i) => i.kind === 'text');
    expect(last && 'text' in last ? last.text : '').toContain('integration-ok');
    // Effort can be read and changed live.
    expect(s.getState().availableEfforts.length).toBeGreaterThan(0);
    await s.setEffort('low');
    expect(s.effort).toBe('low');
    await s.setEffort('default');
    expect(s.effort).not.toBe('low');
    await s.stopProcess();
  }, 180_000);

  it('runs a subagent and nests its tool calls under the Agent row', async () => {
    const s = new ManagedSession({ cwd: dir, projectName: 'Integration', permissionMode: 'acceptEdits' }, services());
    created.push(transcriptPathFor(dir, s.sessionId));
    await s.send('Use the Agent tool to launch one general-purpose subagent that lists the files in the current directory and reports them. Then reply with one word: done.');
    await waitFor(() => s.status === 'idle' || s.status === 'error' || s.pendingRequests.length > 0);
    // Allow anything the subagent asks for (read-only listing).
    while (s.pendingRequests.length) {
      const p = s.pendingRequests[0];
      if (p.kind === 'permission') s.respondPermission(p.requestId, 'allow');
      await waitFor(() => s.status === 'idle' || s.status === 'error' || s.pendingRequests.length > 0);
    }
    expect(s.error).toBeUndefined();
    const items = s.getState().items;
    const agent = items.find((i): i is ToolItem => i.kind === 'tool' && (i.name === 'Agent' || i.name === 'Task'));
    expect(agent?.status).toBe('done');
    const nested = items.filter((i) => i.kind === 'tool' && i.parentToolUseId === agent!.id);
    expect(nested.length).toBeGreaterThan(0);
    // Only the message we typed appears as a user message.
    expect(items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toHaveLength(1);
    await s.stopProcess();
  }, 180_000);
});
