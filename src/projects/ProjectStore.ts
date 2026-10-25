import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Project, ProjectSelection } from '../shared/types';
import { folderName, isSameOrInside, realPath, stripTrailingSep } from '../util/paths';

const PROJECTS_KEY = 'claudeProjects.projects.v1';
const SELECTION_KEY = 'claudeProjects.selection.v1';

/**
 * The user's project list (stored in global state, shared by all windows)
 * and the current selection (stored per window/workspace).
 */
export class ProjectStore implements vscode.Disposable {
  private readonly _onDidChangeProjects = new vscode.EventEmitter<void>();
  readonly onDidChangeProjects = this._onDidChangeProjects.event;

  private readonly _onDidChangeSelection = new vscode.EventEmitter<ProjectSelection | undefined>();
  /** Fires when the user picks another project or worktree. */
  readonly onDidChangeSelection = this._onDidChangeSelection.event;

  private _projects: Project[];
  private _selection: ProjectSelection | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._projects = this.read();
    this._selection = context.workspaceState.get<ProjectSelection>(SELECTION_KEY);
    if (this._selection && !this.get(this._selection.projectId)) this._selection = undefined;
    if (!this._selection && this._projects.length > 0) {
      this._selection = { projectId: this._projects[0].id, path: this._projects[0].path };
    }
  }

  dispose(): void {
    this._onDidChangeProjects.dispose();
    this._onDidChangeSelection.dispose();
  }

  private read(): Project[] {
    const raw = this.context.globalState.get<Project[]>(PROJECTS_KEY, []);
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.path === 'string' && typeof p.id === 'string') : [];
  }

  private async write(): Promise<void> {
    await this.context.globalState.update(PROJECTS_KEY, this._projects);
    this._onDidChangeProjects.fire();
  }

  /** Re-read from global state (another window may have changed the list). */
  reload(): void {
    const next = this.read();
    if (JSON.stringify(next) !== JSON.stringify(this._projects)) {
      this._projects = next;
      if (this._selection && !this.get(this._selection.projectId)) this.select(undefined);
      this._onDidChangeProjects.fire();
    }
  }

  get projects(): readonly Project[] {
    return this._projects;
  }

  get(id: string): Project | undefined {
    return this._projects.find((p) => p.id === id);
  }

  get selection(): ProjectSelection | undefined {
    return this._selection;
  }

  get selectedProject(): Project | undefined {
    return this._selection ? this.get(this._selection.projectId) : undefined;
  }

  /** Select a project, or one of its worktrees when `path` is given. */
  select(projectId: string | undefined, path?: string): void {
    let next: ProjectSelection | undefined;
    if (projectId) {
      const p = this.get(projectId);
      if (p) next = { projectId, path: stripTrailingSep(path ?? p.path) };
    }
    if (next?.projectId === this._selection?.projectId && next?.path === this._selection?.path) return;
    this._selection = next;
    void this.context.workspaceState.update(SELECTION_KEY, next);
    this._onDidChangeSelection.fire(next);
  }

  findByPath(path: string): Project | undefined {
    const real = realPath(path);
    return this._projects.find((p) => p.path === real || p.path === path);
  }

  /** Project whose folder contains `path` (deepest match). */
  findContaining(path: string): Project | undefined {
    const real = realPath(path);
    let best: Project | undefined;
    for (const p of this._projects) {
      if (isSameOrInside(real, p.path) && (!best || p.path.length > best.path.length)) best = p;
    }
    return best;
  }

  async add(path: string, name?: string): Promise<Project> {
    const real = stripTrailingSep(realPath(path));
    const existing = this.findByPath(real);
    if (existing) return existing;
    const project: Project = { id: randomUUID(), name: name?.trim() || folderName(real), path: real, addedAt: Date.now() };
    this._projects = [...this._projects, project].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    await this.write();
    if (!this._selection) this.select(project.id);
    return project;
  }

  async addMany(paths: string[]): Promise<Project[]> {
    const added: Project[] = [];
    for (const path of paths) {
      const real = stripTrailingSep(realPath(path));
      if (this.findByPath(real) || added.some((a) => a.path === real)) continue;
      added.push({ id: randomUUID(), name: folderName(real), path: real, addedAt: Date.now() });
    }
    if (added.length) {
      this._projects = [...this._projects, ...added].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      await this.write();
      if (!this._selection) this.select(added[0].id);
    }
    return added;
  }

  async remove(id: string): Promise<void> {
    this._projects = this._projects.filter((p) => p.id !== id);
    await this.write();
    if (this._selection?.projectId === id) {
      this.select(this._projects[0]?.id);
    }
  }

  async rename(id: string, name: string): Promise<void> {
    const p = this.get(id);
    if (!p || !name.trim()) return;
    this._projects = this._projects
      .map((x) => (x.id === id ? { ...x, name: name.trim() } : x))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    await this.write();
  }

  /** Whether the project folder still exists on disk. */
  exists(p: Project): boolean {
    return existsSync(p.path);
  }
}
