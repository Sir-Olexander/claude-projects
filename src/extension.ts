import * as vscode from 'vscode';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectStore } from './projects/ProjectStore';
import { ProjectsTreeProvider, type ProjectsNode } from './projects/ProjectsTreeProvider';
import { registerProjectCommands, type OpenExternal } from './projects/projectCommands';
import { registerCommonCommands } from './commands/common';
import { getGitViewsForTesting, registerGitViews, type GitViewsInternals } from './views/registerGitViews';
import { SessionIndex, type RememberedTitle } from './claude/SessionIndex';
import { LiveRegistry } from './claude/LiveRegistry';
import { liveSessionsDir, projectsDir } from './claude/paths';
import { SessionManager } from './sessions/SessionManager';
import { AttentionService } from './sessions/AttentionService';
import { UsageService } from './usage/UsageService';
import { HandoffService } from './handoff/Handoff';
import { ChatPanelManager } from './panels/ChatPanelManager';
import { DashboardPanel } from './panels/DashboardPanel';
import { Notifier } from './notify/Notifier';
import { WindowPresence } from './notify/WindowPresence';
import { childPath } from './claude/cliLocator';
import type { Logger } from './util/log';
import { folderName } from './util/paths';

let sessionsRef: SessionManager | undefined;

/** Internals exposed to the end-to-end tests (ext.exports). */
export interface ClaudeProjectsApi {
  store: ProjectStore;
  index: SessionIndex;
  registry: LiveRegistry;
  sessions: SessionManager;
  attention: AttentionService;
  usage: UsageService;
  panels: ChatPanelManager;
  dashboard: DashboardPanel;
  handoff: HandoffService;
  tree: ProjectsTreeProvider;
  treeView: vscode.TreeView<ProjectsNode>;
  /** Source Control and Files views (for tests). */
  gitViews(): GitViewsInternals | undefined;
}

export function activate(context: vscode.ExtensionContext): ClaudeProjectsApi {
  const channel = vscode.window.createOutputChannel('Claude Projects', { log: true });
  const log: Logger = {
    trace: (m, ...a) => channel.trace(m, ...a),
    debug: (m, ...a) => channel.debug(m, ...a),
    info: (m, ...a) => channel.info(m, ...a),
    warn: (m, ...a) => channel.warn(m, ...a),
    error: (m, ...a) => channel.error(m, ...a),
  };
  context.subscriptions.push(channel, vscode.commands.registerCommand('claudeProjects.showLogs', () => channel.show()));

  const storageDir = context.globalStorageUri.fsPath;
  mkdirSync(storageDir, { recursive: true });
  const utilityDir = join(storageDir, 'utility');
  mkdirSync(utilityDir, { recursive: true });

  // Projects and the per-project git views.
  const store = new ProjectStore(context);
  context.subscriptions.push(store, registerCommonCommands(store), registerGitViews(context, store, log));

  // What Claude Code knows: transcripts on disk and live processes.
  const TITLES_KEY = 'claudeProjects.sessionTitles.v1';
  const index = new SessionIndex(projectsDir(), log, {
    load: () => context.globalState.get<Record<string, RememberedTitle | string>>(TITLES_KEY, {}),
    save: (titles) => void context.globalState.update(TITLES_KEY, titles),
  });
  const registry = new LiveRegistry(liveSessionsDir(), log);
  context.subscriptions.push({ dispose: () => index.dispose() }, { dispose: () => registry.dispose() });

  // Usage limits in the status bar (asks a live session or a short-lived utility process).
  let sessions: SessionManager;
  const usage = new UsageService({
    context,
    log,
    getCliPath: () => sessions.getCliPath(),
    getPathEnv: () => childPath(),
    anyLiveProcess: () => sessions?.all.find((s) => s.liveProcess)?.liveProcess,
  });
  context.subscriptions.push(usage);

  sessions = new SessionManager({ context, log, index, registry, onRateLimit: (e) => usage.onRateLimitEvent(e) });
  sessionsRef = sessions;
  context.subscriptions.push(sessions);

  const handoff = new HandoffService(context, log);
  context.subscriptions.push(handoff);

  const panels = new ChatPanelManager({ context, log, sessions, store, index, handoff });
  context.subscriptions.push(panels);

  const notifier = new Notifier(context.extension.id, join(context.extensionPath, 'media', 'notification.png'), log);
  const presence = new WindowPresence(storageDir);
  presence.start(vscode.window.state.focused);
  context.subscriptions.push(
    { dispose: () => presence.dispose() },
    vscode.window.onDidChangeWindowState((s) => presence.setFocused(s.focused)),
    { dispose: sessions.onDidChange(() => presence.setClaudePids([...sessions.ownPids()])).dispose },
  );
  const attention = new AttentionService({ store, sessions, registry, index, notifier, presence, log, utilityCwd: storageDir, reveal: (key) => panels.reveal(key) });
  context.subscriptions.push(attention);

  let openExternal: OpenExternal = async () => {};
  const dashboard = new DashboardPanel({
    context,
    log,
    attention,
    sessions,
    usage,
    store,
    handoff,
    revealSession: (key) => panels.reveal(key),
    openExternal: (v) => openExternal(v),
  });
  context.subscriptions.push(dashboard);

  // Projects view.
  const tree = new ProjectsTreeProvider(store, index, sessions, attention);
  const treeView = vscode.window.createTreeView<ProjectsNode>('claudeProjects.projects', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(tree, treeView);
  // Shows a folder (a session's cwd) in the Projects view: its project, or its worktree.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProjects.revealInProjects', async (path: string) => {
      const node = typeof path === 'string' ? await tree.nodeForPath(path) : undefined;
      if (!node) {
        void vscode.window.showInformationMessage(`${typeof path === 'string' ? folderName(path) : 'This folder'} isn't in your Claude Projects list.`);
        return;
      }
      store.select(node.projectId, node.path);
      await treeView.reveal(node, { select: true, focus: true, expand: true });
    }),
  );

  const commands = registerProjectCommands({ context, log, store, index, sessions, panels, handoff, attention, dashboard, usage, tree, utilityDir: storageDir });
  openExternal = commands.openExternal;
  context.subscriptions.push(commands.disposable);

  // Badge on the activity bar icon + a status bar item when sessions need you.
  const attentionItem = vscode.window.createStatusBarItem('claudeProjects.attention', vscode.StatusBarAlignment.Right, 1001);
  attentionItem.name = 'Claude Sessions Waiting';
  attentionItem.command = 'claudeProjects.focusNextAttention';
  context.subscriptions.push(attentionItem);
  const updateAttention = () => {
    const views = attention.sessions;
    const waiting = views.filter((v) => v.attention === 'needs-input').length;
    const total = attention.attentionCount;
    treeView.badge = total ? { value: total, tooltip: `${total} Claude session${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} you` } : undefined;
    if (total) {
      attentionItem.text = waiting ? `$(bell-dot) ${waiting} waiting` : `$(pass-filled) ${total} finished`;
      attentionItem.tooltip = views
        .filter((v) => v.attention === 'needs-input' || v.attention === 'done' || v.attention === 'error')
        .slice(0, 8)
        .map((v) => `${v.projectName}: ${v.waitingFor ?? v.attention} — ${v.title}`)
        .join('\n');
      attentionItem.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      attentionItem.show();
    } else attentionItem.hide();
  };
  context.subscriptions.push({ dispose: attention.onDidChange(updateAttention).dispose });
  updateAttention();

  // vscode://febundi.claude-projects/session?key=… (notification clicks), /dashboard, /open?session=…&cwd=…
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const q = new URLSearchParams(uri.query);
        if (uri.path === '/session') {
          const key = q.get('key') ?? '';
          if (!panels.reveal(key)) dashboard.show();
        } else if (uri.path === '/open') {
          const session = q.get('session');
          const cwd = q.get('cwd');
          if (session && cwd) await panels.openExisting(session, cwd);
        } else dashboard.show();
      },
    }),
  );

  // Other windows may change the project list (global state); pick it up when focused.
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && store.reload()));

  // Start the background work.
  index.startWatching();
  void index.scanAll();
  registry.start();
  handoff.start();
  usage.start();

  log.info(`Claude Projects activated (${store.projects.length} projects)`);
  return { store, index, registry, sessions, attention, usage, panels, dashboard, handoff, tree, treeView, gitViews: getGitViewsForTesting };
}

export async function deactivate(): Promise<void> {
  await sessionsRef?.disposeAsync();
}
