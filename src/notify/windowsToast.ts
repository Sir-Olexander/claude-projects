/** Windows toast notifications, shown through Windows PowerShell (no vscode imports: unit-tested). */

// Unpackaged apps need a registered app id to show toasts; Windows PowerShell's always is.
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export interface ToastContent {
  title: string;
  lines: string[];
  /** URI opened when the toast is clicked. */
  launch?: string;
  /** file: URL of the image shown next to the text. */
  image?: string;
  sound: boolean;
}

/** Toast XML for Windows (https://learn.microsoft.com/windows/apps/design/shell/tiles-and-notifications/adaptive-interactive-toasts). */
export function toastXml(t: ToastContent): string {
  const text = (s: string) => `<text>${xmlEscape(s.replace(/[\r\n]+/g, ' '))}</text>`;
  const launch = t.launch ? ` activationType="protocol" launch="${xmlEscape(t.launch)}"` : '';
  const image = t.image ? `<image placement="appLogoOverride" src="${xmlEscape(t.image)}"/>` : '';
  const audio = t.sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>';
  return `<toast${launch}><visual><binding template="ToastGeneric">${text(t.title)}${t.lines.slice(0, 2).map(text).join('')}${image}</binding></visual>${audio}</toast>`;
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * PowerShell that shows the toast. Toasts with the same tag replace each other.
 *
 * The XML carries text from the session (titles, the command Claude wants to
 * run), so it goes in as base64: PowerShell also ends strings at curly quotes
 * (‘ ’), and escaping by hand is easy to get wrong. The tag is hex.
 */
export function toastScript(xml: string, tag?: string): string {
  const xml64 = Buffer.from(xml, 'utf8').toString('base64');
  if (tag && !/^[0-9a-f]+$/.test(tag)) throw new Error('toast tag must be hex');
  return [
    `$ErrorActionPreference = 'Stop'`,
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
    `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xml64}')))`,
    `$toast = New-Object Windows.UI.Notifications.ToastNotification $xml`,
    ...(tag ? [`$toast.Tag = '${tag}'`, `$toast.Group = 'claude-projects'`] : []),
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join('\r\n') + '\r\n';
}
