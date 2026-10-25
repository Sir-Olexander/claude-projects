import type { ToolItem } from '../../../shared/protocol';
import { basename, displayPath } from './paths';

export interface McpName {
  server: string;
  tool: string;
}

/** mcp__server__tool → { server, tool } */
export function parseMcpName(name: string): McpName | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return undefined;
  return { server: m[1].replace(/^plugin_[^_]+_/, '').replace(/_/g, '-'), tool: m[2] };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function firstLine(s: string, max = 160): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Best-effort read of a string field from partial JSON while the model is still
 * writing the tool input, e.g. '{"command":"npm te' → "npm te".
 */
export function partialField(partial: string | undefined, field: string): string | undefined {
  if (!partial) return undefined;
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`);
  const m = re.exec(partial);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1].replace(/\\$/, '')}"`) as string;
  } catch {
    return m[1];
  }
}

/** Reads a field from the parsed input or, while streaming, from the partial JSON. */
export function field(item: Pick<ToolItem, 'input' | 'partialInput'>, name: string): string | undefined {
  return str(item.input?.[name]) ?? partialField(item.partialInput, name);
}

export interface ToolLabel {
  /** Bold name, e.g. "Bash", "Read", "playwright › navigate". */
  name: string;
  /** One-line summary after the name. */
  summary?: string;
  /** Render summary in monospace (commands, paths, patterns). */
  mono?: boolean;
  /** When set, the summary is a clickable file. */
  filePath?: string;
  line?: number;
  /** Extra muted text after the summary, e.g. "lines 10–50" or "+3 −1". */
  hint?: string;
}

const NICE_NAMES: Record<string, string> = {
  Task: 'Agent',
  BashOutput: 'Bash output',
  KillShell: 'Stop shell',
  KillBash: 'Stop shell',
  TodoWrite: 'Update Todos',
  ExitPlanMode: 'Plan',
  EnterPlanMode: 'Plan mode',
  AskUserQuestion: 'Question',
  NotebookEdit: 'Edit notebook',
  WebFetch: 'Fetch',
  WebSearch: 'Web search',
  ToolSearch: 'Load tools',
  ListMcpResourcesTool: 'List MCP resources',
  ReadMcpResourceTool: 'Read MCP resource',
};

export function toolLabel(item: Pick<ToolItem, 'name' | 'input' | 'partialInput'>, cwd: string): ToolLabel {
  const name = item.name;
  const input = item.input ?? {};
  const path = field(item, 'file_path') ?? field(item, 'notebook_path') ?? field(item, 'path');

  switch (name) {
    case 'Bash': {
      const cmd = field(item, 'command');
      return { name: 'Bash', summary: cmd ? firstLine(cmd, 200) : undefined, mono: true, hint: input.run_in_background ? 'background' : undefined };
    }
    case 'BashOutput':
    case 'TaskOutput':
      return { name: NICE_NAMES[name] ?? name, summary: field(item, 'bash_id') ?? field(item, 'task_id') ?? field(item, 'shell_id'), mono: true };
    case 'KillShell':
    case 'KillBash':
      return { name: NICE_NAMES[name], summary: field(item, 'shell_id') ?? field(item, 'bash_id'), mono: true };
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      let hint: string | undefined;
      if (offset !== undefined && limit !== undefined) hint = `lines ${offset}–${offset + limit - 1}`;
      else if (offset !== undefined) hint = `from line ${offset}`;
      else if (limit !== undefined) hint = `first ${limit} lines`;
      return { name: 'Read', summary: path ? displayPath(path, cwd) : undefined, mono: true, filePath: path, line: offset, hint };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { name: name === 'NotebookEdit' ? 'Edit notebook' : name, summary: path ? displayPath(path, cwd) : undefined, mono: true, filePath: path };
    case 'Grep': {
      const pattern = field(item, 'pattern');
      const where = field(item, 'path') ?? field(item, 'glob') ?? field(item, 'type');
      return { name: 'Grep', summary: pattern ? `"${pattern}"` : undefined, mono: true, hint: where ? `in ${displayPath(where, cwd)}` : undefined };
    }
    case 'Glob': {
      const pattern = field(item, 'pattern');
      const where = field(item, 'path');
      return { name: 'Glob', summary: pattern, mono: true, hint: where ? `in ${displayPath(where, cwd)}` : undefined };
    }
    case 'LS':
      return { name: 'List', summary: path ? displayPath(path, cwd) : undefined, mono: true, filePath: undefined };
    case 'WebFetch': {
      const url = field(item, 'url');
      let short = url;
      try {
        if (url) {
          const u = new URL(url);
          short = u.host + (u.pathname !== '/' ? u.pathname : '');
        }
      } catch {
        // keep raw
      }
      return { name: 'Fetch', summary: short, mono: true };
    }
    case 'WebSearch':
      return { name: 'Web search', summary: field(item, 'query') ? `"${field(item, 'query')}"` : undefined };
    case 'Task':
    case 'Agent': {
      const desc = field(item, 'description');
      const type = field(item, 'subagent_type');
      return { name: 'Agent', summary: desc, hint: type && type !== 'general-purpose' ? type : undefined };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as { status?: string }[]) : [];
      const done = todos.filter((t) => t.status === 'completed').length;
      return { name: 'Update Todos', summary: todos.length ? `${done}/${todos.length} done` : undefined };
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as { question?: string }[]) : [];
      return { name: 'Question', summary: qs[0]?.question ? firstLine(qs[0].question) : undefined, hint: qs.length > 1 ? `+${qs.length - 1} more` : undefined };
    }
    case 'ExitPlanMode':
      return { name: 'Plan', summary: 'Ready for review' };
    case 'EnterPlanMode':
      return { name: 'Plan mode', summary: 'Entering plan mode' };
    case 'ToolSearch': {
      const q = field(item, 'query');
      if (q?.startsWith('select:')) {
        const names = q
          .slice('select:'.length)
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
          .map((n) => {
            const mcp = parseMcpName(n);
            return mcp ? `${mcp.server} › ${mcp.tool}` : n;
          });
        return { name: 'Load tools', summary: names.join(', '), mono: true };
      }
      return { name: 'Load tools', summary: q, mono: true };
    }
    case 'Skill':
      return { name: 'Skill', summary: field(item, 'skill') ?? field(item, 'command'), mono: true };
    case 'SlashCommand':
      return { name: 'Command', summary: field(item, 'command'), mono: true };
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
      return { name: NICE_NAMES[name], summary: field(item, 'server') ?? field(item, 'uri'), mono: true };
  }

  const mcp = parseMcpName(name);
  if (mcp) {
    return { name: `${mcp.server} › ${mcp.tool}`, summary: firstStringArg(input), mono: true };
  }
  return { name: NICE_NAMES[name] ?? name, summary: firstStringArg(input), mono: true };
}

function firstStringArg(input: Record<string, unknown>): string | undefined {
  for (const v of Object.values(input ?? {})) {
    if (typeof v === 'string' && v.trim()) return firstLine(v, 120);
  }
  return undefined;
}

/** Verb phrase for permission prompts: "run this command", "edit app.ts", "use playwright › navigate". */
export function permissionTitle(toolName: string, input: Record<string, unknown>, displayName?: string, cwd = ''): string {
  const file = str(input.file_path) ?? str(input.notebook_path);
  switch (toolName) {
    case 'Bash':
      return 'Allow Claude to run this command?';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `Allow Claude to edit ${basename(file)}?` : 'Allow Claude to edit this file?';
    case 'Write':
      return file ? `Allow Claude to write ${basename(file)}?` : 'Allow Claude to write this file?';
    case 'Read':
      return file ? `Allow Claude to read ${basename(file)}?` : 'Allow Claude to read this file?';
    case 'Grep':
    case 'Glob':
    case 'LS': {
      const p = str(input.path);
      return p ? `Allow Claude to search ${displayPath(p, cwd)}?` : 'Allow Claude to search these files?';
    }
    case 'WebFetch': {
      const url = str(input.url);
      try {
        if (url) return `Allow Claude to fetch ${new URL(url).host}?`;
      } catch {
        // fall through
      }
      return 'Allow Claude to fetch this page?';
    }
    case 'WebSearch':
      return 'Allow Claude to search the web?';
    case 'Task':
    case 'Agent':
      return 'Allow Claude to start an agent?';
    case 'Skill':
      return `Allow Claude to use the ${str(input.skill) ?? str(input.command) ?? ''} skill?`.replace('  ', ' ');
  }
  const mcp = parseMcpName(toolName);
  if (mcp) return `Allow Claude to use ${mcp.server} › ${mcp.tool}?`;
  return `Allow Claude to use ${displayName || toolName}?`;
}

/** Tools that are shown expanded by default. */
export function defaultExpanded(item: ToolItem): boolean {
  switch (item.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return item.status !== 'denied' && item.status !== 'error';
    case 'TodoWrite':
    case 'ExitPlanMode':
    case 'AskUserQuestion':
      return true;
    default:
      return false;
  }
}

/** Gerunds for the running indicator, like the terminal spinner. */
export const SPINNER_WORDS = [
  'Thinking', 'Pondering', 'Cogitating', 'Musing', 'Ruminating', 'Deliberating', 'Considering', 'Noodling',
  'Percolating', 'Mulling', 'Brewing', 'Crafting', 'Computing', 'Synthesizing', 'Working', 'Conjuring',
  'Simmering', 'Tinkering', 'Puzzling', 'Wrangling', 'Forging', 'Hatching', 'Finagling', 'Marinating',
];
