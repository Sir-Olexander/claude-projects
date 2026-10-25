import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { SessionIndex } from '../claude/SessionIndex';
import type { SessionInfo } from '../claude/sessionInfo';
import { getCurrentBranch, listWorktrees } from '../git/gitCli';
import type { AttentionService } from '../sessions/AttentionService';
import type { ManagedSession } from '../sessions/ManagedSession';
import type { SessionManager } from '../sessions/SessionManager';
import type { AttentionState, LiveSessionView } from '../shared/protocol';
import { SESSION_SOURCE_LABELS } from '../shared/protocol';
import type { Project, Worktree } from '../shared/types';
import { debounce } from '../util/events';
import { folderName, isSameOrInside, tildify } from '../util/paths';
import { longAgo, shortAgo } from '../util/time';
import type { ProjectStore } from './ProjectStore';

export type ProjectsNode = ProjectNode | WorktreeNode | SessionNode | MoreNode | InfoNode;

export interface ProjectNode {
  kind: 'project';
  project: Project;
  projectId: string;
  path: string;
}

export interface WorktreeNode {
  kind: 'worktree';
  project: Project;
  projectId: string;
  worktree: Worktree;
  path: string;
}

export interface SessionNode {
  kind: 'session';
  projectId: string;
  /** Folder the session runs in. */
  cwd: string;
  sessionId: string;
  title: string;
  info?: SessionInfo;
  managedKey?: string;
  /** Path of the node this session is listed under (project or worktree). */
  parentPath: string;
}

export interface MoreNode {
  kind: 'more';
  projectId: string;
  parentPath: string;
  remaining: number;
}

export interface InfoNode {
  kind: 'info';
  projectId: string;
  parentPath: string;
  label: string;
  icon?: string;
}

interface GitCache {
  at: number;
  branch?: string;
  worktrees: Worktree[];
}

const GIT_TTL_MS = 20_000;
const RANK: Record<AttentionState, number> = { 'needs-input': 0, error: 1, done: 2, running: 3, idle: 4 };

/**
 * The Projects view: projects → (worktrees, sessions). Clicking a project or
 * worktree selects it for the Source Control and Files views; clicking a
 * session opens it.
 */
export class ProjectsTreeProvider implements vscode.TreeDataProvider<ProjectsNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ProjectsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly git = new Map<string, GitCache>();
  private readonly gitLoading = new Map<string, Promise<void>>();
  private readonly limits = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly refreshSoon = debounce(() => this._onDidChangeTreeData.fire(undefined), 150);

  constructor(
    private readonly store: ProjectStore,
    private readonly index: SessionIndex,
    private readonly sessions: SessionManager,
    private readonly attention: AttentionService,
  ) {
    this.disposables.push(
      store.onDidChangeProjects(() => this.refreshSoon()),
      store.onDidChangeSelection(() => this.refreshSoon()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeProjects.sessions') && this.refreshSoon()),
    );
    this.disposables.push({ dispose: index.onDidChange(() => this.refreshSoon()).dispose });
    this.disposables.push({ dispose: attention.onDidChange(() => this.refreshSoon()).dispose });
    this.disposables.push({ dispose: sessions.onDidChange(() => this.refreshSoon()).dispose });
  }

  /** Re-read git info (branches, worktrees) and redraw. */
  refresh(): void {
    this.git.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  showMore(node: MoreNode): void {
    const max = this.maxPerGroup();
    this.limits.set(node.parentPath, (this.limits.get(node.parentPath) ?? max) + max * 3);
    this._onDidChangeTreeData.fire(undefined);
  }

  private maxPerGroup(): number {
    return Math.max(1, vscode.workspace.getConfiguration('claudeProjects').get<number>('sessions.maxPerProject', 8));
  }

  // --- git info (cached; loading triggers a redraw) ---------------------------------

  private gitInfo(path: string): GitCache | undefined {
    const c = this.git.get(path);
    if (!c || Date.now() - c.at > GIT_TTL_MS) this.loadGit(path);
    return c;
  }

  private loadGit(path: string): void {
    if (this.gitLoading.has(path)) return;
    const p = (async () => {
      const [branch, worktrees] = await Promise.all([getCurrentBranch(path).catch(() => undefined), listWorktrees(path).catch(() => [])]);
      const prev = this.git.get(path);
      this.git.set(path, { at: Date.now(), branch, worktrees });
      if (!prev || prev.branch !== branch || JSON.stringify(prev.worktrees) !== JSON.stringify(worktrees)) this.refreshSoon();
    })().finally(() => this.gitLoading.delete(path));
    this.gitLoading.set(path, p);
  }

  // --- TreeDataProvider ---------------------------------------------------------------

  getChildren(node?: ProjectsNode): ProjectsNode[] {
    if (!node) {
      return this.store.projects.map((project) => ({ kind: 'project', project, projectId: project.id, path: project.path }));
    }
    if (node.kind === 'project') {
      if (!existsSync(node.project.path)) return [{ kind: 'info', projectId: node.projectId, parentPath: node.path, label: `Folder not found: ${tildify(node.project.path)}`, icon: 'warning' }];
      const worktrees = this.linkedWorktrees(node.project);
      const wtNodes: WorktreeNode[] = worktrees.map((w) => ({ kind: 'worktree', project: node.project, projectId: node.projectId, worktree: w, path: w.path }));
      const excluded = worktrees.map((w) => w.path);
      return [...wtNodes, ...this.sessionNodes(node.project, node.path, excluded)];
    }
    if (node.kind === 'worktree') {
      return this.sessionNodes(node.project, node.path, []);
    }
    return [];
  }

  getParent(node: ProjectsNode): ProjectsNode | undefined {
    if (node.kind === 'project') return undefined;
    const project = this.store.get(node.projectId);
    if (!project) return undefined;
    const projectNode: ProjectNode = { kind: 'project', project, projectId: project.id, path: project.path };
    if (node.kind === 'worktree') return projectNode;
    const parentPath = node.parentPath;
    if (parentPath === project.path) return projectNode;
    const w = this.linkedWorktrees(project).find((x) => x.path === parentPath);
    return w ? { kind: 'worktree', project, projectId: project.id, worktree: w, path: w.path } : projectNode;
  }

  private linkedWorktrees(project: Project): Worktree[] {
    const info = this.gitInfo(project.path);
    return (info?.worktrees ?? []).filter((w) => w.path !== project.path && !w.bare && !(w.prunable && !existsSync(w.path)));
  }

  /** Sessions run in `root` or below it (minus folders listed separately), live/attention first, then newest. */
  private sessionNodes(project: Project, root: string, excluded: string[]): ProjectsNode[] {
    const rows = new Map<string, SessionNode>();
    const add = (sessionId: string, cwd: string, title: string, info?: SessionInfo, managed?: ManagedSession) => {
      const prev = rows.get(sessionId);
      rows.set(sessionId, { kind: 'session', projectId: project.id, cwd, sessionId, title, info: info ?? prev?.info, managedKey: managed?.key ?? prev?.managedKey, parentPath: root });
    };
    for (const { cwd } of this.index.allCwds()) {
      if (!isSameOrInside(cwd, root) || excluded.some((e) => isSameOrInside(cwd, e))) continue;
      for (const info of this.index.sessionsFor(cwd)) add(info.sessionId, cwd, info.title, info);
    }
    // Sessions opened here that have no transcript yet (new) or fresher titles.
    for (const s of this.sessions.all) {
      if (!isSameOrInside(s.cwd, root) || excluded.some((e) => isSameOrInside(s.cwd, e))) continue;
      if (s.isNew && !s.processAlive && s.visibleCount === 0) continue;
      add(s.sessionId, s.cwd, s.title, undefined, s);
    }
    const list = [...rows.values()];
    const live = (n: SessionNode) => this.attention.bySessionId(n.sessionId);
    // Opening an old session to read it must not make it jump to the top; only real activity counts.
    const lastActive = (n: SessionNode) => {
      const managed = n.managedKey ? this.sessions.get(n.managedKey) : undefined;
      return Math.max(n.info?.lastModified ?? 0, live(n)?.since ?? 0, managed?.processAlive ? managed.lastActivityAt : 0);
    };
    list.sort((a, b) => {
      const la = live(a);
      const lb = live(b);
      const ra = la ? RANK[la.attention] : 9;
      const rb = lb ? RANK[lb.attention] : 9;
      return ra - rb || lastActive(b) - lastActive(a);
    });
    const limit = this.limits.get(root) ?? this.maxPerGroup();
    // Always show live sessions even beyond the limit.
    const shown = list.filter((n, i) => i < limit || !!live(n));
    const out: ProjectsNode[] = [...shown];
    if (list.length > shown.length) out.push({ kind: 'more', projectId: project.id, parentPath: root, remaining: list.length - shown.length });
    if (list.length === 0 && excluded.length === 0) out.push({ kind: 'info', projectId: project.id, parentPath: root, label: 'No sessions yet', icon: 'comment' });
    return out;
  }

  getTreeItem(node: ProjectsNode): vscode.TreeItem {
    switch (node.kind) {
      case 'project':
        return this.projectItem(node);
      case 'worktree':
        return this.worktreeItem(node);
      case 'session':
        return this.sessionItem(node);
      case 'more': {
        const item = new vscode.TreeItem(`Show ${node.remaining} more…`, vscode.TreeItemCollapsibleState.None);
        item.id = `more:${node.parentPath}`;
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.command = { command: 'claudeProjects.showMoreSessions', title: 'Show more', arguments: [node] };
        item.contextValue = 'more';
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `info:${node.parentPath}:${node.label}`;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info', new vscode.ThemeColor('descriptionForeground'));
        item.contextValue = 'info';
        return item;
      }
    }
  }

  private attentionUnder(path: string, excluded: string[] = []): { needs: number; done: number; running: number } {
    let needs = 0;
    let done = 0;
    let running = 0;
    for (const v of this.attention.sessions) {
      if (!isSameOrInside(v.cwd, path) || excluded.some((e) => isSameOrInside(v.cwd, e))) continue;
      if (v.attention === 'needs-input' || v.attention === 'error') needs++;
      else if (v.attention === 'done') done++;
      else if (v.attention === 'running') running++;
    }
    return { needs, done, running };
  }

  private attentionText(att: { needs: number; done: number; running: number }): string | undefined {
    if (att.needs) return `● ${att.needs} waiting`;
    if (att.done) return `${att.done} finished`;
    if (att.running) return `${att.running} running`;
    return undefined;
  }

  private projectItem(node: ProjectNode): vscode.TreeItem {
    const { project } = node;
    const selected = this.store.selection?.projectId === project.id && this.store.selection.path === project.path;
    const git = this.gitInfo(project.path);
    const exists = existsSync(project.path);
    const att = this.attentionUnder(project.path);
    const item = new vscode.TreeItem(project.name, selected || att.needs + att.done > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `project:${project.id}`;
    const parts: string[] = [];
    if (git?.branch) parts.push(git.branch);
    const attText = this.attentionText(att);
    if (attText) parts.push(attText);
    item.description = parts.join(' · ');
    item.iconPath = !exists
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : att.needs
        ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'))
        : new vscode.ThemeIcon(selected ? 'folder-opened' : 'folder', selected ? new vscode.ThemeColor('focusBorder') : undefined);
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${escapeMd(project.name)}**\n\n${escapeMd(tildify(project.path))}`);
    if (git?.branch) tip.appendMarkdown(`\n\n$(git-branch) ${escapeMd(git.branch)}`);
    if (!exists) tip.appendMarkdown('\n\n$(warning) This folder no longer exists.');
    tip.supportThemeIcons = true;
    item.tooltip = tip;
    item.contextValue = git?.worktrees.length ? 'project.git' : 'project';
    item.resourceUri = undefined;
    item.command = { command: 'claudeProjects.selectProject', title: 'Select', arguments: [node] };
    return item;
  }

  private worktreeItem(node: WorktreeNode): vscode.TreeItem {
    const w = node.worktree;
    const selected = this.store.selection?.path === w.path;
    const att = this.attentionUnder(w.path);
    const name = folderName(w.path);
    const item = new vscode.TreeItem(w.branch && w.branch !== name ? w.branch : name, selected || att.needs + att.done > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `worktree:${w.path}`;
    const parts: string[] = [];
    if (w.branch && w.branch !== name) parts.push(name);
    if (w.detached) parts.push(`detached ${w.head?.slice(0, 7) ?? ''}`.trim());
    const attText = this.attentionText(att);
    if (attText) parts.push(attText);
    item.description = parts.join(' · ');
    item.iconPath = att.needs ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange')) : new vscode.ThemeIcon('git-branch', selected ? new vscode.ThemeColor('focusBorder') : undefined);
    item.tooltip = new vscode.MarkdownString(`**Worktree** ${escapeMd(w.branch ?? name)}\n\n${escapeMd(tildify(w.path))}${w.locked ? '\n\nLocked' : ''}`);
    item.contextValue = 'worktree';
    item.command = { command: 'claudeProjects.selectProject', title: 'Select', arguments: [node] };
    return item;
  }

  private sessionItem(node: SessionNode): vscode.TreeItem {
    const live: LiveSessionView | undefined = this.attention.bySessionId(node.sessionId);
    const managed = node.managedKey ? this.sessions.get(node.managedKey) : this.sessions.findBySessionId(node.sessionId);
    const title = managed?.title ?? node.title;
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${node.sessionId}`;
    const when = live?.since ?? node.info?.lastModified;
    const desc: string[] = [];
    if (live) {
      const state =
        live.attention === 'needs-input'
          ? live.waitingFor ?? 'needs you'
          : live.attention === 'running'
            ? live.activity ?? 'running'
            : live.attention === 'done'
              ? 'finished'
              : live.attention === 'error'
                ? 'stopped'
                : 'open';
      desc.push(state);
      if (!live.managed) desc.push(SESSION_SOURCE_LABELS[live.source]);
    }
    if (when) desc.push(shortAgo(when));
    if (node.cwd !== node.parentPath) desc.push(`in ${relative(node.parentPath, node.cwd)}`);
    item.description = desc.join(' · ');
    item.iconPath = sessionIcon(live?.attention, !!managed?.processAlive);
    const tip = new vscode.MarkdownString(undefined, true);
    tip.supportThemeIcons = true;
    tip.appendMarkdown(`**${escapeMd(title)}**\n\n`);
    if (node.info?.firstPrompt && node.info.firstPrompt !== title) tip.appendMarkdown(`${escapeMd(node.info.firstPrompt)}\n\n`);
    if (live) tip.appendMarkdown(`$(circle-filled) ${escapeMd(live.waitingFor ?? live.activity ?? live.attention)}${live.managed ? '' : ` · ${SESSION_SOURCE_LABELS[live.source]}`}\n\n`);
    if (node.info?.gitBranch && node.info.gitBranch !== 'HEAD') tip.appendMarkdown(`$(git-branch) ${escapeMd(node.info.gitBranch)}  `);
    if (when) tip.appendMarkdown(`$(clock) ${longAgo(when)}\n\n`);
    tip.appendMarkdown(`\`${node.sessionId}\``);
    item.tooltip = tip;
    item.contextValue = `session${managed ? '.managed' : ''}${managed?.processAlive ? '.live' : ''}`;
    item.command = { command: 'claudeProjects.openSession', title: 'Open Session', arguments: [node] };
    return item;
  }

  dispose(): void {
    this.refreshSoon.cancel();
    for (const d of this.disposables) d.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

function sessionIcon(attention: AttentionState | undefined, alive: boolean): vscode.ThemeIcon {
  switch (attention) {
    case 'needs-input':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'));
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'done':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    case 'running':
      return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'));
    case 'idle':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(alive ? 'charts.blue' : 'descriptionForeground'));
    default:
      return new vscode.ThemeIcon('comment-discussion');
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
