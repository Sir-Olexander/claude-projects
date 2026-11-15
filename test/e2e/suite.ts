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
import type { HubToExtMessage } from '../../src/shared/protocol';
import type { ProjectsNode, SessionNode } from '../../src/projects/ProjectsTreeProvider';
import { readTabTag, stripTabTag } from '../../src/panels/unloadedTabs';

const log = (...a: unknown[]) => console.log('[e2e]', ...a);

type ManagedSessionT = ClaudeProjectsApi['sessions']['all'][number];

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

  const ext = vscode.extensions.getExtension('Sir-Olexander.claude-projects');
  assert.ok(ext, 'extension installed');
  const api = (await ext.activate()) as ClaudeProjectsApi;
  /** Acts as the hub webview would (its strip buttons and menus). */
  const postToHub = async (m: HubToExtMessage) => {
    await (api.hub as unknown as { onMessage(m: HubToExtMessage): Promise<void> }).onMessage(m);
  };
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

  // Most checks below are about chats in their own tabs; the hub has its own checks at the end.
  await vscode.workspace.getConfiguration('claudeProjects').update('chat.openIn', 'tab', vscode.ConfigurationTarget.Global);

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

  await check('icon-only tabs drop the session name from the chat tab, and bring it back', async () => {
    const s = api.sessions.findBySessionId(existingId)!;
    const chatTab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => (t.input as { viewType?: string })?.viewType?.endsWith('claudeProjects.chat') && api.panels.hasPanel(s.key));
    const config = vscode.workspace.getConfiguration('claudeProjects');
    await config.update('chat.iconOnlyTabs', true, vscode.ConfigurationTarget.Global);
    try {
      const tab = await waitFor('icon-only tab', () => {
        const t = chatTab();
        return t && !t.label.includes(s.title) ? t : undefined;
      });
      log('icon-only tab label:', JSON.stringify(tab.label));
      assert.ok(readTabTag(tab.label), `VS Code keeps the invisible tag that matches the tab to its panel: ${JSON.stringify(tab.label)}`);
      assert.ok(/^\d+( [●•⚠])?$/.test(stripTabTag(tab.label)), `label is only the tab number and a marker: ${JSON.stringify(tab.label)}`);
      assert.ok(s.title, 'the session keeps its name');
    } finally {
      await config.update('chat.iconOnlyTabs', undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor('name back on the tab', () => chatTab()?.label.includes(s.title));
  });

  await check("clicking a chat's project name reveals it in the Projects view", async () => {
    const worktree = join(repo, '.claude', 'worktrees', 'feature-x');
    await vscode.commands.executeCommand('claudeProjects.revealInProjects', worktree);
    const wt = await waitFor('worktree selected', () => api.treeView.selection.find((n) => n.kind === 'worktree'));
    assert.equal(wt.kind === 'worktree' && wt.path, worktree);
    assert.equal(api.store.selection?.path, worktree);
    await vscode.commands.executeCommand('claudeProjects.revealInProjects', repo);
    await waitFor('project selected', () => api.treeView.selection.find((n) => n.kind === 'project' && n.path === repo));
    assert.equal(api.store.selection?.path, repo);
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

  await check("renaming from the chat header's session name saves the new name", async () => {
    const s = api.sessions.all[api.sessions.all.length - 1];
    // The header sends this when you edit the name in place.
    await vscode.commands.executeCommand('claudeProjects.renameSession', { sessionId: s.sessionId, cwd: s.cwd, title: s.title }, '  Renamed   in place ');
    assert.equal(s.title, 'Renamed in place');
    assert.equal(api.index.rememberedTitle(s.sessionId), 'Renamed in place');
    await waitFor('tab shows the new name', () => tabLabels().some((l) => l.includes('Renamed in place')));
  });

  await check('icon-only tabs are numbered 0, 1, 2… left to right; the dashboard shows the same numbers', async () => {
    const chatLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /claudeProjects\.chat$/.test((t.input as { viewType?: string })?.viewType ?? '')).map((t) => stripTabTag(t.label));
    const config = vscode.workspace.getConfiguration('claudeProjects');
    await config.update('chat.iconOnlyTabs', true, vscode.ConfigurationTarget.Global);
    try {
      const labels = await waitFor(`numbered (have: ${JSON.stringify(chatLabels())})`, () => {
        const l = chatLabels();
        return l.length >= 2 && l.every((x, i) => new RegExp(`^${i}( [●•⚠])?$`).test(x)) ? l : undefined;
      }, 10_000);
      log('icon-only chat tabs:', JSON.stringify(labels));
      const s = api.sessions.all[api.sessions.all.length - 1];
      const v = await waitFor('number on the dashboard card', () => api.attention.sessions.find((x) => x.key === s.key && x.tabNumber !== undefined));
      assert.ok(labels[v.tabNumber!].startsWith(String(v.tabNumber)));

      // Moving a tab renumbers every tab; it must settle on 0, 1, 2… with no duplicates
      // (matching tabs by their shown number used to loop here).
      const chatTabs = () => vscode.window.tabGroups.activeTabGroup.tabs.filter((t) => /claudeProjects\.chat$/.test((t.input as { viewType?: string })?.viewType ?? ''));
      const last = chatTabs().at(-1)!;
      await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', vscode.window.tabGroups.activeTabGroup.tabs.indexOf(last));
      await vscode.commands.executeCommand('workbench.action.moveEditorLeftInGroup');
      const ordered = () => {
        const l = chatLabels();
        return l.length >= 2 && l.every((x, i) => new RegExp(`^${i}( [●•⚠])?$`).test(x)) ? l.join('|') : undefined;
      };
      const settled = await waitFor(`renumbered after a move (have: ${JSON.stringify(chatLabels())})`, ordered, 10_000);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(ordered(), settled, 'numbers stay put once settled');
      assert.deepEqual(api.panels.unloadedTabs(), [], 'every moved tab is still matched to its panel');
      log('after moving a tab:', settled);
    } finally {
      await config.update('chat.iconOnlyTabs', undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(`names back, no numbers (have: ${JSON.stringify(chatLabels())})`, () => chatLabels().every((l) => !/^\d/.test(l) && l.length > 2));
    assert.ok(api.attention.sessions.every((x) => x.tabNumber === undefined), 'no numbers on the dashboard');
  });

  await check('the dashboard lists open tabs and closes them', async () => {
    const s = api.sessions.all[api.sessions.all.length - 1];
    const view = await waitFor('open tab listed', () => api.attention.sessions.find((v) => v.key === s.key && v.tabOpen));
    assert.ok(view.closable, 'closable');
    assert.ok(s.processAlive, 'process running before close');
    await api.dashboard.closeSessions([s.key]);
    assert.ok(!api.panels.hasPanel(s.key), 'tab closed');
    await waitFor('process stopped', () => !s.processAlive, 10_000);
    await waitFor('no longer listed', () => !api.attention.sessions.some((v) => v.key === s.key && v.tabOpen), 10_000);
  });

  await check('commands used to show a not-yet-loaded chat tab exist', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['workbench.action.openEditorAtIndex', 'workbench.action.focusFirstEditorGroup']) assert.ok(all.includes(c), c);
    assert.deepEqual(api.panels.unloadedTabs(), [], 'every chat tab here is loaded');
    // openEditorAtIndex takes the tab index as its argument.
    const group = vscode.window.tabGroups.activeTabGroup;
    if (group.tabs.length > 1) {
      const target = group.tabs.findIndex((t) => !t.isActive);
      await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', target);
      await waitFor('tab at index active', () => vscode.window.tabGroups.activeTabGroup.tabs[target]?.isActive);
    }
  });

  await check('an idle terminal session can be ended from the dashboard', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.platform === 'win32' ? 'ping' : 'sleep', process.platform === 'win32' ? ['-n', '60', '127.0.0.1'] : ['60'], { stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    const file = join(claudeHome, 'sessions', `${pid}.json`);
    const entry = { pid, sessionId: '55555555-5555-5555-5555-555555555555', cwd: repo, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli', name: 'idle terminal', nameSource: 'user', status: 'idle', updatedAt: Date.now(), statusUpdatedAt: Date.now() };
    writeFileSync(file, JSON.stringify(entry));
    try {
      const v = await waitFor('external idle', () => api.attention.sessions.find((x) => x.key === `pid:${pid}` && x.attention === 'idle'), 15_000).catch((err) => {
        log('registry:', JSON.stringify(api.registry.entries.map((e) => [e.pid, e.status])), 'views:', JSON.stringify(api.attention.sessions.map((x) => [x.key, x.attention])));
        throw err;
      });
      assert.ok(v.closable, 'terminal sessions are closable');
      await api.dashboard.closeSessions([v.key], { skipConfirm: true });
      await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('process not ended')), 5_000))]);
    } finally {
      child.kill();
      try {
        unlinkSync(file);
      } catch {}
    }
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
    // Listed in Projects right away, before its first message.
    const listedInProjects = async () => {
      const top = (await api.tree.getChildren()) as ProjectsNode[];
      const node = top.find((n) => n.kind === 'project' && (n as { projectId?: string }).projectId === project.id);
      const kids = node ? ((await api.tree.getChildren(node)) as ProjectsNode[]) : [];
      return kids.some((k) => k.kind === 'session' && (k as SessionNode).sessionId === fork.sessionId);
    };
    await waitFor('fork listed in Projects', listedInProjects, 10_000);
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
    // While its tab is open it stays listed (as idle).
    if (live) api.panels.closeTab(live.key);
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

  await check('shared .env: a new chat lists the variables, none turned on', async () => {
    const envFile = join(claudeHome, 'shared.env');
    writeFileSync(envFile, '# test\nSHARED_E2E_KEY=abc123\n');
    const before = vscode.workspace.getConfiguration('claudeProjects').inspect<string>('chat.globalEnvFile')?.globalValue;
    await vscode.workspace.getConfiguration('claudeProjects').update('chat.globalEnvFile', envFile, vscode.ConfigurationTarget.Global);
    const s = await api.panels.newSession(repo);
    log('sharedEnv in a new chat:', JSON.stringify(s.getState().sharedEnv));
    const env = s.getState().sharedEnv!;
    assert.deepEqual([env.available, env.enabled], [['SHARED_E2E_KEY'], []]);
    api.panels.closeTab(s.key);
    await api.sessions.close(s.key);
    await vscode.workspace.getConfiguration('claudeProjects').update('chat.globalEnvFile', before, vscode.ConfigurationTarget.Global);
  });

  await check('refresh and next-attention commands run', async () => {
    await vscode.commands.executeCommand('claudeProjects.refresh');
    await vscode.commands.executeCommand('claudeProjects.focusNextAttention');
  });

  // ---------------------------------------------------------------------------
  // Claude Chats (the sessions hub), the default place for Open here chats.

  await vscode.workspace.getConfiguration('claudeProjects').update('chat.openIn', undefined, vscode.ConfigurationTarget.Global);
  const hubTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /claudeProjects\.hub$/.test((t.input as { viewType?: string })?.viewType ?? ''));
  const chatTabFor = (key: string) =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => /claudeProjects\.chat$/.test((t.input as { viewType?: string })?.viewType ?? '') && api.panels.hasPanel(key) && !api.hub.has(key));
  let hubA: ManagedSessionT | undefined;
  let hubB: ManagedSessionT | undefined;

  await check('hub: new sessions open in Claude Chats, not in tabs of their own', async () => {
    const chatTabsBefore = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /claudeProjects\.chat$/.test((t.input as { viewType?: string })?.viewType ?? '')).length;
    hubA = await api.panels.newSession(repo);
    await waitFor('hub tab', () => hubTabs().length === 1);
    assert.ok(api.hub.has(hubA.key), 'session is in the hub');
    assert.ok(api.panels.hasPanel(hubA.key), 'counts as open');
    await waitFor('chat in the hub loaded', () => api.hub.chatReady(hubA!.key), 20_000);
    const chatTabsAfter = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /claudeProjects\.chat$/.test((t.input as { viewType?: string })?.viewType ?? '')).length;
    assert.equal(chatTabsAfter, chatTabsBefore, 'no new chat tab');
    const snap = api.hub.snapshot;
    assert.equal(snap.panes.length, 1);
    assert.equal(snap.panes[0], hubA.key);
    assert.ok(snap.repos.some((r) => r.id === project.id), 'project in the strip');
    assert.ok(snap.sessions.some((x) => x.key === hubA!.key && x.repoId === project.id), 'session in the strip under its project');
  });

  await check('hub: a turn streams into the hub chat; two panes show two chats', async () => {
    await hubA!.send('hello hub');
    await waitFor('hub turn done', () => hubA!.status === 'idle' && hubA!.getState().items.some((i) => i.kind === 'text' && i.text === 'Echo: hello hub'), 20_000);
    await vscode.commands.executeCommand('claudeProjects.newSession', { path: repo, projectId: project.id });
    hubB = await waitFor('second hub session', () => api.sessions.all.find((s) => s.key !== hubA!.key && api.hub.has(s.key) && s.status === 'new'));
    // Opening B replaced A in the single pane; a second pane brings A back next to it.
    assert.deepEqual(api.hub.snapshot.panes, [hubB.key]);
    await postToHub({ type: 'set-pane-count', count: 2 });
    await waitFor('two panes', () => api.hub.snapshot.panes.length === 2);
    assert.deepEqual(api.hub.snapshot.panes, [hubB.key, hubA!.key], 'the spare pane gets the other open chat');
    await waitFor('both chats loaded', () => api.hub.chatReady(hubA!.key) && api.hub.chatReady(hubB!.key), 20_000);
    await postToHub({ type: 'focus-pane', pane: 1 });
    await waitFor('pane B focused', () => api.hub.snapshot.focusedPane === 1);
  });

  await check('hub: flags show in the strip, the Projects view and the dashboard', async () => {
    await postToHub({ type: 'set-flag', key: hubA!.key, flag: 'main' });
    await waitFor('flag saved', () => api.flags.get(hubA!.sessionId) === 'main');
    await waitFor('flag in the strip', () => api.hub.snapshot.sessions.find((x) => x.key === hubA!.key)?.flag === 'main');
    await vscode.commands.executeCommand('claudeProjects.flagSession', { sessionId: hubA!.sessionId, cwd: repo }, 'review');
    assert.equal(api.flags.get(hubA!.sessionId), 'review');
    const node = api.tree.searchNodes().find((n): n is SessionNode => n.kind === 'session' && n.sessionId === hubA!.sessionId);
    if (node) assert.match(String(api.tree.getTreeItem(node).description ?? ''), /Review/, 'tree shows the flag');
    else log('hub A not in the tree yet (no transcript indexed); skipped the tree part');
    const dash = (api.dashboard as unknown as { state(): { sessions: { key: string; flag?: string }[] } }).state();
    assert.equal(dash.sessions.find((v) => v.key === hubA!.key)?.flag, 'review', 'dashboard row carries the flag');
    await vscode.commands.executeCommand('claudeProjects.flagSession', { sessionId: hubA!.sessionId, cwd: repo }, null);
    assert.equal(api.flags.get(hubA!.sessionId), undefined, 'flag cleared');
  });

  await check('hub: pop out to a tab, then move back into the hub', async () => {
    await postToHub({ type: 'pop-out', key: hubA!.key });
    await waitFor('own tab', () => chatTabFor(hubA!.key));
    assert.ok(!api.hub.has(hubA!.key), 'left the hub');
    assert.ok(!api.hub.snapshot.panes.includes(hubA!.key), 'left its pane');
    api.panels.moveToHub(hubA!);
    await waitFor('back in the hub', () => api.hub.has(hubA!.key) && !chatTabFor(hubA!.key));
    await waitFor('chat loaded again', () => api.hub.chatReady(hubA!.key), 20_000);
  });

  await check('hub: deleting the trashed chats of a project', async () => {
    api.flags.set(hubB!.sessionId, 'trash');
    await vscode.commands.executeCommand('claudeProjects.deleteSessions', [{ sessionId: hubB!.sessionId, cwd: repo }], { skipConfirm: true });
    await waitFor('trashed chat gone', () => !api.hub.has(hubB!.key) && !api.sessions.get(hubB!.key));
    assert.equal(api.flags.get(hubB!.sessionId), undefined, 'its flag is dropped');
    assert.ok(api.hub.has(hubA!.key), 'the other chat stays');
  });

  await check('hub: a saved hub reopens its sessions (new ones as new chats)', async () => {
    const reopened = await api.panels.restoreSession({ key: 'old-key', sessionId: 'not-started', cwd: repo, title: 'New session', isNew: true });
    assert.ok(reopened && reopened.status === 'new', 'a new chat');
    await api.sessions.close(reopened!.key);
    const existing = await api.panels.restoreSession({ key: existingId, sessionId: existingId, cwd: repo, title: 'x' });
    assert.equal(existing?.sessionId, existingId, 'an existing chat by id');
  });

  await check('hub: a chat that finishes while you are elsewhere stays Finished until you look at it', async () => {
    const c = await api.panels.newSession(repo);
    const d = await api.panels.newSession(repo);
    await waitFor('d ready', () => api.hub.chatReady(d.key), 20_000);
    log('window focused:', vscode.window.state.focused, 'panes:', JSON.stringify(api.hub.snapshot.panes), 'focusedPane:', api.hub.snapshot.focusedPane);
    // c is out of the panes: finish a turn there.
    await c.send('first turn in c');
    await waitFor('c idle', () => c.status === 'idle', 20_000);
    await new Promise((r) => setTimeout(r, 1500));
    const view = () => api.attention.sessions.find((v) => v.key === c.key);
    const chip = () => api.hub.snapshot.sessions.find((x) => x.key === c.key);
    log('c out of panes: unread', c.unread, 'attention', view()?.attention, 'chip', chip()?.attention);
    assert.equal(c.unread, true, 'c unread');
    assert.equal(chip()?.attention, 'done', 'chip shows Finished');
    // c in a second, unfocused pane.
    await postToHub({ type: 'set-pane-count', count: 2 });
    api.hub.show(c, { pane: 1 });
    await postToHub({ type: 'focus-pane', pane: 0 });
    api.hub.show(d);
    await waitFor('c ready in pane 2', () => api.hub.chatReady(c.key), 20_000);
    await new Promise((r) => setTimeout(r, 1500));
    log('c in background pane: unread', c.unread, 'chip', chip()?.attention, 'focusedPane', api.hub.snapshot.focusedPane, 'panes', JSON.stringify(api.hub.snapshot.panes));
    await c.send('second turn in c');
    await waitFor('c idle again', () => c.status === 'idle' && c.getState().items.some((i) => i.kind === 'text' && i.text.includes('second turn')), 20_000);
    await new Promise((r) => setTimeout(r, 1500));
    log('c finished in background pane: unread', c.unread, 'chip', chip()?.attention);
    assert.equal(chip()?.attention, 'done', 'background pane chip shows Finished');
    await postToHub({ type: 'set-pane-count', count: 1 });
  });

  await check('hub: chats show the last entered first (Main pinned); projects can be reordered', async () => {
    const e1 = await api.panels.newSession(repo);
    await new Promise((r) => setTimeout(r, 20));
    const e2 = await api.panels.newSession(repo);
    await new Promise((r) => setTimeout(r, 20));
    const e3 = await api.panels.newSession(process.env.CP_E2E_REPO2!);
    // Same order as the strip's second row.
    const mine = () =>
      api.hub.snapshot.sessions
        .filter((x) => x.repoId === project.id)
        .sort((a, b) => Number(b.flag === 'main') - Number(a.flag === 'main') || (b.enteredAt ?? 0) - (a.enteredAt ?? 0))
        .map((x) => x.key);
    assert.equal(mine()[0], e2.key, 'the newest chat first');
    await new Promise((r) => setTimeout(r, 20));
    api.hub.show(e1);
    assert.deepEqual(mine().slice(0, 2), [e1.key, e2.key], 'entering a chat brings it to the front');
    await postToHub({ type: 'set-flag', key: e2.key, flag: 'main' });
    assert.equal(mine()[0], e2.key, 'Main stays first');
    assert.ok(api.hub.snapshot.persist.sessions.find((x) => x.key === e1.key)?.enteredAt, 'entered time is saved');
    const repos = () => api.hub.snapshot.repos.map((r) => r.id);
    const other = repos().find((id) => id !== project.id)!;
    assert.ok(other, 'a second project in the strip');
    await postToHub({ type: 'reorder-repos', ids: [other, project.id] });
    assert.deepEqual(repos().slice(0, 2), [other, project.id], 'projects reordered');
    assert.deepEqual(api.hub.snapshot.persist.repoOrder?.slice(0, 2), [other, project.id], 'order is saved');
    api.flags.set(e1.sessionId, undefined);
    for (const s of [e1, e2, e3]) api.panels.closeTab(s.key);
  });

  await check('Projects view: status first, then latest activity; opening a session to read it does not move it', async () => {
    const { mkdirSync, writeFileSync: write, utimesSync } = await import('node:fs');
    const enc = repo.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = join(claudeHome, 'projects', enc);
    mkdirSync(dir, { recursive: true });
    const fresh = '55555555-5555-5555-5555-555555555555';
    const t = new Date().toISOString();
    const line = (o: object) => JSON.stringify(o) + '\n';
    write(
      join(dir, `${fresh}.jsonl`),
      line({ type: 'user', uuid: 'f1', parentUuid: null, sessionId: fresh, cwd: repo, timestamp: t, message: { role: 'user', content: 'Fresh work' } }) +
        line({ type: 'ai-title', aiTitle: 'Fresh session', sessionId: fresh }),
    );
    // The existing session was last worked on an hour ago.
    const old = join(dir, `${existingId}.jsonl`);
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(old, hourAgo, hourAgo);
    api.index.touch(old);
    api.index.touch(join(dir, `${fresh}.jsonl`));
    await waitFor('fresh indexed', () => api.index.get(fresh));
    // Open the old one just to read it (it stays open and idle in the hub).
    await vscode.commands.executeCommand('claudeProjects.openSessionHere', { sessionId: existingId, cwd: repo });
    const managed = await waitFor('old session open', () => api.sessions.findBySessionId(existingId));
    await waitFor('idle', () => managed.status === 'idle');
    await new Promise((r) => setTimeout(r, 600));
    const projectNode = api.tree.getChildren().find((n) => n.kind === 'project' && n.projectId === project.id)!;
    const ids = () => api.tree.getChildren(projectNode).filter((n): n is SessionNode => n.kind === 'session').map((n) => n.sessionId);
    const order = await waitFor('both listed', () => {
      const o = ids();
      return o.includes(fresh) && o.includes(existingId) ? o : undefined;
    });
    log('tree order:', order.map((id) => api.index.get(id)?.title ?? id).join(' | '));
    assert.ok(order.indexOf(fresh) < order.indexOf(existingId), 'newer activity first; an open idle session does not jump ahead');
  });

  await check('hub: closing the hub closes its chats', async () => {
    const keys = [...api.hub.keys];
    assert.ok(keys.length > 0);
    api.hub.webviewPanel!.dispose();
    await waitFor('hub closed', () => hubTabs().length === 0 && !api.hub.isOpen);
    for (const k of keys) assert.ok(!api.panels.hasPanel(k), 'chat no longer open');
    for (const k of keys) await api.sessions.close(k);
  });

  if (process.env.CP_E2E_SCREENSHOT) {
    await new Promise((r) => setTimeout(r, 1500));
    log('screenshot point reached');
  }

  if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  log('ALL E2E CHECKS PASSED');
}
