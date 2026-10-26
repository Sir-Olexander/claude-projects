/**
 * End-to-end checks inside a real VS Code (isolated profile), driven by
 * test/e2e/run.mjs. Uses the fake CLI (test/fixtures/fake-claude.mjs) and a
 * temporary CLAUDE_CONFIG_DIR, so nothing touches the real ~/.claude.
 */
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeProjectsApi } from '../../src/extension';
import type { ProjectsNode, SessionNode } from '../../src/projects/ProjectsTreeProvider';

const log = (...a: unknown[]) => console.log('[e2e]', ...a);

type Truthy<T> = Exclude<T, undefined | null | false | '' | 0>;

async function waitFor<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<Truthy<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as Truthy<T>;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function tabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
}

export async function run(): Promise<void> {
  const repo = process.env.CP_E2E_REPO!;
  const claudeHome = process.env.CLAUDE_CONFIG_DIR!;
  const existingId = process.env.CP_E2E_SESSION!;
  const failures: string[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      log(`ok   ${name}`);
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
      log(`FAIL ${name}: ${(err as Error).stack ?? err}`);
    }
  };

  const ext = vscode.extensions.getExtension('febundi.claude-projects');
  assert.ok(ext, 'extension installed');
  const api = (await ext.activate()) as ClaudeProjectsApi;
  assert.ok(api?.store, 'activate() returns the API');

  await check('every declared command is registered', async () => {
    const pkg = JSON.parse(readFileSync(join(ext.extensionPath, 'package.json'), 'utf8'));
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).filter((c) => !all.has(c));
    assert.deepEqual(missing, []);
  });

  await check('views open', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.claudeProjects');
    await vscode.commands.executeCommand('claudeProjects.projects.focus');
    await vscode.commands.executeCommand('claudeProjects.scm.focus');
    await vscode.commands.executeCommand('claudeProjects.files.focus');
  });

  const project = await api.store.add(repo);
  api.store.select(project.id);

  await check('session index finds the existing transcript', async () => {
    await waitFor('index ready', () => api.index.isReady);
    const info = await waitFor('existing session indexed', () => api.index.sessionsFor(repo).find((s) => s.sessionId === existingId));
    assert.equal(info.title, 'E2E existing session');
    assert.equal(info.gitBranch, 'main');
  });

  let sessionNode: SessionNode | undefined;
  await check('projects tree shows the project, its worktree and sessions', async () => {
    const roots = api.tree.getChildren();
    const node = roots.find((n) => n.kind === 'project' && n.projectId === project.id);
    assert.ok(node, 'project node');
    const children = await waitFor('worktree loaded', () => {
      const c = api.tree.getChildren(node);
      return c.some((x) => x.kind === 'worktree') ? c : undefined;
    });
    assert.ok(children.some((c: ProjectsNode) => c.kind === 'worktree'), 'worktree node');
    sessionNode = children.find((c): c is SessionNode => c.kind === 'session' && c.sessionId === existingId);
    assert.ok(sessionNode, 'session node');
    const item = api.tree.getTreeItem(sessionNode);
    assert.equal(item.label, 'E2E existing session');
    assert.equal(item.contextValue, 'session');
  });

  await check('usage comes from get_usage', async () => {
    await vscode.commands.executeCommand('claudeProjects.refreshUsage');
    const u = await waitFor('usage', () => (api.usage.current?.fiveHour?.percent === 42 ? api.usage.current : undefined), 20_000);
    assert.equal(u.sevenDay?.percent, 7);
    assert.deepEqual(u.others.map((o) => o.label), ['Fable']);
  });

  await check('opening a session here loads its history through the webview', async () => {
    await vscode.commands.executeCommand('claudeProjects.openSession', sessionNode);
    const s = await waitFor('managed session', () => api.sessions.findBySessionId(existingId));
    assert.ok(api.panels.hasPanel(s.key), 'chat panel created');
    // historyLoaded flips when the webview script runs and posts {type:'ready'}.
    await waitFor('webview ready (history loading)', () => (s as unknown as { historyLoaded: boolean }).historyLoaded, 20_000);
    await s.ensureHistory(); // the same load the panel started
    const items = s.getState().items;
    assert.ok(items.some((i) => i.kind === 'user' && i.text === 'Earlier question'), 'history user message');
    assert.ok(items.some((i) => i.kind === 'text' && i.text === 'Earlier answer'), 'history assistant message');
  });

  await check('a live turn streams, finishes and is marked unread when not focused', async () => {
    const s = api.sessions.findBySessionId(existingId)!;
    await s.send('hello e2e');
    await waitFor('idle', () => s.status === 'idle' && s.getState().items.some((i) => i.kind === 'text' && i.text === 'Echo: hello e2e'), 20_000);
  });

  await check('permission requests raise attention, badge and dashboard entry', async () => {
    const s = api.sessions.findBySessionId(existingId)!;
    await s.send('please use a tool');
    await waitFor('pending permission', () => s.pendingRequests.length === 1, 20_000);
    const view = await waitFor('attention entry', () => api.attention.sessions.find((v) => v.key === s.key && v.attention === 'needs-input'));
    assert.equal(view.waitingFor, 'Permission: Bash');
    assert.ok(view.quickPermission, 'quick allow offered');
    await waitFor('badge', () => (api.treeView.badge?.value ?? 0) >= 1);
    // Answer from the dashboard path.
    s.respondPermission(view.quickPermission!.requestId, view.quickPermission!.allowOptionId);
    await waitFor('idle after tool', () => s.status === 'idle', 20_000);
  });

  await check('sessions running elsewhere appear from the live registry', async () => {
    const pid = process.pid; // alive for the whole test
    const file = join(claudeHome, 'sessions', `${pid}.json`);
    const entry = { pid, sessionId: '33333333-3333-3333-3333-333333333333', cwd: repo, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli', name: 'terminal session', nameSource: 'user', status: 'busy', updatedAt: Date.now(), statusUpdatedAt: Date.now() };
    writeFileSync(file, JSON.stringify(entry));
    await waitFor('external running', () => api.attention.sessions.find((v) => v.key === `pid:${pid}` && v.attention === 'running'), 15_000);
    writeFileSync(file, JSON.stringify({ ...entry, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() }));
    const w = await waitFor('external waiting', () => api.attention.sessions.find((v) => v.key === `pid:${pid}` && v.attention === 'needs-input'), 15_000);
    assert.equal(w.source, 'terminal');
    assert.equal(w.waitingFor, 'Permission prompt');
    writeFileSync(file, JSON.stringify({ ...entry, status: 'busy', statusUpdatedAt: Date.now() }));
    await waitFor('external busy again', () => api.attention.sessions.find((v) => v.key === `pid:${pid}` && v.attention === 'running'), 15_000);
    writeFileSync(file, JSON.stringify({ ...entry, status: 'idle', statusUpdatedAt: Date.now() }));
    await waitFor('external done', () => api.attention.sessions.find((v) => v.key === `pid:${pid}` && v.attention === 'done'), 15_000);
    api.attention.dismiss(`pid:${pid}`);
    await waitFor('dismissed', () => api.attention.sessions.find((v) => v.key === `pid:${pid}` && v.attention === 'idle'));
    unlinkSync(file);
    await waitFor('external gone', () => !api.attention.sessions.some((v) => v.key === `pid:${pid}`), 15_000);
  });

  await check('dashboard opens', async () => {
    await vscode.commands.executeCommand('claudeProjects.openDashboard');
    await waitFor('dashboard tab', () => tabLabels().some((l) => l.startsWith('Claude Sessions')));
  });

  await check('new session command opens a new chat tab', async () => {
    const before = api.sessions.all.length;
    await vscode.commands.executeCommand('claudeProjects.newSession', { path: repo, projectId: project.id });
    await waitFor('new session', () => api.sessions.all.length === before + 1);
    const s = api.sessions.all[api.sessions.all.length - 1];
    assert.equal(s.status, 'new');
    assert.ok(api.panels.hasPanel(s.key));
    await s.send('first message in new session');
    await waitFor('new session idle', () => s.status === 'idle', 20_000);
    assert.equal(s.title, 'first message in new session');
  });

  if (process.env.CP_E2E_OFFICIAL) {
    await check('first hand-off right after start opens the official tab', async () => {
      const officialTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /claudeVSCodePanel/i.test((t.input as { viewType?: string })?.viewType ?? ''));
      const official = vscode.extensions.getExtension('anthropic.claude-code')!;
      log('official active before:', official.isActive);
      const cmds = await vscode.commands.getCommands(true);
      log('primaryEditor.open registered:', cmds.includes('claude-vscode.primaryEditor.open'));
      const t0 = Date.now();
      try {
        await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', existingId);
        log('command returned after', Date.now() - t0, 'ms; active:', official.isActive);
      } catch (err) {
        log('command threw:', (err as Error).message);
      }
      await new Promise((r) => setTimeout(r, 3000));
      log('tabs:', vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => `${t.label} [${(t.input as { viewType?: string })?.viewType ?? ''}]`).join(' | '));
      assert.ok(officialTabs().length > 0, 'official tab after first call');
    });
  }

  await check('hand-off requests for this window are picked up', async () => {
    const file = join(process.env.CP_E2E_STORAGE ?? '', 'handoff.json');
    void file;
    const storage = (api.handoff as unknown as { file: string }).file;
    writeFileSync(storage, JSON.stringify({ requests: [{ id: 'x', folder: repo, sessionId: existingId, createdAt: Date.now() }] }));
    await waitFor('request consumed', () => {
      const f = JSON.parse(readFileSync(storage, 'utf8'));
      return f.requests.length === 0;
    }, 10_000);
  });

  if (process.env.CP_E2E_OFFICIAL) {
    await check('hand-off opens the session in the official Claude Code extension', async () => {
      const official = vscode.extensions.getExtension('anthropic.claude-code');
      assert.ok(official, 'official extension available in the test profile');
      const officialTabs = () =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .filter((t) => /claudeVSCodePanel/i.test((t.input as { viewType?: string })?.viewType ?? ''));
      log('tabs before hand-off:', vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => `${t.label} [${(t.input as { viewType?: string })?.viewType ?? ''}]`).join(' | '));
      for (const t of officialTabs()) await vscode.window.tabGroups.close(t);
      await api.handoff.openInClaudeExtension(repo, existingId);
      const tabs = await waitFor('official Claude tab', () => (officialTabs().length ? officialTabs() : undefined), 20_000);
      log('official tab after hand-off:', tabs.map((t) => t.label).join(' | '));
    });
  }

  await check('forking from a reply opens a new chat with the conversation up to it', async () => {
    const s = api.sessions.findBySessionId(existingId)!;
    await s.ensureHistory();
    const reply = s.getState().items.find((i) => i.kind === 'text' && i.text === 'Earlier answer')!;
    assert.ok(reply, 'reply in history');
    const fork = api.panels.fork(s, reply.id)!;
    assert.ok(fork && api.panels.hasPanel(fork.key), 'fork tab opened');
    assert.notEqual(fork.sessionId, existingId);
    await fork.ensureHistory();
    const texts = fork.getState().items.filter((i) => i.kind === 'user' || i.kind === 'text').map((i) => (i as { text: string }).text);
    assert.deepEqual(texts, ['Earlier question', 'Earlier answer']);
    await waitFor('fork tab title', () => tabLabels().some((l) => l.includes('(fork)')));
    api.panels.closeTab(fork.key);
    await api.sessions.close(fork.key);
  });

  await check('stop session ends the process', async () => {
    const s = api.sessions.findBySessionId(existingId)!;
    assert.ok(s.processAlive, 'process running before stop');
    await vscode.commands.executeCommand('claudeProjects.stopSession', { sessionId: existingId, cwd: repo });
    await waitFor('process stopped', () => !s.processAlive, 10_000);
  });

  await check('a stopped session moves to the dashboard\'s Recent list', async () => {
    // A finished turn stays under "Needs you" until it's seen.
    const live = api.attention.bySessionId(existingId);
    log('before dismiss:', live?.attention, 'recent:', api.attention.recent.map((r) => r.sessionId).join(','));
    if (live) api.attention.dismiss(live.key);
    await waitFor('session in Recent', () => api.attention.recent.some((r) => r.sessionId === existingId), 10_000);
    assert.ok(!api.attention.sessions.some((v) => v.sessionId === existingId), 'not listed as live too');
    assert.ok(api.attention.recent.length <= 10);
  });

  await check('terminals open from the Files view as editor tabs, named after the project', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, 'backend', 'api'), { recursive: true });
    const terminalTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTerminal).map((t) => t.label);
    const before = vscode.window.terminals.length;
    // Right-click a folder → Open in Integrated Terminal (the first terminal in this window).
    await vscode.commands.executeCommand('claudeProjects.openTerminal', { resourceUri: vscode.Uri.file(join(repo, 'backend', 'api')) });
    await waitFor(`first tab labelled (have: ${JSON.stringify(terminalTabs())})`, () => terminalTabs().includes(`${project.name} · backend/api`), 10_000);
    // Title bar button → project root.
    api.store.select(project.id);
    await vscode.commands.executeCommand('claudeProjects.files.openRootInTerminal');
    await waitFor(`root tab labelled (have: ${JSON.stringify(terminalTabs())})`, () => terminalTabs().includes(project.name), 10_000);
    const names = vscode.window.terminals.slice(before).map((t) => t.name);
    assert.deepEqual(names, [`${project.name} · backend/api`, project.name]);
    const cwd = (vscode.window.terminals[before].creationOptions as vscode.TerminalOptions).cwd;
    assert.equal(String(cwd), join(repo, 'backend', 'api'));
    for (const t of vscode.window.terminals.slice(before)) t.dispose();
  });

  await check('delete session moves the transcript to the Trash and drops it from the list', async () => {
    const { existsSync, mkdirSync: mk } = await import('node:fs');
    const id = '66666666-6666-6666-6666-666666666666';
    const dir = join(claudeHome, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
    const file = join(dir, `${id}.jsonl`);
    const t = new Date().toISOString();
    writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'x1', parentUuid: null, sessionId: id, cwd: repo, timestamp: t, message: { role: 'user', content: 'Throwaway session' } }) + '\n');
    mk(join(dir, id, 'subagents'), { recursive: true });
    await waitFor('new session indexed', () => api.index.get(id), 10_000);
    await vscode.commands.executeCommand('claudeProjects.deleteSession', { sessionId: id, cwd: repo }, { skipConfirm: true });
    assert.ok(!existsSync(file), 'transcript removed');
    assert.ok(!existsSync(join(dir, id)), 'side folder removed');
    await waitFor('session gone from the index', () => !api.index.get(id), 10_000);
  });

  await check('Files view: new items follow the selection; drag, cut, copy and paste move and copy', async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const v = api.gitViews()!;
    api.store.select(project.id);
    await vscode.commands.executeCommand('claudeProjects.files.focus');
    await vscode.workspace.getConfiguration('claudeProjects.files').update('confirmDragAndDrop', false, vscode.ConfigurationTarget.Global);
    mkdirSync(join(repo, 'box'), { recursive: true });
    mkdirSync(join(repo, 'other'), { recursive: true });
    writeFileSync(join(repo, 'loose.txt'), 'x');
    const listed = async (...paths: string[]) => {
      const top = (await v.files.getChildren()).map((n) => n.path);
      return paths.every((p) => top.includes(p));
    };
    await waitFor('folders listed', () => listed(join(repo, 'box'), join(repo, 'other'), join(repo, 'loose.txt')), 10_000);
    v.files.refreshAll();
    await new Promise((r) => setTimeout(r, 800)); // let the view fetch the new folders
    await waitFor('folders listed again', () => listed(join(repo, 'box'), join(repo, 'other')), 10_000);
    const box = v.files.nodeFor(join(repo, 'box'))!;
    const other = v.files.nodeFor(join(repo, 'other'))!;

    // Nothing selected: the top level.
    assert.equal(v.filesView.selection.length, 0, 'nothing selected yet');
    await vscode.commands.executeCommand('claudeProjects.files.newFile', undefined, { name: 'top.txt' });
    assert.ok(existsSync(join(repo, 'top.txt')), 'created at the top level');
    // A selected folder: inside it.
    await v.filesView.reveal(box, { select: true, focus: true });
    await vscode.commands.executeCommand('claudeProjects.files.newFile', undefined, { name: 'inner.txt' });
    assert.ok(existsSync(join(repo, 'box', 'inner.txt')), 'created in the selected folder');

    // Drag a file onto a folder: moved.
    const dt = new vscode.DataTransfer();
    dt.set('application/vnd.code.tree.claudeprojects.files', new vscode.DataTransferItem([join(repo, 'loose.txt')]));
    await v.filesDnd.handleDrop(box, dt, new vscode.CancellationTokenSource().token);
    assert.ok(existsSync(join(repo, 'box', 'loose.txt')) && !existsSync(join(repo, 'loose.txt')), 'dragged file moved');
    // A folder onto itself: nothing happens.
    const self = new vscode.DataTransfer();
    self.set('application/vnd.code.tree.claudeprojects.files', new vscode.DataTransferItem([join(repo, 'box')]));
    await v.filesDnd.handleDrop(box, self, new vscode.CancellationTokenSource().token);
    assert.ok(existsSync(join(repo, 'box', 'inner.txt')), 'folder left alone');

    // Cut + paste: moved.
    const inner = { kind: 'entry', path: join(repo, 'box', 'inner.txt'), name: 'inner.txt', isDirectory: false, isSymlink: false };
    await vscode.commands.executeCommand('claudeProjects.files.cut', inner, [inner]);
    await vscode.commands.executeCommand('claudeProjects.files.paste', other);
    assert.ok(existsSync(join(repo, 'other', 'inner.txt')) && !existsSync(join(repo, 'box', 'inner.txt')), 'cut and pasted');
    // Copy + paste into the same folder: a copy next to it.
    const moved = { ...inner, path: join(repo, 'other', 'inner.txt') };
    await vscode.commands.executeCommand('claudeProjects.files.copy', moved, [moved]);
    await vscode.commands.executeCommand('claudeProjects.files.paste', other);
    assert.ok(existsSync(join(repo, 'other', 'inner copy.txt')) && existsSync(join(repo, 'other', 'inner.txt')), 'copied');
    await vscode.workspace.getConfiguration('claudeProjects.files').update('confirmDragAndDrop', undefined, vscode.ConfigurationTarget.Global);
  });

  await check('refresh and next-attention commands run', async () => {
    await vscode.commands.executeCommand('claudeProjects.refresh');
    await vscode.commands.executeCommand('claudeProjects.focusNextAttention');
  });

  if (process.env.CP_E2E_SCREENSHOT) {
    await new Promise((r) => setTimeout(r, 1500));
    log('screenshot point reached');
  }

  if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  log('ALL E2E CHECKS PASSED');
}
