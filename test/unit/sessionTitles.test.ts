import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionIndex, type RememberedTitle } from '../../src/claude/SessionIndex';
import { ManagedSession, type SessionServices } from '../../src/sessions/ManagedSession';
import { transcriptPathFor } from '../../src/claude/paths';
import { silentLogger } from '../../src/util/log';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cp-titles-'));
  dirs.push(d);
  return d;
};

/** A transcript renamed in the middle, with more than 64 KB of messages on both sides (like a long chat). */
function bigRenamedTranscript(cwd: string, id: string): string {
  const pad = 'x'.repeat(2000);
  const lines: object[] = [{ type: 'ai-title', aiTitle: 'Original name', sessionId: id }];
  let parent: string | null = null;
  const msg = (i: number) => {
    const uuid = `u${i}`;
    lines.push({ type: 'user', uuid, parentUuid: parent, sessionId: id, cwd, timestamp: '2026-10-27T10:00:00.000Z', message: { role: 'user', content: `message ${i} ${pad}` } });
    parent = uuid;
  };
  for (let i = 0; i < 60; i++) msg(i);
  lines.push({ type: 'custom-title', customTitle: 'New Idea', sessionId: id });
  for (let i = 60; i < 120; i++) msg(i);
  lines.push({ type: 'ai-title', aiTitle: 'Original name', sessionId: id });
  const file = transcriptPathFor(cwd, id);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('session names given by the user', () => {
  it('the index keeps a rename that scrolled out of the part of the file it reads', async () => {
    const home = temp();
    process.env.CLAUDE_CONFIG_DIR = home;
    const cwd = temp();
    const id = '99999999-9999-9999-9999-999999999999';
    bigRenamedTranscript(cwd, id);
    let saved: Record<string, RememberedTitle> = {};
    const index = new SessionIndex(join(home, 'projects'), silentLogger, { load: () => saved, save: (t) => (saved = t) });
    await index.scanAll();
    expect(index.get(id)?.title).toBe('Original name'); // only head and tail are read
    index.rememberTitle(id, 'New Idea');
    expect(index.get(id)?.title).toBe('New Idea');
    expect(saved[id].title).toBe('New Idea');
    // Remembered across restarts.
    const again = new SessionIndex(join(home, 'projects'), silentLogger, { load: () => saved, save: () => {} });
    await again.scanAll();
    expect(again.get(id)?.title).toBe('New Idea');
  });

  it('opening the chat finds the name in the full history, tells the tab, and remembers it', async () => {
    const home = temp();
    process.env.CLAUDE_CONFIG_DIR = home;
    const cwd = temp();
    const id = '99999999-9999-9999-9999-999999999998';
    bigRenamedTranscript(cwd, id);
    const remembered: [string, string][] = [];
    const services = {
      log: silentLogger,
      getCliPath: async () => join(__dirname, '..', 'fixtures', 'fake-claude.mjs'),
      getPathEnv: async () => process.env.PATH ?? '',
      settings: () => ({ defaultPermissionMode: 'default', defaultModel: '', allowBypass: false, showThinking: false, defaultEffort: '', promptPresets: [], autoContinue: false }),
      imageSink: (i: never) => i,
      sharedInit: {},
      onInitialized: () => {},
      onRateLimit: () => {},
      onTranscriptActivity: () => {},
      bookmarks: { load: () => [], save: () => {} },
      probeDefaults: async () => undefined,
      rememberTitle: (sid: string, t: string) => void remembered.push([sid, t]),
    } as unknown as SessionServices;
    // Reopened with the stale name the session list had.
    const s = new ManagedSession({ cwd, projectName: 'T', sessionId: id, title: 'Original name' }, services);
    let changes = 0;
    s.onDidChange(() => changes++);
    await s.ensureHistory();
    expect(s.title).toBe('New Idea');
    expect(changes).toBeGreaterThan(0); // the tab follows onDidChange
    expect(remembered).toContainEqual([id, 'New Idea']);
    // After a turn the name is written at the end of the transcript again.
    await s.send('hi');
    const file = transcriptPathFor(cwd, id);
    const deadline = Date.now() + 5000;
    while (!readFileSync(file, 'utf8').trimEnd().endsWith('"customTitle":"New Idea","sessionId":"' + id + '"}') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(file, 'utf8').trimEnd().split('\n').pop()).toContain('"customTitle":"New Idea"');
    await s.stopProcess();
  });

  it("a fork keeps its own name over the original's that Claude copied in, until it's renamed elsewhere", async () => {
    const home = temp();
    const cwd = temp();
    const id = '99999999-9999-9999-9999-999999999997';
    const file = transcriptPathFor(cwd, id, { CLAUDE_CONFIG_DIR: home } as NodeJS.ProcessEnv);
    mkdirSync(join(file, '..'), { recursive: true });
    const write = (names: string[]) =>
      writeFileSync(
        file,
        [{ type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd, timestamp: '2026-10-27T10:00:00.000Z', message: { role: 'user', content: 'hi' } }, ...names.map((n) => ({ type: 'custom-title', customTitle: n, sessionId: id }))]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n',
      );
    let saved: Record<string, RememberedTitle> = {};
    const index = new SessionIndex(join(home, 'projects'), silentLogger, { load: () => saved, save: (t) => (saved = t) });
    index.rememberTitle(id, 'Filter Adds'); // named before the fork's first message
    write(['[Main] Sirena macOS voice assistant']); // what Claude copied from the original
    await index.scanAll();
    expect(index.get(id)?.title).toBe('Filter Adds');
    // Claude re-saves it after a turn: still ours.
    write(['[Main] Sirena macOS voice assistant', '[Main] Sirena macOS voice assistant']);
    index.touch(file);
    await new Promise((r) => setTimeout(r, 600));
    expect(index.get(id)?.title).toBe('Filter Adds');
    // Renamed in a terminal (/rename): the file's name changes, and that wins.
    write(['[Main] Sirena macOS voice assistant', 'Ads filter v2']);
    index.touch(file);
    await new Promise((r) => setTimeout(r, 600));
    expect(index.get(id)?.title).toBe('Ads filter v2');
  });

  it('tells a running Claude the name, when it starts and on a rename', async () => {
    const home = temp();
    process.env.CLAUDE_CONFIG_DIR = home;
    const renames = join(temp(), 'renames.jsonl');
    process.env.FAKE_RENAME_LOG = renames;
    try {
      const services = {
        log: silentLogger,
        getCliPath: async () => join(__dirname, '..', 'fixtures', 'fake-claude.mjs'),
        getPathEnv: async () => process.env.PATH ?? '',
        settings: () => ({ defaultPermissionMode: 'default', defaultModel: '', allowBypass: false, showThinking: false, defaultEffort: '', promptPresets: [], autoContinue: false }),
        imageSink: (i: never) => i,
        sharedInit: {},
        onInitialized: () => {},
        onRateLimit: () => {},
        onTranscriptActivity: () => {},
        bookmarks: { load: () => [], save: () => {} },
        probeDefaults: async () => undefined,
      } as unknown as SessionServices;
      const s = new ManagedSession({ cwd: temp(), projectName: 'T', forkFrom: { sessionId: '99999999-9999-9999-9999-999999999990', at: 'a1', title: 'Original' } }, services);
      await s.send('hi'); // the original's transcript doesn't exist here; the fork still starts
      const deadline = Date.now() + 5000;
      const read = () => (existsSync(renames) ? readFileSync(renames, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
      while (!read().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(read()[0]).toEqual({ title: 'Original (fork)', source: 'host', session_id: s.sessionId });
      s.setTitle('Filter Adds', true);
      while (read().length < 2 && Date.now() < deadline + 3000) await new Promise((r) => setTimeout(r, 50));
      expect(read()[1].title).toBe('Filter Adds');
      await s.stopProcess();
    } finally {
      delete process.env.FAKE_RENAME_LOG;
    }
  });
});
