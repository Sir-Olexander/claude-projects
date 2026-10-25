/** A folder the user registered in the Projects view. Only the path is stored; nothing is moved. */
export interface Project {
  id: string;
  /** Display name (defaults to the folder name). */
  name: string;
  /** Absolute path of the project folder (usually the main git worktree). */
  path: string;
  addedAt: number;
}

/** What the per-project views (Source Control, Files) currently show. */
export interface ProjectSelection {
  projectId: string;
  /** The project path itself or one of its worktree paths. */
  path: string;
}

/** A git worktree (from `git worktree list --porcelain`). */
export interface Worktree {
  path: string;
  /** Short branch name, e.g. "main". Undefined when detached or bare. */
  branch?: string;
  head?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  /** True for the repository's main worktree (the first entry). */
  isMain: boolean;
}

/** Arguments our tree items pass to shared commands. */
export interface PathArg {
  path: string;
  projectId?: string;
}
