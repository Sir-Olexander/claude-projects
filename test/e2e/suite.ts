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
    await waitFor('webview ready (history loaded)', () => (s as unknown as { historyLoaded: boolean }).historyLoaded, 20_000);
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

  await check('stop session ends the process', async () => {
    const s = api.sessions.findBySessionId(existingId)!;
    assert.ok(s.processAlive, 'process running before stop');
    await vscode.commands.executeCommand('claudeProjects.stopSession', { sessionId: existingId, cwd: repo });
    await waitFor('process stopped', () => !s.processAlive, 10_000);
  });

  await check('terminals open from the Files view, named after the project', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, 'backend', 'api'), { recursive: true });
    const before = vscode.window.terminals.length;
    // Right-click a folder → Open in Integrated Terminal (the menu passes the tree node).
    await vscode.commands.executeCommand('claudeProjects.openTerminal', { resourceUri: vscode.Uri.file(join(repo, 'backend', 'api')) });
    // Title bar button → project root.
    api.store.select(project.id);
    await vscode.commands.executeCommand('claudeProjects.files.openRootInTerminal');
    await waitFor('two terminals', () => vscode.window.terminals.length >= before + 2);
    const names = vscode.window.terminals.slice(before).map((t) => t.name);
    log('terminal names:', names.join(' | '));
    assert.deepEqual(names, [`${project.name} · backend/api`, project.name]);
    const cwd = (vscode.window.terminals[before].creationOptions as vscode.TerminalOptions).cwd;
    assert.equal(String(cwd), join(repo, 'backend', 'api'));
    for (const t of vscode.window.terminals.slice(before)) t.dispose();
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
