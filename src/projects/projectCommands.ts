import * as vscode from 'vscode';
import { appendFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { SessionIndex } from '../claude/SessionIndex';
import { transcriptPathFor } from '../claude/paths';
import type { HandoffService } from '../handoff/Handoff';
import type { ChatPanelManager } from '../panels/ChatPanelManager';
import type { DashboardPanel } from '../panels/DashboardPanel';
import type { AttentionService } from '../sessions/AttentionService';
import type { SessionManager } from '../sessions/SessionManager';
import type { LiveSessionView } from '../shared/protocol';
import { SESSION_SOURCE_LABELS } from '../shared/protocol';
import type { UsageService } from '../usage/UsageService';
import { errorMessage, type Logger } from '../util/log';
import { folderName, isSameOrInside, realPath, tildify } from '../util/paths';
import { shortAgo } from '../util/time';
import type { ProjectStore } from './ProjectStore';
import type { MoreNode, ProjectsNode, ProjectsTreeProvider, SessionNode } from './ProjectsTreeProvider';
import { listWorktrees } from '../git/gitCli';

export interface ProjectCommandDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  store: ProjectStore;
  index: SessionIndex;
  sessions: SessionManager;
  panels: ChatPanelManager;
  handoff: HandoffService;
  attention: AttentionService;
  dashboard: DashboardPanel;
  usage: UsageService;
  tree: ProjectsTreeProvider;
  utilityDir: string;
}

type SessionArg = SessionNode | { sessionId: string; cwd: string; title?: string } | undefined;

function openMode(): 'here' | 'claudeExtension' {
  return vscode.workspace.getConfiguration('claudeProjects').get<'here' | 'claudeExtension'>('sessions.defaultOpenMode', 'here');
}

export function registerProjectCommands(d: ProjectCommandDeps): { disposable: vscode.Disposable; openExternal: OpenExternal } {
  const { store, index, sessions, panels, handoff, attention, dashboard, usage, tree, log } = d;
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        log.error(`${id} failed: ${errorMessage(err)}`);
        void vscode.window.showErrorMessage(`Claude Projects: ${errorMessage(err)}`);
      }
    });

  /** Project/worktree path from a tree node, a {path} object or the current selection. */
  const targetPath = (arg: unknown): string | undefined => {
    if (arg && typeof arg === 'object' && typeof (arg as { path?: unknown }).path === 'string') return (arg as { path: string }).path;
    if (arg instanceof vscode.Uri) return arg.fsPath;
    if (typeof arg === 'string') return arg;
    return undefined;
  };

  const pickFolder = async (placeHolder: string): Promise<string | undefined> => {
    if (!store.projects.length) {
      const add = await vscode.window.showInformationMessage('Add a project first.', 'Add Project…');
      if (add) await vscode.commands.executeCommand('claudeProjects.addProject');
      return undefined;
    }
    const items: (vscode.QuickPickItem & { path: string })[] = [];
    const sel = store.selection;
    const ordered = [...store.projects].sort((a, b) => (a.id === sel?.projectId ? -1 : b.id === sel?.projectId ? 1 : 0));
    for (const p of ordered) {
      items.push({ label: `$(folder) ${p.name}`, description: tildify(p.path), path: p.path });
      const wts = await listWorktrees(p.path).catch(() => []);
      for (const w of wts) if (w.path !== p.path && !w.bare) items.push({ label: `$(git-branch) ${p.name} · ${w.branch ?? folderName(w.path)}`, description: tildify(w.path), path: w.path });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return pick?.path;
  };

  const resolveSession = (arg: SessionArg) => {
    if (arg && 'sessionId' in arg && arg.sessionId) return { sessionId: arg.sessionId, cwd: arg.cwd, title: 'title' in arg ? arg.title : undefined };
    const active = panels.activeSession;
    if (active) return { sessionId: active.sessionId, cwd: active.cwd, title: active.title, managed: active };
    return undefined;
  };

  const openHere = async (arg: SessionArg) => {
    const s = resolveSession(arg);
    if (!s) return;
    const managed = sessions.findBySessionId(s.sessionId);
    if (managed) {
      panels.show(managed);
      return;
    }
    await panels.openExisting(s.sessionId, s.cwd, s.title);
  };

  const openInClaudeExtension = async (arg: SessionArg) => {
    const s = resolveSession(arg);
    if (!s) return;
    const managed = sessions.findBySessionId(s.sessionId);
    if (managed) {
      await panels.openInClaudeExtension(managed);
      return;
    }
    await handoff.openInClaudeExtension(s.cwd, s.sessionId);
  };

  /** Sessions running outside this window: focus where they run, or open a copy here. */
  const openExternal = async (v: LiveSessionView) => {
    if (v.source === 'vscode' && v.sessionId) {
      await handoff.openInClaudeExtension(v.cwd, v.sessionId);
      return;
    }
    const where = SESSION_SOURCE_LABELS[v.source].toLowerCase();
    const choice = await vscode.window.showInformationMessage(
      `“${v.title}” is running in ${v.source === 'terminal' ? 'a terminal' : `the ${where}`}. Answer it there, or open its history here.`,
      ...(v.sessionId ? ['Open History Here', 'Open in Claude Extension'] : []),
    );
    if (!v.sessionId) return;
    if (choice === 'Open History Here') await panels.openExisting(v.sessionId, v.cwd, v.title);
    else if (choice === 'Open in Claude Extension') await handoff.openInClaudeExtension(v.cwd, v.sessionId);
  };

  const newSessionAt = async (path: string, mode: 'here' | 'claudeExtension') => {
    if (!existsSync(path)) throw new Error(`Folder not found: ${path}`);
    const project = store.findContaining(path);
    if (project) store.select(project.id, path);
    if (mode === 'claudeExtension') await handoff.openInClaudeExtension(path);
    else await panels.newSession(path);
  };

  const disposable = vscode.Disposable.from(
    reg('claudeProjects.addProject', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add Project' });
      if (!uris?.length) return;
      const added = await store.addMany(uris.map((u) => u.fsPath));
      if (added.length) store.select(added[0].id);
      else void vscode.window.showInformationMessage('Those folders are already in your projects.');
    }),

    reg('claudeProjects.importProjects', async () => {
      if (!index.isReady) await index.scanAll();
      const tmp = [realPath(tmpdir()), '/private/tmp', '/tmp', '/private/var/folders', d.utilityDir];
      const rows = index
        .allCwds()
        .filter((c) => existsSync(c.cwd) && statSync(c.cwd).isDirectory())
        .filter((c) => !tmp.some((t) => isSameOrInside(c.cwd, t)))
        .filter((c) => !store.findContaining(c.cwd) || store.findContaining(c.cwd)!.path !== c.cwd)
        .sort((a, b) => b.lastModified - a.lastModified);
      if (!rows.length) {
        void vscode.window.showInformationMessage('No other folders with Claude Code sessions were found.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        rows.map((r) => ({
          label: folderName(r.cwd),
          description: tildify(r.cwd),
          detail: `${r.count} session${r.count === 1 ? '' : 's'} · last used ${shortAgo(r.lastModified)}${store.findContaining(r.cwd) ? ' · inside an existing project' : ''}`,
          cwd: r.cwd,
        })),
        { canPickMany: true, placeHolder: 'Folders where you used Claude Code. Pick the ones to add as projects.', matchOnDescription: true },
      );
      if (!picks?.length) return;
      const added = await store.addMany(picks.map((p) => p.cwd));
      void vscode.window.showInformationMessage(`Added ${added.length} project${added.length === 1 ? '' : 's'}.`);
    }),

    reg('claudeProjects.removeProject', async (node?: ProjectsNode) => {
      const id = node?.projectId ?? store.selection?.projectId;
      const project = id ? store.get(id) : undefined;
      if (!project) return;
      await store.remove(project.id);
      const undo = await vscode.window.showInformationMessage(`Removed “${project.name}” from Projects. The folder was not touched.`, 'Undo');
      if (undo) await store.add(project.path, project.name);
    }),

    reg('claudeProjects.renameProject', async (node?: ProjectsNode) => {
      const id = node?.projectId ?? store.selection?.projectId;
      const project = id ? store.get(id) : undefined;
      if (!project) return;
      const name = await vscode.window.showInputBox({ prompt: 'Project name', value: project.name, valueSelection: [0, project.name.length] });
      if (name?.trim()) await store.rename(project.id, name);
    }),

    reg('claudeProjects.refresh', async () => {
      store.reload();
      tree.refresh();
      await index.scanAll();
    }),

    reg('claudeProjects.selectProject', (node?: ProjectsNode | { projectId: string; path?: string }) => {
      if (!node) return;
      store.select(node.projectId, 'path' in node ? node.path : undefined);
    }),

    reg('claudeProjects.newSession', async (arg?: unknown) => {
      const path = targetPath(arg) ?? (await pickFolder('Start a new Claude session in…'));
      if (path) await newSessionAt(path, openMode());
    }),

    reg('claudeProjects.newSessionInClaudeExtension', async (arg?: unknown) => {
      const path = targetPath(arg) ?? (await pickFolder('Start a new session in the Claude extension in…'));
      if (path) await newSessionAt(path, 'claudeExtension');
    }),

    reg('claudeProjects.openSession', async (arg?: SessionArg) => {
      const s = resolveSession(arg);
      if (!s) return;
      const project = store.findContaining(s.cwd);
      if (project) store.select(project.id, (arg as SessionNode | undefined)?.parentPath ?? s.cwd);
      // Sessions already running in this window always open here.
      if (sessions.findBySessionId(s.sessionId) || openMode() === 'here') {
        const live = attention.bySessionId(s.sessionId);
        if (live && !live.managed && live.source === 'vscode') {
          await openExternal(live);
          return;
        }
        await openHere(arg);
      } else await openInClaudeExtension(arg);
    }),

    reg('claudeProjects.openSessionHere', openHere),
    reg('claudeProjects.openSessionInClaudeExtension', openInClaudeExtension),

    reg('claudeProjects.stopSession', async (arg?: SessionArg) => {
      const s = resolveSession(arg);
      const managed = s ? sessions.findBySessionId(s.sessionId) : undefined;
      if (!managed) return;
      if (managed.status === 'running' || managed.status === 'waiting') await managed.interrupt();
      await managed.stopProcess();
    }),

    reg('claudeProjects.renameSession', async (arg?: SessionArg) => {
      const s = resolveSession(arg);
      if (!s) return;
      const managed = sessions.findBySessionId(s.sessionId);
      const current = managed?.title ?? index.get(s.sessionId)?.title ?? s.title ?? '';
      const title = (await vscode.window.showInputBox({ prompt: 'Session name', value: current, valueSelection: [0, current.length] }))?.trim();
      if (!title) return;
      const path = index.get(s.sessionId)?.filePath ?? transcriptPathFor(s.cwd, s.sessionId);
      if (!existsSync(path)) {
        managed?.setTitle(title, true);
        return;
      }
      // Same record Claude Code writes for /rename.
      await appendFile(path, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: s.sessionId }) + '\n');
      managed?.setTitle(title, true);
      index.touch(path);
    }),

    reg('claudeProjects.copySessionId', async (arg?: SessionArg) => {
      const s = resolveSession(arg);
      if (s) await vscode.env.clipboard.writeText(s.sessionId);
    }),

    reg('claudeProjects.revealTranscript', async (arg?: SessionArg) => {
      const s = resolveSession(arg);
      if (!s) return;
      const path = index.get(s.sessionId)?.filePath ?? transcriptPathFor(s.cwd, s.sessionId);
      if (existsSync(path)) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
      else void vscode.window.showInformationMessage('This session has no transcript yet.');
    }),

    reg('claudeProjects.showBookmarks', async () => {
      const all = sessions.bookmarkStore.all();
      const items: (vscode.QuickPickItem & { sessionId?: string; cwd?: string; itemId?: string })[] = [];
      for (const [sessionId, list] of Object.entries(all)) {
        const info = index.get(sessionId);
        const managed = sessions.findBySessionId(sessionId);
        const cwd = managed?.cwd ?? info?.cwd;
        if (!cwd || !list.length) continue;
        const project = store.findContaining(cwd);
        const title = managed?.title ?? info?.title ?? 'Session';
        items.push({ label: `${project?.name ?? folderName(cwd)} · ${title}`, kind: vscode.QuickPickItemKind.Separator });
        for (const b of list) {
          items.push({
            label: `$(${b.kind === 'user' ? 'account' : b.kind === 'tool' ? 'tools' : 'sparkle'}) ${b.label}`,
            description: shortAgo(b.createdAt),
            sessionId,
            cwd,
            itemId: b.itemId,
          });
        }
      }
      if (!items.length) {
        void vscode.window.showInformationMessage('No bookmarks yet. Hover a message in a chat and click the bookmark icon.');
        return;
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Bookmarked messages', matchOnDescription: true });
      if (pick?.sessionId && pick.cwd && pick.itemId) await panels.revealItem(pick.sessionId, pick.cwd, pick.itemId);
    }),

    reg('claudeProjects.showMoreSessions', (node: MoreNode) => tree.showMore(node)),
    reg('claudeProjects.openDashboard', () => dashboard.show()),
    reg('claudeProjects.refreshUsage', () => usage.refresh(true)),

    reg('claudeProjects.focusNextAttention', async () => {
      const next = attention.sessions.find((v) => v.attention === 'needs-input') ?? attention.sessions.find((v) => v.attention === 'error' || v.attention === 'done');
      if (!next) {
        void vscode.window.showInformationMessage('No session is waiting for you.');
        return;
      }
      if (next.managed) panels.reveal(next.key);
      else await openExternal(next);
    }),
  );
  return { disposable, openExternal };
}

export type OpenExternal = (v: LiveSessionView) => Promise<void>;
