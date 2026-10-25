/**
 * Visual pass: sets up a realistic state and captures screenshots of the real
 * VS Code window through the Chrome DevTools Protocol (VS Code is launched with
 * --remote-debugging-port by run.mjs --visual). Screenshots go to $CP_E2E_SHOTS.
 */
import * as vscode from 'vscode';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeProjectsApi } from '../../src/extension';

const log = (...a: unknown[]) => console.log('[visual]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T, ms = 20_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(100);
  }
}

async function screenshot(name: string): Promise<void> {
  const port = process.env.CP_E2E_CDP_PORT;
  const dir = process.env.CP_E2E_SHOTS;
  if (!port || !dir) return;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (!page) throw new Error('workbench page not found: ' + targets.map((t) => t.url).join(', '));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const data = await new Promise<string>((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) (m.result ? resolve(m.result.data) : reject(new Error(JSON.stringify(m.error))));
    };
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
  ws.close();
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
  log('saved', name);
}

export async function run(): Promise<void> {
  const repo = process.env.CP_E2E_REPO!;
  const existingId = process.env.CP_E2E_SESSION!;
  const ext = vscode.extensions.getExtension('febundi.claude-projects')!;
  const api = (await ext.activate()) as ClaudeProjectsApi;
  const project = await api.store.add(repo);
  await api.store.add(process.env.CP_E2E_REPO2!);
  api.store.select(project.id);
  await vscode.commands.executeCommand('workbench.view.extension.claudeProjects');
  await waitFor('index', () => api.index.isReady);
  await sleep(1500);

  // 1) A session with rich history, then a pending Bash permission.
  await vscode.commands.executeCommand('claudeProjects.openSessionHere', { sessionId: existingId, cwd: repo });
  const s = await waitFor('session', () => api.sessions.findBySessionId(existingId));
  await waitFor('history', () => (s as unknown as { historyLoaded: boolean }).historyLoaded);
  await s.send('Now run the tests with a tool please');
  await waitFor('permission', () => s.pendingRequests.length > 0);
  await vscode.commands.executeCommand('claudeProjects.scm.focus');
  await sleep(2500);
  await screenshot('1-chat-permission');

  // 2) Allow, let it finish; dashboard beside it with an external waiting session.
  s.respondPermission(s.pendingRequests[0].requestId, 'allow');
  await waitFor('idle', () => s.status === 'idle');
  const other = await vscode.commands.executeCommand('claudeProjects.newSession', { path: repo, projectId: project.id });
  void other;
  const n = api.sessions.all[api.sessions.all.length - 1];
  await n.send('slow: explain the architecture please');
  await vscode.commands.executeCommand('claudeProjects.openDashboard');
  await vscode.commands.executeCommand('claudeProjects.projects.focus');
  await sleep(1200);
  await screenshot('2-dashboard');

  // 3) Back to the first chat to show the finished conversation.
  api.panels.show(s);
  await vscode.commands.executeCommand('claudeProjects.files.focus');
  await sleep(1500);
  await screenshot('3-chat-finished');

  // 4) Plan review card.
  await s.setMode('plan');
  await s.send('make a plan for adding dark mode');
  await waitFor('plan', () => s.pendingRequests.some((p) => p.kind === 'plan'));
  await sleep(1500);
  await screenshot('4-plan');
  s.respondPlan(s.pendingRequests[0].requestId, 'accept-manual');
  await waitFor('idle after plan', () => s.status === 'idle');

  // 5) Question card.
  await s.send('ask me a question');
  await waitFor('question', () => s.pendingRequests.some((p) => p.kind === 'question'));
  await sleep(1500);
  await screenshot('5-question');
  s.respondQuestion(s.pendingRequests[0].requestId, { 'Which color?': 'Blue' });
  await waitFor('idle after question', () => s.status === 'idle');

  // 6) Bookmarks, effort and an MCP input form.
  const items = s.getState().items;
  const firstUser = items.find((i) => i.kind === 'user' && i.text.startsWith('Add input validation'));
  const edit = items.find((i) => i.kind === 'tool' && i.name === 'Edit');
  if (firstUser) s.toggleBookmark(firstUser.id);
  if (edit) s.toggleBookmark(edit.id);
  await s.setEffort('xhigh');
  await s.send('elicit the deploy settings');
  await waitFor('elicitation', () => s.pendingRequests.some((p) => p.kind === 'elicitation'));
  await sleep(1500);
  await screenshot('7-elicitation');
  s.respondElicitation(s.pendingRequests[0].requestId, 'accept', { env: 'staging', replicas: '2' });
  await waitFor('idle after elicitation', () => s.status === 'idle');
  if (firstUser) await api.panels.revealItem(s.sessionId, repo, firstUser.id);
  await sleep(1200);
  await screenshot('8-bookmark-jump');

  // 7) Light theme.
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
  await sleep(2500);
  await screenshot('6-light');
  log('VISUAL DONE');
}
