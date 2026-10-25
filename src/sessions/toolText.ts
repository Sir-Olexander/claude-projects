import { basename, isAbsolute, relative } from 'node:path';

/** Short, human description of a tool call: "Running npm test", "Editing app.ts", … */
export function describeToolActivity(name: string, input: Record<string, unknown> | undefined, cwd?: string): string {
  const i = input ?? {};
  const file = (k = 'file_path') => shortPath(String(i[k] ?? ''), cwd);
  switch (name) {
    case 'Bash':
      return i.command ? `Running ${clip(String(i.command), 60)}` : 'Running a command';
    case 'BashOutput':
      return 'Checking command output';
    case 'KillShell':
    case 'KillBash':
      return 'Stopping a background command';
    case 'Read':
      return i.file_path ? `Reading ${file()}` : 'Reading';
    case 'Edit':
    case 'MultiEdit':
      return i.file_path ? `Editing ${file()}` : 'Editing';
    case 'Write':
      return i.file_path ? `Writing ${file()}` : 'Writing a file';
    case 'NotebookEdit':
      return i.notebook_path ? `Editing ${file('notebook_path')}` : 'Editing a notebook';
    case 'Grep':
      return i.pattern ? `Searching for ${clip(String(i.pattern), 40)}` : 'Searching';
    case 'Glob':
      return i.pattern ? `Finding ${clip(String(i.pattern), 40)}` : 'Finding files';
    case 'WebFetch':
      return i.url ? `Fetching ${hostOf(String(i.url))}` : 'Fetching a page';
    case 'WebSearch':
      return i.query ? `Searching the web for ${clip(String(i.query), 40)}` : 'Searching the web';
    case 'Task':
    case 'Agent':
      return i.description ? `Agent: ${clip(String(i.description), 50)}` : 'Running an agent';
    case 'TodoWrite':
      return 'Updating the todo list';
    case 'AskUserQuestion':
      return 'Asking you a question';
    case 'ExitPlanMode':
      return 'Presenting a plan';
    case 'ToolSearch':
      return 'Loading tools';
    case 'Skill':
      return i.skill ? `Using skill ${String(i.skill)}` : 'Using a skill';
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `${server ?? 'MCP'}: ${tool ?? name}`;
      }
      return `Using ${name}`;
  }
}

/** One-line detail for permission prompts/dashboard: the command, the file, the URL… */
export function describeToolTarget(name: string, input: Record<string, unknown> | undefined, cwd?: string): string | undefined {
  const i = input ?? {};
  switch (name) {
    case 'Bash':
      return i.command ? clip(String(i.command), 140) : undefined;
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return i.file_path ? shortPath(String(i.file_path), cwd) : undefined;
    case 'NotebookEdit':
      return i.notebook_path ? shortPath(String(i.notebook_path), cwd) : undefined;
    case 'WebFetch':
      return i.url ? String(i.url) : undefined;
    case 'WebSearch':
      return i.query ? String(i.query) : undefined;
    case 'Grep':
    case 'Glob':
      return i.pattern ? String(i.pattern) : undefined;
    case 'Task':
    case 'Agent':
      return i.description ? String(i.description) : undefined;
    default:
      return undefined;
  }
}

export function shortPath(p: string, cwd?: string): string {
  if (!p) return p;
  if (cwd && isAbsolute(p)) {
    const rel = relative(cwd, p);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return basename(p) === p ? p : p.length > 60 ? '…/' + basename(p) : p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 40);
  }
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-5-5[1m]" → "Sonnet 5.5 (1M)". */
export function prettyModelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/i.exec(model);
  if (!m) return model;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
  return `${family} ${version}${m[4] ? ' (1M)' : ''}`;
}
