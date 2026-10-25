import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/**
 * HTML shell for our webviews. Loads codicons + the bundle's CSS/JS from
 * dist/webview with a strict CSP. The app mounts into #root and posts
 * `{type:'ready'}` when it has loaded.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, app: 'chat' | 'dashboard', title: string): string {
  const dist = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, file)).toString();
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob: https:`,
    `media-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `connect-src 'none'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language || 'en')}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${uri('codicon.css')}">
<link rel="stylesheet" href="${uri(`${app}.css`)}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri(`${app}.js`)}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
