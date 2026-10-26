import { describe, expect, it } from 'vitest';
import { usageByReply } from '../../src/webview/chat/lib/usage';
import type { ChatItem } from '../../src/shared/protocol';

const user = (id: string, text: string, command?: string): ChatItem => ({ kind: 'user', id, text, command });
const text = (id: string, t: string): ChatItem => ({ kind: 'text', id, text: t });
const tool = (id: string, name: string, input: Record<string, unknown>, parentToolUseId?: string): ChatItem =>
  ({ kind: 'tool', id, name, input, status: 'done', parentToolUseId }) as ChatItem;

describe('skills and agents per reply', () => {
  const items: ChatItem[] = [
    user('u1', 'make a chart'),
    tool('s1', 'Skill', { skill: 'dataviz' }),
    text('r1', 'Here is the chart'),
    tool('a1', 'Agent', { subagent_type: 'Explore', description: 'Find the data files' }),
    tool('s2', 'Skill', { skill: 'pdf' }, 'a1'),
    text('r2', 'Found them'),
    user('u2', '/simplify', 'simplify'),
    text('r3', 'Simplified'),
    user('u3', 'thanks'),
    text('r4', 'You are welcome'),
  ];

  it('collects everything since the last prompt, up to each reply', () => {
    const m = usageByReply(items);
    expect(m.get('r1')).toEqual([{ kind: 'skill', label: 'dataviz', detail: undefined, itemId: 's1', status: 'done', nested: false }]);
    expect(m.get('r2')!.map((u) => [u.kind, u.label, u.itemId, !!u.nested])).toEqual([
      ['skill', 'dataviz', 's1', false],
      ['agent', 'Explore', 'a1', false],
      ['skill', 'pdf', 'a1', true], // used inside the agent: points at the agent's row
    ]);
    expect(m.get('r3')).toEqual([{ kind: 'skill', label: 'simplify', itemId: 'u2', byYou: true }]);
    expect(m.has('r4')).toBe(false);
  });

  it('reuses unchanged lists', () => {
    const first = usageByReply(items);
    const second = usageByReply(items, first);
    expect(second.get('r2')).toBe(first.get('r2'));
  });
});
