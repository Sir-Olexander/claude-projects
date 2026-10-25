import { describe, expect, it } from 'vitest';
import { buildChat, mainChain, parseTranscript, type TranscriptEntry } from '../../src/claude/transcript';
import { firstPrompt, lastStringField, firstStringField, parseSessionInfo } from '../../src/claude/sessionInfo';
import { ChatBuilder } from '../../src/sessions/chatBuilder';
import type { ToolItem, UserItem } from '../../src/shared/protocol';

const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', uuid, parentUuid, message: { role: 'user', content }, cwd: '/repo', gitBranch: 'main', timestamp: '2026-10-01T10:00:00.000Z', ...extra }) as TranscriptEntry;
const assistant = (uuid: string, parentUuid: string | null, msgId: string, block: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', uuid, parentUuid, message: { id: msgId, role: 'assistant', content: [block] }, ...extra }) as TranscriptEntry;

describe('mainChain', () => {
  it('keeps parallel tool results that hang off side branches', () => {
    const entries = [
      user('u1', null, 'run two things'),
      assistant('a1', 'u1', 'm1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'a' } }),
      assistant('a2', 'a1', 'm1', { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'b' } }),
      user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 't1', content: 'A' }]),
      user('r2', 'a2', [{ type: 'tool_result', tool_use_id: 't2', content: 'B' }]),
      assistant('a3', 'r2', 'm2', { type: 'text', text: 'done' }),
    ];
    const chain = mainChain(entries);
    expect(chain.map((e) => e.uuid)).toEqual(['u1', 'a1', 'a2', 'r1', 'r2', 'a3']);
    const b = new ChatBuilder();
    buildChat(entries, b);
    const tools = b.items.filter((i): i is ToolItem => i.kind === 'tool');
    expect(tools.map((t) => [t.id, t.status, t.result?.text])).toEqual([
      ['t1', 'done', 'A'],
      ['t2', 'done', 'B'],
    ]);
  });

  it('drops branches abandoned by a rewind', () => {
    const entries = [
      user('u1', null, 'first'),
      assistant('a1', 'u1', 'm1', { type: 'text', text: 'reply 1' }),
      user('u2', 'a1', 'abandoned question'),
      assistant('a2', 'u2', 'm2', { type: 'text', text: 'abandoned reply' }),
      user('u3', 'a1', 'edited question'),
      assistant('a3', 'u3', 'm3', { type: 'text', text: 'final reply' }),
    ];
    const b = new ChatBuilder();
    buildChat(entries, b);
    const texts = b.items.map((i) => ('text' in i ? i.text : ''));
    expect(texts).toEqual(['first', 'reply 1', 'edited question', 'final reply']);
  });

  it('follows logicalParentUuid across a compaction boundary', () => {
    const entries = [
      user('u1', null, 'old question'),
      assistant('a1', 'u1', 'm1', { type: 'text', text: 'old answer' }),
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a1', content: 'Conversation compacted' } as TranscriptEntry,
      user('s1', 'c1', 'This session is being continued…', { isCompactSummary: true }),
      user('u2', 's1', 'new question'),
      assistant('a2', 'u2', 'm2', { type: 'text', text: 'new answer' }),
    ];
    const b = new ChatBuilder();
    buildChat(entries, b);
    const kinds = b.items.map((i) => (i.kind === 'system' ? `system:${i.tag}` : i.kind));
    expect(kinds).toEqual(['user', 'text', 'system:compact', 'system:compact', 'user', 'text']);
  });
});

describe('buildChat', () => {
  it('renders commands, local output, interruptions and hides meta messages', () => {
    const entries = [
      user('u1', null, '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep tests</command-args>'),
      user('u2', 'u1', '<local-command-stdout>Compacted.</local-command-stdout>'),
      user('u3', 'u2', 'internal context', { isMeta: true }),
      user('u4', 'u3', [{ type: 'text', text: '[Request interrupted by user]' }]),
      user('u5', 'u4', [{ type: 'text', text: 'hello <system-reminder>secret</system-reminder>there' }]),
      { type: 'system', subtype: 'turn_duration', uuid: 'd1', parentUuid: 'u5', durationMs: 4200 } as TranscriptEntry,
    ];
    const b = new ChatBuilder();
    buildChat(entries, b);
    const items = b.items;
    expect((items[0] as UserItem).text).toBe('/compact keep tests');
    expect((items[0] as UserItem).command).toBe('compact');
    expect(items[1]).toMatchObject({ kind: 'system', tag: 'command-output', text: 'Compacted.' });
    expect(items[2]).toMatchObject({ kind: 'system', tag: 'interrupted' });
    expect((items[3] as UserItem).text).toBe('hello there');
    expect(items[4]).toMatchObject({ kind: 'turn-end', durationMs: 4200 });
    expect(items).toHaveLength(5);
  });

  it('marks rejected tools as denied and keeps structured edit patches', () => {
    const entries = [
      user('u1', null, 'edit it'),
      assistant('a1', 'u1', 'm1', { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } }),
      user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 't1', content: "The user doesn't want to proceed with this tool use.", is_error: true }]),
      assistant('a2', 'r1', 'm2', { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'c' } }),
      user('r2', 'a2', [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }], {
        toolUseResult: { filePath: '/repo/a.ts', originalFile: 'x'.repeat(100_000), structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+c'] }] },
      }),
    ];
    const b = new ChatBuilder();
    buildChat(entries, b);
    const [t1, t2] = b.items.filter((i): i is ToolItem => i.kind === 'tool');
    expect(t1.status).toBe('denied');
    expect(t2.status).toBe('done');
    expect(t2.structured).toEqual({ filePath: '/repo/a.ts', type: undefined, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+c'] }], userModified: undefined });
  });

  it('skips internal entry types without parsing them', () => {
    const text = [
      '{"type":"api-request","huge":"' + 'x'.repeat(1000) + '"}',
      JSON.stringify(user('u1', null, 'hi')),
      '{"type":"queue-operation","operation":"enqueue"}',
      '{"torn line',
    ].join('\n');
    const entries = parseTranscript(text);
    expect(entries.map((e) => e.type)).toEqual(['user']);
  });
});

describe('session info', () => {
  it('extracts string fields with escapes', () => {
    const t = '{"aiTitle":"First"}\n{"aiTitle":"Say \\"hi\\" \\u00e9"}\n';
    expect(lastStringField(t, 'aiTitle')).toBe('Say "hi" é');
    expect(firstStringField(t, 'aiTitle')).toBe('First');
  });

  it('finds the first real prompt and skips tool results/meta/commands', () => {
    const head = [
      JSON.stringify({ type: 'user', message: { content: '<command-name>/model</command-name>' } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the\nlogin bug' }] } }),
    ].join('\n');
    expect(firstPrompt(head)).toMatchObject({ prompt: 'Fix the login bug', commandFallback: '/model' });
  });

  it('prefers custom title, then AI title, then last prompt', () => {
    const base = JSON.stringify({ type: 'user', parentUuid: null, cwd: '/repo', gitBranch: 'main', timestamp: '2026-10-01T10:00:00.000Z', message: { content: 'first prompt' } });
    const mk = (extra: string) => ({ head: base + '\n' + extra, tail: base + '\n' + extra, size: 100, mtimeMs: 5 });
    expect(parseSessionInfo('s', '/f', mk(''))?.title).toBe('first prompt');
    expect(parseSessionInfo('s', '/f', mk('{"type":"last-prompt","lastPrompt":"latest"}'))?.title).toBe('latest');
    expect(parseSessionInfo('s', '/f', mk('{"type":"ai-title","aiTitle":"AI"}\n{"type":"last-prompt","lastPrompt":"latest"}'))?.title).toBe('AI');
    const withCustom = parseSessionInfo('s', '/f', mk('{"type":"ai-title","aiTitle":"AI"}\n{"type":"custom-title","customTitle":"Mine"}'));
    expect(withCustom).toMatchObject({ title: 'Mine', cwd: '/repo', gitBranch: 'main', createdAt: Date.parse('2026-10-01T10:00:00.000Z') });
  });

  it('ignores sidechain and empty transcripts', () => {
    const side = JSON.stringify({ type: 'user', isSidechain: true, parentUuid: null, message: { content: 'x' } });
    expect(parseSessionInfo('s', '/f', { head: side, tail: side, size: 10, mtimeMs: 1 })).toBeUndefined();
    const meta = '{"type":"queue-operation"}';
    expect(parseSessionInfo('s', '/f', { head: meta, tail: meta, size: 10, mtimeMs: 1 })).toBeUndefined();
  });
});
