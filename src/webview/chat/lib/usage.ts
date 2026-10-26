import type { ChatItem, ToolStatus } from '../../../shared/protocol';

/** A skill or agent used while Claude worked on a prompt. */
export interface UsedEntry {
  kind: 'skill' | 'agent';
  /** Skill name, or the agent's type. */
  label: string;
  /** Skill arguments or the agent's task description. */
  detail?: string;
  /** Top-level item to scroll to (the tool row, or the subagent row it ran inside). */
  itemId: string;
  status?: ToolStatus;
  /** You ran it yourself as a slash command. */
  byYou?: boolean;
  /** Used inside an agent. */
  nested?: boolean;
}

const AGENT_TOOLS = new Set(['Task', 'Agent']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * For each top-level reply, the skills and agents used since the last prompt
 * you sent (up to that reply). Lists are reused when unchanged, so memoized
 * rows don't re-render.
 */
export function usageByReply(items: readonly ChatItem[], previous?: Map<string, UsedEntry[]>): Map<string, UsedEntry[]> {
  const parentOf = new Map<string, string>();
  for (const it of items) {
    const p = (it as { parentToolUseId?: string }).parentToolUseId;
    if (p) parentOf.set(it.id, p);
  }
  const rootOf = (id: string) => {
    let cur = id;
    for (let i = 0; i < 50 && parentOf.has(cur); i++) cur = parentOf.get(cur)!;
    return cur;
  };
  const out = new Map<string, UsedEntry[]>();
  let acc: UsedEntry[] = [];
  for (const it of items) {
    if (it.kind === 'user') {
      acc = [];
      if (it.command) acc.push({ kind: 'skill', label: it.command.replace(/^\//, ''), itemId: it.id, byYou: true });
    } else if (it.kind === 'tool') {
      const nested = !!it.parentToolUseId;
      if (it.name === 'Skill') {
        acc.push({ kind: 'skill', label: str(it.input.skill) ?? str(it.input.command) ?? 'skill', detail: str(it.input.args), itemId: rootOf(it.id), status: it.status, nested });
      } else if (AGENT_TOOLS.has(it.name)) {
        acc.push({ kind: 'agent', label: str(it.input.subagent_type) ?? 'general-purpose', detail: str(it.input.description), itemId: rootOf(it.id), status: it.status, nested });
      }
    } else if (it.kind === 'text' && !it.parentToolUseId && acc.length) {
      const list = acc.slice();
      const prev = previous?.get(it.id);
      out.set(it.id, prev && JSON.stringify(prev) === JSON.stringify(list) ? prev : list);
    }
  }
  return out;
}
