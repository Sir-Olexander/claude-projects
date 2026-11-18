import * as vscode from 'vscode';

/** Set once the Claude Chats announcement has been shown (whatever the answer). */
export const HUB_ANNOUNCED_KEY = 'claudeProjects.hubAnnounced.v1';

export interface HubAnnounceFacts {
  /** The announcement was already shown in some window. */
  announced: boolean;
  /** The user already had projects before this version (not a fresh install). */
  existingUser: boolean;
  /** The user already chose where chats open. */
  openInChosen: boolean;
}

/** Existing users who haven't picked a mode yet hear about Claude Chats once. */
export function shouldAnnounceHub(f: HubAnnounceFacts): boolean {
  return !f.announced && f.existingUser && !f.openInChosen;
}

export interface HubAnnounceDeps {
  context: vscode.ExtensionContext;
  existingUser: boolean;
  openHub(): void;
}

/**
 * One notification for people who used the extension before Claude Chats:
 * chats now open together in one tab, and how to keep a tab per chat.
 */
export async function announceHub(d: HubAnnounceDeps): Promise<void> {
  const { context } = d;
  // A fresh install starts with Claude Chats: nothing to announce, now or later.
  if (!d.existingUser) {
    if (!context.globalState.get<boolean>(HUB_ANNOUNCED_KEY, false)) await context.globalState.update(HUB_ANNOUNCED_KEY, true);
    return;
  }
  const inspect = vscode.workspace.getConfiguration('claudeProjects').inspect<string>('chat.openIn');
  const openInChosen = inspect?.globalValue !== undefined || inspect?.workspaceValue !== undefined || inspect?.workspaceFolderValue !== undefined;
  if (!shouldAnnounceHub({ announced: context.globalState.get<boolean>(HUB_ANNOUNCED_KEY, false), existingUser: d.existingUser, openInChosen })) return;
  // Marked before asking, so it shows once even if the message is closed or another window starts.
  await context.globalState.update(HUB_ANNOUNCED_KEY, true);
  const open = 'Open Claude Chats';
  const keepTabs = 'Keep One Tab per Chat';
  const more = "What's New";
  const pick = await vscode.window.showInformationMessage(
    'Claude Projects: chats now open together in Claude Chats, grouped by project, with up to three side by side. Prefer a tab per chat, like before?',
    open,
    keepTabs,
    more,
  );
  if (pick === open) d.openHub();
  else if (pick === keepTabs) {
    await vscode.workspace.getConfiguration('claudeProjects').update('chat.openIn', 'tab', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('Chats will open in a tab each. Change it any time with the "Chat: Open In" setting.');
  } else if (pick === more) await showWhatsNew(context);
}

/** Opens the changelog (shipped with the extension) as a Markdown preview. */
export async function showWhatsNew(context: vscode.ExtensionContext): Promise<void> {
  const uri = vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md');
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch {
    await vscode.commands.executeCommand('extension.open', context.extension.id);
  }
}
