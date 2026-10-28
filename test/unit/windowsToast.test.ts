import { describe, expect, it } from 'vitest';
import { toastScript, toastXml } from '../../src/notify/windowsToast';

describe('Windows toasts', () => {
  it('builds escaped toast XML that opens our URI', () => {
    const xml = toastXml({ title: 'CVFast <api>', lines: ['Needs you', "Allow 'rm -rf' & more?"], launch: 'vscode://febundi.claude-projects/session?key=a&b=1', sound: false });
    expect(xml).toBe(
      '<toast activationType="protocol" launch="vscode://febundi.claude-projects/session?key=a&amp;b=1"><visual><binding template="ToastGeneric">' +
        '<text>CVFast &lt;api&gt;</text><text>Needs you</text><text>Allow &apos;rm -rf&apos; &amp; more?</text></binding></visual><audio silent="true"/></toast>',
    );
  });
  it('never puts session text inside a PowerShell string', () => {
    const xml = "<toast><text>it’s '; Remove-Item x; ‘</text></toast>";
    const script = toastScript(xml, 'abc123');
    expect(script).not.toContain('Remove-Item');
    expect(script).not.toMatch(/[\u2018-\u201B]/);
    expect(script).toContain(Buffer.from(xml, 'utf8').toString('base64'));
    expect(script).toContain(`$toast.Tag = 'abc123'`);
    expect(() => toastScript(xml, "x'")).toThrow();
  });
});
