/**
 * Visual pass for Claude Chats (the sessions hub): several projects with open
 * chats in different states, flags, two and three panes, the strip's menus.
 * Run with `node test/e2e/run.mjs --hub`; screenshots go to $CP_E2E_SHOTS.
 * Also reports errors logged in the hub webview.
 */
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudeProjectsApi } from '../../src/extension';
import type { HubToExtMessage } from '../../src/shared/protocol';
import { webviewQuery } from './probe';

const log = (...a: unknown[]) => console.log('[hub-visual]', ...a);
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

async function cdp(method: string, params: object, pick = (u: string) => u.includes('workbench')): Promise<any> {
  const port = process.env.CP_E2E_CDP_PORT;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page' && pick(t.url));
  if (!page) throw new Error('page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const res = await new Promise<any>((resolve) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result ?? m.error);
    };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return res;
}

async function screenshot(name: string): Promise<void> {
  const dir = process.env.CP_E2E_SHOTS;
  if (!process.env.CP_E2E_CDP_PORT || !dir) return;
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(r.data, 'base64'));
  log('saved', name);
}

/** Runs `fn(document)` in the hub webview (the frame that has the strip). */
async function inHub(fn: string): Promise<unknown> {
  const results = await webviewQuery(`(d) => d.querySelector('.hub') ? (${fn})(d) : '__not_hub__'`);
  return results.find((r) => r !== '__not_hub__');
}

function gitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
}

export async function run(): Promise<void> {
  const repo = process.env.CP_E2E_REPO!;
  const existingId = process.env.CP_E2E_SESSION!;
  const ext = vscode.extensions.getExtension('Sir-Olexander.claude-projects')!;
  const api = (await ext.activate()) as ClaudeProjectsApi;
  const hubPost = (m: HubToExtMessage) => (api.hub as unknown as { onMessage(m: HubToExtMessage): Promise<void> }).onMessage(m);

  // Projects: the test repo (with a worktree), the web app and two more.
  const base = dirname(repo);
  const mobile = join(base, 'mobile-app');
  const infra = join(base, 'infra');
  gitRepo(mobile);
  gitRepo(infra);
  const p1 = await api.store.add(repo);
  await api.store.add(process.env.CP_E2E_REPO2!);
  await api.store.add(mobile);
  await api.store.add(infra);
  await api.store.rename(p1.id, 'FeBundi');
  api.store.select(p1.id);
  await vscode.commands.executeCommand('workbench.view.extension.claudeProjects');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await waitFor('index', () => api.index.isReady);
  await sleep(1000);

  // Empty hub first.
  await vscode.commands.executeCommand('claudeProjects.openHub');
  await sleep(1500);
  await screenshot('hub-0-empty');

  // Chats: the existing one (rich history), plus new ones in each project.
  await vscode.commands.executeCommand('claudeProjects.openSessionHere', { sessionId: existingId, cwd: repo });
  const main = await waitFor('existing', () => api.sessions.findBySessionId(existingId));
  await waitFor('loaded', () => api.hub.chatReady(main.key));
  const make = async (cwd: string, first?: string) => {
    const s = await api.panels.newSession(cwd);
    if (first) {
      await s.send(first);
      await waitFor(`reply in ${cwd}`, () => s.status === 'idle' || s.pendingRequests.length > 0, 30_000);
    }
    return s;
  };
  const wt = join(repo, '.claude', 'worktrees', 'feature-x');
  const a2 = await make(wt, 'Phone preview layout for the editor');
  const a3 = await make(repo, 'Gatekeeper token refresh');
  const a4 = await make(repo, 'Old experiment with websockets');
  const w1 = await make(process.env.CP_E2E_REPO2!, 'Set up the web app routing');
  const w2 = await make(process.env.CP_E2E_REPO2!, 'Run the tool please');
  const m1 = await make(mobile, 'Onboarding screens copy');
  const i1 = await make(infra, 'Disk usage cleanup on the build box');

  api.flags.set(main.sessionId, 'main');
  api.flags.set(a3.sessionId, 'waiting');
  api.flags.set(a4.sessionId, 'trash');
  api.flags.set(w1.sessionId, 'review');
  api.flags.set(i1.sessionId, 'parked');
  void m1;

  // Two panes: the main chat and the one asking for a permission.
  api.panels.show(main);
  await hubPost({ type: 'set-pane-count', count: 2 });
  api.hub.show(w2, { pane: 1 });
  await hubPost({ type: 'focus-pane', pane: 0 });
  api.hub.show(main);
  await waitFor('both ready', () => api.hub.chatReady(main.key) && api.hub.chatReady(w2.key));
  void main.send('slow: summarize what changed');
  await sleep(1800);
  await screenshot('hub-1-two-panes');

  // Three panes.
  await hubPost({ type: 'set-pane-count', count: 3 });
  api.hub.show(a2, { pane: 2 });
  await sleep(2000);
  await screenshot('hub-2-three-panes');
  await waitFor('main idle', () => main.status === 'idle', 30_000);

  // Right-click a chip.
  await hubPost({ type: 'set-pane-count', count: 2 });
  await sleep(600);
  await inHub(`(d) => { const c = [...d.querySelectorAll('.strip .chip')].find((x) => x.innerText.includes('Gatekeeper')); if (!c) return false; const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.bottom + 4 })); return true; }`);
  await sleep(700);
  await screenshot('hub-3-chip-menu');
  await inHub(`(d) => { d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; }`);

  // The legend.
  await inHub(`(d) => { d.querySelector('.controls .cbtn:last-child')?.click(); return true; }`);
  await sleep(600);
  await screenshot('hub-4-legend');
  await inHub(`(d) => { d.querySelector('.legend-close')?.click(); return true; }`);

  // Another project selected.
  await inHub(`(d) => { [...d.querySelectorAll('.rtab')].find((x) => x.innerText.includes('web-app'))?.click(); return true; }`);
  await sleep(700);
  await screenshot('hub-5-other-project');

  // Filter across projects.
  await inHub(`(d) => { const i = d.querySelector('.filter input'); i.value = 'o'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; }`);
  await sleep(700);
  await screenshot('hub-6-filter');
  await inHub(`(d) => { const i = d.querySelector('.filter input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; }`);

  // The flag menu in a chat header.
  await inHub(`(d) => { d.querySelector('.pane.is-focused .flag-btn')?.click(); return true; }`);
  await sleep(600);
  await screenshot('hub-7-flag-menu');
  await inHub(`(d) => { d.querySelector('.pane.is-focused .flag-btn')?.click(); return true; }`);

  // The pane's "more" menu.
  await inHub(`(d) => { d.querySelector('.pane.is-focused .icon-btn[aria-label="More actions"]')?.click(); return true; }`);
  await sleep(600);
  await screenshot('hub-7b-more-menu');
  await inHub(`(d) => { d.querySelector('.pane.is-focused .icon-btn[aria-label="More actions"]')?.click(); return true; }`);

  // Narrow window.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  await screenshot('hub-8-narrow');
  await cdp('Emulation.clearDeviceMetricsOverride', {});

  // Webview errors.
  const errors = await inHub(`(d) => (window.__hubErrors || []).join('\\n')`);
  log('hub webview errors:', errors || 'none');
  log('strip:', JSON.stringify(api.hub.snapshot.repos.map((r) => r.name)), JSON.stringify(api.hub.snapshot.sessions.map((s) => `${s.title}:${s.attention}:${s.flag ?? ''}`)));
  log('HUB VISUAL DONE');
}
