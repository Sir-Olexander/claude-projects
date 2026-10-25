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

  if (process.env.CP_E2E_PROBE_SELECT) {
    await probeSelection();
    // Again while Claude is writing a long reply.
    void s.send('slow: write a long answer please');
    await waitFor('streaming', () => s.status === 'running');
    await sleep(800);
    log('--- while running ---');
    await probeSelection();
    await waitFor('idle after slow', () => s.status === 'idle', 30_000);
  }

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

  // 7b) A message with a pasted image (big enough to go through the image cache).
  if (process.env.CP_E2E_IMAGE) {
    const { readFileSync } = await import('node:fs');
    const data = readFileSync(process.env.CP_E2E_IMAGE).toString('base64');
    await s.send('look at this picture', [{ mediaType: 'image/png', data, name: 'image.png' }]);
    await waitFor('idle after image', () => s.status === 'idle');
    await sleep(1500);
    const img = s.getState().items.filter((i) => i.kind === 'user').pop() as { images?: { url?: string; data: string }[] };
    log('sent image attachment:', JSON.stringify(img.images?.map((i) => ({ url: i.url, dataLen: i.data.length }))));
    await api.panels.revealItem(s.sessionId, repo, (img as unknown as { id: string }).id);
    await sleep(1500);
    await screenshot('9-pasted-image');
  }

  // 8) A usage limit stops the turn; continue automatically is switched on.
  await s.send('please hit-limit now');
  await waitFor('limit notice', () => !!s.limitStop);
  s.setAutoContinue(true);
  api.panels.show(s);
  await sleep(1500);
  await screenshot('10-limit');
  await vscode.commands.executeCommand('claudeProjects.openDashboard');
  await sleep(1200);
  await screenshot('11-limit-dashboard');
  api.panels.show(s);

  // 7) Light theme.
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
  await sleep(2500);
  await screenshot('6-light');
  log('VISUAL DONE');
}

/** Drags the mouse over user messages in each chat webview, copies, and reports what got selected and copied. */
async function probeSelection(): Promise<void> {
  const port = process.env.CP_E2E_CDP_PORT;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  for (const t of targets.filter((x) => x.url.startsWith('vscode-webview://'))) {
    try {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
      });
      let id = 0;
      const call = (method: string, params: object = {}) =>
        new Promise<any>((resolve) => {
          const my = ++id;
          ws.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id === my) resolve(m.result ?? m.error);
          };
          ws.send(JSON.stringify({ id: my, method, params }));
        });
      const ev = async (expression: string) => (await call('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
      const doc = `(document.querySelector('iframe')?.contentDocument || document)`;
      const count = await ev(`${doc}.querySelectorAll('.user-text').length`);
      for (let i = 0; i < Math.min(count ?? 0, 3); i++) {
        const info = await ev(`(() => { const d = ${doc}; const f = document.querySelector('iframe'); const el = d.querySelectorAll('.user-text')[${i}]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const o = f ? f.getBoundingClientRect() : { left: 0, top: 0 }; const hit = d.elementFromPoint(r.left + 3, r.top + 6); return { x: r.left + o.left, y: r.top + o.top, w: Math.min(r.width, 300), h: r.height, text: el.textContent.slice(0, 40), hit: hit ? hit.className || hit.tagName : null }; })()`);
        // Start from somewhere else, like a user clicking in from the sidebar.
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
        await sleep(400);
        const y = info.y + 6;
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x + 1, y, button: 'left', clickCount: 1 });
        for (let k = 1; k <= 10; k++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x + 1 + ((info.w - 2) * k) / 10, y, button: 'left', buttons: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x + info.w - 1, y, button: 'left', clickCount: 1 });
        await sleep(300);
        const selected = await ev(`(${doc}.getSelection() || window.getSelection()).toString()`);
        await vscode.env.clipboard.writeText('<nothing copied>');
        await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
        await sleep(300);
        log(`probe "${info.text}" hit=${info.hit} selected=${JSON.stringify(selected)} copied=${JSON.stringify(await vscode.env.clipboard.readText())}`);
        // The hover copy button.
        await vscode.env.clipboard.writeText('<nothing copied>');
        await ev(`${doc}.querySelectorAll('.user-text')[${i}].closest('.bm-frame').querySelector('.bm-copy').click()`);
        await sleep(400);
        log(`copy button -> ${JSON.stringify(await vscode.env.clipboard.readText())}`);
      }
      await screenshot('probe-select');
      ws.close();
    } catch (err) {
      log('probe failed for a target:', String(err));
    }
  }
}
