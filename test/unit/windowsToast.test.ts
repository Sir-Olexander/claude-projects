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
  it('quotes the XML for PowerShell', () => {
    const script = toastScript("<toast><text>it's</text></toast>", 'abc');
    expect(script).toContain(`$xml.LoadXml('<toast><text>it''s</text></toast>')`);
    expect(script).toContain(`$toast.Tag = 'abc'`);
  });
});
