import { describe, expect, it } from 'vitest';
import { ChatBuilder } from '../../src/sessions/chatBuilder';
import type { AssistantTextItem, ToolItem, UserItem } from '../../src/shared/protocol';
import type { StreamEvent } from '../../src/claude/sdkTypes';

const ev = (e: StreamEvent) => e;

describe('ChatBuilder streaming', () => {
  it('streams text as deltas, then the final frame replaces it under the same id', () => {
    const b = new ChatBuilder();
    b.streamEvent(ev({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }), null);
    b.streamEvent(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), null);
    let ch = b.takeChanges();
    expect(ch.upserts.map((i) => i.id)).toEqual(['m1:0']);

    b.streamEvent(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }), null);
    b.streamEvent(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }), null);
    ch = b.takeChanges();
    expect(ch.upserts).toEqual([]);
    expect(ch.deltas).toEqual([{ id: 'm1:0', field: 'text', text: 'Hello' }]);

    b.addAssistant({ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }, null);
    ch = b.takeChanges();
    expect(ch.upserts).toHaveLength(1);
    expect((ch.upserts[0] as AssistantTextItem).text).toBe('Hello!');
    expect(b.items).toHaveLength(1);
  });

  it('does not double-send deltas for an item created in the same batch', () => {
    const b = new ChatBuilder();
    b.streamEvent(ev({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }), null);
    b.streamEvent(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), null);
    b.streamEvent(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abc' } }), null);
    const ch = b.takeChanges();
    expect((ch.upserts[0] as AssistantTextItem).text).toBe('abc');
    expect(ch.deltas).toEqual([]);
  });

  it('maps tool blocks by tool_use id and applies results', () => {
    const b = new ChatBuilder();
    b.streamEvent(ev({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }), null);
    b.streamEvent(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), null);
    b.streamEvent(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } }), null);
    b.streamEvent(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls' } }), null);
    expect(b.get<ToolItem>('toolu_1')).toMatchObject({ status: 'streaming', partialInput: '{"command":"ls' });

    b.addAssistant({ id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }, null);
    b.addAssistant({ id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }, null);
    expect(b.items.map((i) => i.id)).toEqual(['m1:0', 'toolu_1']);
    expect(b.get<ToolItem>('toolu_1')).toMatchObject({ status: 'pending', input: { command: 'ls' } });

    b.addUser({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt' }] }] }, { toolUseResult: { stdout: 'a.txt', interrupted: false } });
    expect(b.get<ToolItem>('toolu_1')).toMatchObject({ status: 'done', result: { text: 'a.txt', isError: false } });
  });

  it('nests subagent output under its parent tool', () => {
    const b = new ChatBuilder();
    b.addAssistant({ id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'task_1', name: 'Agent', input: { description: 'Explore' } }] }, null);
    b.addAssistant({ id: 'sub1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'Read', input: { file_path: '/a' } }] }, 'task_1');
    expect(b.get<ToolItem>('toolu_s')?.parentToolUseId).toBe('task_1');
  });

  it('moves a queued user message to the end when Claude picks it up', () => {
    const b = new ChatBuilder();
    b.upsert({ kind: 'user', id: 'q1', text: 'later', queued: true });
    b.addAssistant({ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'working' }] }, null);
    b.takeChanges();
    b.patch<UserItem>('q1', { queued: undefined });
    b.moveToEnd('q1');
    const ch = b.takeChanges();
    expect(ch.removed).toEqual(['q1']);
    expect(ch.upserts.map((i) => i.id)).toEqual(['q1']);
    expect(b.items.map((i) => i.id)).toEqual(['m1:0', 'q1']);
  });

  it('collapses repeated API retry notices', () => {
    const b = new ChatBuilder();
    b.addRetry('retry 1');
    b.addRetry('retry 2');
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: 'system', text: 'retry 2' });
  });

  it('externalizes images through the sink', () => {
    const seen: string[] = [];
    const b = new ChatBuilder((img) => {
      seen.push(img.mediaType);
      return { ...img, data: '', url: 'file:///cache/x.png' };
    });
    b.addUser({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'look' }] }, { uuid: 'u1' });
    expect(seen).toEqual(['image/png']);
    expect(b.get<UserItem>('u1')?.images?.[0]).toMatchObject({ url: 'file:///cache/x.png', data: '' });
  });

  it('keeps snapshots bounded and starts them at a user message', () => {
    const b = new ChatBuilder();
    for (let i = 0; i < 50; i++) {
      b.upsert({ kind: 'user', id: `u${i}`, text: `q${i}` });
      b.upsert({ kind: 'text', id: `a${i}`, text: `a${i}` });
    }
    const snap = b.snapshot(15);
    expect(snap.truncated).toBe(true);
    expect(snap.items[0].kind).toBe('user');
    expect(snap.items.length).toBeLessThanOrEqual(15);
  });
});

describe('ChatBuilder id mismatches', () => {
  it('reuses the streamed item when the final frame has another message id', () => {
    const b = new ChatBuilder();
    b.streamEvent({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }, null);
    b.streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, null);
    b.streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }, null);
    b.addAssistant({ id: 'other', role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }, null);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: 'text', text: 'Hi there', id: 'm1:0' });
  });
});
