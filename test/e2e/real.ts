/**
 * Read-only look at real data (run.mjs --real): the user's own ~/.claude,
 * a few real projects, one real session's history (nothing is sent), the
 * dashboard with the sessions actually running, and real usage numbers.
 */
import * as vscode from 'vscode';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeProjectsApi } from '../../src/extension';

const log = (...a: unknown[]) => console.log('[real]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T, ms = 30_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(150);
  }
}

async function screenshot(name: string): Promise<void> {
  const port = process.env.CP_E2E_CDP_PORT;
  const dir = process.env.CP_E2E_SHOTS;
  if (!port || !dir) return;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'))!;
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
  const projects = (process.env.CP_REAL_PROJECTS ?? '').split(':').filter(Boolean);
  const ext = vscode.extensions.getExtension('febundi.claude-projects')!;
  const api = (await ext.activate()) as ClaudeProjectsApi;
  await api.store.addMany(projects);
  api.store.select(api.store.projects[0].id);
  await vscode.commands.executeCommand('workbench.view.extension.claudeProjects');
  await waitFor('index', () => api.index.isReady);
  log('sessions indexed:', api.index.allCwds().reduce((n, c) => n + c.count, 0));
  log('live sessions:', api.registry.entries.map((e) => `${e.pid}:${e.entrypoint}:${e.status}`).join(' '));

  await vscode.commands.executeCommand('claudeProjects.refreshUsage');
  const usage = await waitFor('usage', () => (api.usage.current?.fiveHour ? api.usage.current : undefined), 45_000);
  log('usage 5h', usage.fiveHour?.percent, 'week', usage.sevenDay?.percent, 'others', usage.others.map((o) => `${o.label}:${o.window.percent}`).join(','));

  // Dashboard with whatever is running right now.
  await vscode.commands.executeCommand('claudeProjects.openDashboard');
  await sleep(2500);
  await screenshot('r1-dashboard');
  log('dashboard sessions:', api.attention.sessions.map((v) => `${v.projectName} | ${v.source} | ${v.attention} | ${v.title}`).join('\n  '));

  // Open a real session's history (read-only: no message is sent, no process starts).
  const target = process.env.CP_REAL_SESSION_CWD ?? projects[0];
  const info = api.index.sessionsFor(target).find((s) => !api.registry.bySessionId(s.sessionId).length) ?? api.index.sessionsFor(target)[0];
  if (info) {
    await vscode.commands.executeCommand('claudeProjects.openSessionHere', { sessionId: info.sessionId, cwd: target, title: info.title });
    const s = await waitFor('session', () => api.sessions.findBySessionId(info.sessionId));
    await waitFor('history', () => (s as unknown as { historyLoaded: boolean }).historyLoaded, 60_000);
    log('history items:', s.getState().items.length, 'process alive:', s.processAlive);
    await sleep(3000);
    await screenshot('r2-real-session');
  }
  // A brand-new session (nothing sent): the composer should already show the real defaults.
  await vscode.commands.executeCommand('claudeProjects.newSession', { path: projects[0] });
  const fresh = api.sessions.all.find((x) => x.isNew);
  if (fresh) {
    await waitFor('defaults', () => fresh.modelLabel && fresh.effort, 30_000).catch(() => undefined);
    log('new session before any message:', fresh.modelLabel, fresh.effort, 'efforts:', fresh.getState().availableEfforts.join(','), 'process alive:', fresh.processAlive);
    await sleep(1500);
    await screenshot('r3-new-session-defaults');
  }
  log('REAL DONE');
}
