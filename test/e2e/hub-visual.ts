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

  // PROBE: does a chat that finishes out of view stay Finished?
  if (process.env.CP_PROBE_DONE) {
    await vscode.commands.executeCommand('claudeProjects.openHub');
    await sleep(1000);
    const x = await api.panels.newSession(repo);
    const y = await api.panels.newSession(process.env.CP_E2E_REPO2!);
    await waitFor('y ready', () => api.hub.chatReady(y.key));
    await inHub(`(d) => { d.querySelector('.pane.is-focused textarea')?.focus(); return true; }`);
    await sleep(500);
    const chip = (k: string) => api.hub.snapshot.sessions.find((v) => v.key === k)?.attention;
    log('window focused', vscode.window.state.focused, 'hub active', api.hub.webviewPanel?.active);
    await x.send('turn while out of view');
    await waitFor('x idle', () => x.status === 'idle', 20_000);
    for (const t of [200, 1000, 3000]) {
      await sleep(t);
      log(`x out of panes after +${t}ms: unread=${x.unread} focused=${x.focused} chip=${chip(x.key)}`);
    }
    // In a background pane.
    await hubPost({ type: 'set-pane-count', count: 2 });
    api.hub.show(x, { pane: 1 });
    await hubPost({ type: 'focus-pane', pane: 0 });
    await waitFor('x ready', () => api.hub.chatReady(x.key));
    await sleep(1500);
    log(`x shown in background pane: unread=${x.unread} chip=${chip(x.key)} focusedPane=${api.hub.snapshot.focusedPane}`);
    await x.send('second turn in background pane');
    await waitFor('x idle 2', () => x.status === 'idle' && x.getState().items.some((i) => i.kind === 'text' && i.text.includes('second turn')), 20_000);
    for (const t of [200, 1000, 3000]) {
      await sleep(t);
      log(`x background pane after +${t}ms: unread=${x.unread} focused=${x.focused} chip=${chip(x.key)}`);
    }
    // Switch the focused pane to another chip, then let x finish out of panes.
    await hubPost({ type: 'set-pane-count', count: 1 });
    api.hub.show(y);
    await sleep(800);
    await x.send('third turn after switching away');
    await waitFor('x idle 3', () => x.status === 'idle' && x.getState().items.some((i) => i.kind === 'text' && i.text.includes('third turn')), 20_000);
    for (const t of [200, 3000]) {
      await sleep(t);
      log(`x after switching away +${t}ms: unread=${x.unread} focused=${x.focused} chip=${chip(x.key)}`);
    }
    // On screen in the focused pane, but the last click was in the strip: stays Finished.
    await hubPost({ type: 'set-pane-count', count: 1 });
    api.hub.show(x);
    await waitFor('x ready again', () => api.hub.chatReady(x.key));
    await sleep(800);
    await inHub(`(d) => { d.querySelector('.pane textarea')?.focus(); return true; }`);
    await sleep(400);
    log(`x focused in pane: focused=${x.focused} unread=${x.unread} chip=${chip(x.key)}`);
    void x.send('slow: fourth turn while I browse the strip');
    await sleep(300);
    // Click a project tab in the strip (not the chat).
    await inHub(`(d) => { const t = [...d.querySelectorAll('.rtab')].find((e) => !e.classList.contains('is-selected')) || d.querySelector('.rtab'); t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); t.click(); t.focus(); return true; }`);
    await waitFor('x idle 4', () => x.status === 'idle' && x.getState().items.some((i) => i.kind === 'text' && i.text.includes('long and slow')), 30_000);
    await sleep(1500);
    log(`x finished on screen while browsing the strip: focused=${x.focused} unread=${x.unread} chip=${chip(x.key)}`);
    // Click into the chat: now it's seen.
    await inHub(`(d) => { const a = d.querySelector('.pane .messages') || d.querySelector('.pane .app'); a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; }`);
    await sleep(1500);
    log(`after clicking into x: unread=${x.unread} chip=${chip(x.key)}`);
    log('PROBE DONE');
    return;
  }

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

  // Switching chats in and out of a pane: none may stay on "Loading session…",
  // and an image pasted into a draft must still be there after switching away and back.
  await hubPost({ type: 'set-pane-count', count: 1 });
  api.hub.show(m1);
  await waitFor('m1 ready', () => api.hub.chatReady(m1.key));
  await sleep(800);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  for (let i = 0; i < 50 && !(await inHub(`(d) => !!d.querySelector('.pane.is-focused textarea')`)); i++) await sleep(100);
  const pasted = await inHub(`(d) => { const ta = d.querySelector('.pane.is-focused textarea'); if (!ta) return 'no textarea'; const bin = atob('${png}'); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' })); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 'pasted'; }`);
  log('paste:', pasted);
  await sleep(800);
  const thumbsBefore = await inHub(`(d) => d.querySelectorAll('.pane.is-focused .thumb').length`);
  const order = [a3, main, w1, m1, a3, m1, main, m1];
  for (const s of order) {
    api.hub.show(s);
    await sleep(250);
  }
  await sleep(1500);
  const loading = await inHub(`(d) => d.querySelectorAll('.pane .app-loading').length`);
  const thumbsAfter = await inHub(`(d) => d.querySelectorAll('.pane.is-focused .thumb').length`);
  log(`after switching: panes stuck loading=${loading}; image thumbs before=${thumbsBefore} after=${thumbsAfter}`);
  await screenshot('hub-9-after-switching');

  // Hover: the × on a project tab and on a chat chip.
  const hoverAt = async (selector: string) => {
    const r = (await inHub(`(d) => { const e = d.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }`)) as { x: number; y: number } | null;
    const frame = (await cdp('Runtime.evaluate', { returnByValue: true, expression: `(() => { const f = [...document.querySelectorAll('iframe.webview')].map((x) => x.getBoundingClientRect()).filter((b) => b.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return f ? { x: f.left, y: f.top } : null; })()` })).result?.value as { x: number; y: number } | null;
    if (!r || !frame) return log('hover target not found', selector);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frame.x + r.x, y: frame.y + r.y });
  };
  await hubPost({ type: 'set-pane-count', count: 2 });
  api.hub.show(main);
  await sleep(800);
  await hoverAt('.rtab.is-selected');
  await sleep(500);
  await screenshot('hub-10-hover-project');
  await hoverAt('.strip .chip:nth-of-type(2)');
  await sleep(500);
  await screenshot('hub-11-hover-chip');

  // Drag a project tab to the front (chats are ordered by when you last entered them).
  {
    const drag = (sel: string, from: number, to: number, side: 'before' | 'after', drop: boolean) =>
      inHub(`(d) => {
        const items = [...d.querySelectorAll(${JSON.stringify(sel)})];
        const a = items[${'${from}'}], b = items[${'${to}'}];
        if (!a || !b) return 'missing ' + items.length;
        const dt = new DataTransfer();
        a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        return new Promise((res) => setTimeout(() => {
          const r = b.getBoundingClientRect();
          const x = ${'${side}'} === 'before' ? r.left + 3 : r.right - 3;
          b.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: r.top + 5 }));
          setTimeout(() => {
            if (${'${drop}'}) { b.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: r.top + 5 })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); }
            res('ok');
          }, 120);
        }, 120));
      }`.replace('${from}', String(from)).replace('${to}', String(to)).replace("${side}", JSON.stringify(side)).replace('${drop}', String(drop)));
    api.hub.show(main);
    await sleep(800);
    log('drag marker:', await drag('.rtab', 0, 2, 'after', false));
    await sleep(300);
    await screenshot('hub-12-drag-marker');
    await inHub(`(d) => { d.querySelector('.rtab')?.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true; }`);
    await sleep(300);
    const reposBefore = api.hub.snapshot.repos.map((r) => r.name);
    log('drag repo:', await drag('.rtab', reposBefore.length - 1, 0, 'before', true));
    await sleep(800);
    log('repos before:', JSON.stringify(reposBefore), 'after:', JSON.stringify(api.hub.snapshot.repos.map((r) => r.name)));
  }

  // Double-click a project tab: opens the chat you were last in there.
  {
    api.hub.show(w1);
    await sleep(300);
    api.hub.show(w2);
    await sleep(300);
    api.hub.show(main);
    await sleep(800);
    const r = await inHub(`(d) => { const t = [...d.querySelectorAll('.rtab')].find((e) => e.innerText.includes('web-app')); if (!t) return 'no tab'; t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'ok'; }`);
    await sleep(800);
    const snap = api.hub.snapshot;
    const shownKey = snap.panes[snap.focusedPane];
    log('dblclick web-app:', r, 'shows', snap.sessions.find((x) => x.key === shownKey)?.title, '(expected', w2.title + ')');
  }

  // Webview errors.
  const errors = await inHub(`(d) => (window.__hubErrors || []).join('\\n')`);
  log('hub webview errors:', errors || 'none');
  log('strip:', JSON.stringify(api.hub.snapshot.repos.map((r) => r.name)), JSON.stringify(api.hub.snapshot.sessions.map((s) => `${s.title}:${s.attention}:${s.flag ?? ''}`)));
  log('HUB VISUAL DONE');
}
