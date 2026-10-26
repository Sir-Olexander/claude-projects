/**
 * Diagnostics for the chat webview: drags the mouse over messages, then
 * copies with Cmd+C, Cmd+X and the right-click menu, and checks the clipboard.
 * Writes the real clipboard.
 */
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drags the mouse over user messages in each chat webview, copies, and reports what got selected and copied. */
export async function probeSelection(screenshot: (name: string) => Promise<void>, log: (...a: unknown[]) => void, selector = '.user-text', max = 3): Promise<void> {
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
      const count = await ev(`${doc}.querySelectorAll('${selector}').length`);
      // The last few messages (the most recent prompts).
      for (let i = Math.max(0, (count ?? 0) - max); i < (count ?? 0); i++) {
        const info = await ev(`(() => { const d = ${doc}; const f = document.querySelector('iframe'); const el = d.querySelectorAll('${selector}')[${i}]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const o = f ? f.getBoundingClientRect() : { left: 0, top: 0 }; const hit = d.elementFromPoint(r.left + 3, r.top + 6); return { x: r.left + o.left, y: r.top + o.top, w: Math.min(r.width, 300), h: r.height, text: el.textContent.slice(0, 40), hit: hit ? hit.className || hit.tagName : null }; })()`);
        // Start from somewhere else, like a user clicking in from the sidebar.
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
        await sleep(400);
        const y = info.y + 6;
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x + 1, y, button: 'left', clickCount: 1 });
        for (let k = 1; k <= 10; k++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x + 1 + ((info.w - 2) * k) / 10, y, button: 'left', buttons: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x + info.w - 1, y, button: 'left', clickCount: 1 });
        await sleep(300);
        const selected = await ev(`(${doc}.getSelection() || window.getSelection()).toString()`);
        const key = async (k: string) => {
          await vscode.env.clipboard.writeText('<nothing copied>');
          const code = `Key${k.toUpperCase()}`;
          await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: process.platform === 'darwin' ? 4 : 2 });
          await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: process.platform === 'darwin' ? 4 : 2 });
          await sleep(400);
          return vscode.env.clipboard.readText();
        };
        const viaC = await key('c');
        const viaX = await key('x');
        // Right-click on the selection, then pick Copy from our menu.
        await vscode.env.clipboard.writeText('<nothing copied>');
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x + info.w / 2, y, button: 'right', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x + info.w / 2, y, button: 'right', clickCount: 1 });
        await sleep(300);
        const menuItems = await ev(`[...${doc}.querySelectorAll('.copy-menu-item')].map((b) => b.textContent)`);
        await ev(`${doc}.querySelector('.copy-menu-item')?.click()`);
        await sleep(400);
        const viaMenu = await vscode.env.clipboard.readText();
        log(`probe "${info.text}" selected=${JSON.stringify(selected)} cmdC=${JSON.stringify(viaC)} cmdX=${JSON.stringify(viaX)} menu=${JSON.stringify(menuItems)} rightClickCopy=${JSON.stringify(viaMenu)}`);
        if (selected && (viaC !== selected || viaX !== selected || viaMenu !== selected)) throw new Error(`copy failed for "${info.text}"`);
        // The copy button next to the message.
        await vscode.env.clipboard.writeText('<nothing copied>');
        await ev(`${doc}.querySelectorAll('${selector}')[${i}].closest('.msg-user')?.querySelector('.user-copy')?.click()`);
        await sleep(400);
        log(`copy button -> ${JSON.stringify((await vscode.env.clipboard.readText()).slice(0, 80))}`);
      }
      await screenshot('probe-select');
      ws.close();
    } catch (err) {
      log('probe failed for a target:', String(err));
    }
  }
}

/** Selects a folder in the Files view, then clicks empty space below the rows, and reports the selection each time. */
export async function probeFilesSelection(api: { gitViews(): { files: { getChildren(n?: unknown): unknown }; filesView: vscode.TreeView<{ path: string; isDirectory: boolean }> } | undefined }, log: (...a: unknown[]) => void): Promise<void> {
  const views = api.gitViews();
  if (!views) return log('no files view');
  await vscode.commands.executeCommand('claudeProjects.files.focus');
  const top = (await views.files.getChildren()) as { path: string; isDirectory: boolean }[];
  const dir = top.find((n) => n.isDirectory);
  if (!dir) return log('no folder in the Files view');
  await views.filesView.reveal(dir, { select: true, focus: true });
  await sleep(500);
  log('after selecting a folder:', views.filesView.selection.map((n) => n.path));
  const port = process.env.CP_E2E_CDP_PORT;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'))!;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  const rect = (await call('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const pane = [...document.querySelectorAll('.pane')].find((p) => p.querySelector('.pane-header .title')?.textContent?.trim() === 'Files'); const body = pane?.querySelector('.pane-body'); const rows = pane?.querySelectorAll('.monaco-list-row'); if (!body) return null; const b = body.getBoundingClientRect(); const last = rows && rows.length ? rows[rows.length - 1].getBoundingClientRect() : b; return { x: b.left + 40, y: Math.min(b.bottom - 6, last.bottom + 20), bottom: b.bottom, lastRow: last.bottom }; })()`,
  }))?.result?.value;
  log('files pane:', JSON.stringify(rect));
  if (rect) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await sleep(500);
    log('after clicking empty space:', views.filesView.selection.map((n) => n.path));
  }
  ws.close();
}

/** Creates a folder and then a file from the title bar (no argument) and reports where each lands and what is selected. */
export async function probeFilesCreate(api: { gitViews(): { filesView: vscode.TreeView<{ path: string }> } | undefined }, root: string, log: (...a: unknown[]) => void): Promise<void> {
  const views = api.gitViews();
  if (!views) return;
  const sel = () => views.filesView.selection.map((n) => n.path.replace(root, '<root>'));
  const { existsSync } = await import('node:fs');
  log('start selection:', JSON.stringify(sel()));
  await vscode.commands.executeCommand('claudeProjects.files.newFolder', undefined, { name: 'probe-a' });
  await sleep(800);
  log('made folder probe-a; selection:', JSON.stringify(sel()));
  await vscode.commands.executeCommand('claudeProjects.files.newFile', undefined, { name: 'probe-1.txt' });
  await sleep(800);
  log('made probe-1.txt at root?', existsSync(`${root}/probe-1.txt`), 'in probe-a?', existsSync(`${root}/probe-a/probe-1.txt`), 'selection:', JSON.stringify(sel()));
  await vscode.commands.executeCommand('claudeProjects.files.newFolder', undefined, { name: 'probe-b' });
  await sleep(800);
  await vscode.commands.executeCommand('claudeProjects.files.newFile', undefined, { name: 'probe-2.txt' });
  await sleep(800);
  log('probe-2 at root?', existsSync(`${root}/probe-2.txt`), 'in probe-b?', existsSync(`${root}/probe-b/probe-2.txt`), 'selection:', JSON.stringify(sel()));
}
