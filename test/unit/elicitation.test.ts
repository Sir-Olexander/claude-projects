import { describe, expect, it } from 'vitest';
import { fieldsFromSchema, normalizeElicitation, validateElicitation } from '../../src/sessions/elicitation';
import { bookmarkFor, resolveBookmarks } from '../../src/sessions/bookmarks';
import type { ChatItem } from '../../src/shared/protocol';

describe('MCP elicitation forms', () => {
  const schema = {
    type: 'object',
    properties: {
      env: { type: 'string', title: 'Environment', enum: ['staging', 'production'], enumNames: ['Staging', 'Production'] },
      region: { type: 'string', oneOf: [{ const: 'eu', title: 'Europe' }, { const: 'us', title: 'US' }] },
      replicas: { type: 'integer', minimum: 1, maximum: 5 },
      tags: { type: 'array', items: { enum: ['a', 'b', 'c'] }, minItems: 1 },
      notify: { type: 'boolean', default: true },
      email: { type: 'string', format: 'email' },
      api_key: { type: 'string', minLength: 4 },
    },
    required: ['env', 'replicas'],
  };

  it('turns the restricted schema into fields', () => {
    const f = fieldsFromSchema(schema, ['replicas']);
    expect(f.map((x) => [x.name, x.type, x.required])).toEqual([
      ['replicas', 'integer', true],
      ['env', 'enum', true],
      ['region', 'enum', false],
      ['tags', 'multi', false],
      ['notify', 'boolean', false],
      ['email', 'string', false],
      ['api_key', 'string', false],
    ]);
    expect(f.find((x) => x.name === 'env')?.options).toEqual([
      { value: 'staging', label: 'Staging' },
      { value: 'production', label: 'Production' },
    ]);
    expect(f.find((x) => x.name === 'region')?.options?.[0]).toEqual({ value: 'eu', label: 'Europe' });
    expect(f.find((x) => x.name === 'api_key')?.label).toBe('Api key');
    expect(f.find((x) => x.name === 'notify')?.default).toBe(true);
  });

  it('validates and normalizes answers', () => {
    const f = fieldsFromSchema(schema);
    expect(validateElicitation(f, {})).toEqual({ env: 'Required', replicas: 'Required' });
    expect(validateElicitation(f, { env: 'staging', replicas: '9', email: 'nope', api_key: 'ab', tags: [] })).toEqual({ replicas: 'At most 5', email: 'Enter an email address', api_key: 'At least 4 characters' });
    expect(validateElicitation(f, { env: 'staging', replicas: '2.5' })).toEqual({ replicas: 'Enter a whole number' });
    expect(normalizeElicitation(f, { env: 'production', replicas: '3', tags: ['a'], email: '' })).toEqual({ env: 'production', replicas: 3, tags: ['a'], notify: false });
  });
});

describe('bookmarks', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'Please refactor the **auth** module' },
    { kind: 'text', id: 'm1:0', text: '## Plan\n\nFirst I will…' },
    { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' }, status: 'done' },
    { kind: 'thinking', id: 'm1:1', text: 'hmm' },
  ];
  it('labels bookmarkable items and skips others', () => {
    expect(bookmarkFor(items[0])?.label).toBe('Please refactor the auth module');
    expect(bookmarkFor(items[1])?.label).toBe('Plan');
    expect(bookmarkFor(items[2])?.label).toBe('Running npm test');
    expect(bookmarkFor(items[3])).toBeUndefined();
  });
  it('re-attaches bookmarks whose item id changed', () => {
    const b = bookmarkFor(items[0])!;
    const reloaded: ChatItem[] = [{ ...items[0], id: 'u1-from-transcript' } as ChatItem, ...items.slice(1)];
    const r = resolveBookmarks([b], reloaded);
    expect(r.changed).toBe(true);
    expect(r.list[0].itemId).toBe('u1-from-transcript');
    expect(resolveBookmarks(r.list, reloaded).changed).toBe(false);
    // Unknown items are kept (they may be in history that isn't loaded yet).
    expect(resolveBookmarks([{ ...b, snippet: 'other' , itemId: 'gone' }], reloaded).list[0].itemId).toBe('gone');
  });
});
