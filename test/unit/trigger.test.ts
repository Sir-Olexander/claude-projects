import { describe, expect, it } from 'vitest';
import { findTrigger } from '../../src/webview/chat/lib/trigger';

const at = (text: string) => findTrigger(text, text.length);

describe('composer triggers', () => {
  it('opens commands for "/" at the start', () => {
    expect(at('/rev')).toEqual({ kind: 'slash', query: 'rev', start: 0, end: 4 });
  });

  it('opens commands for "/" after a space in the middle of a message', () => {
    expect(at('please run /simp')).toEqual({ kind: 'slash', query: 'simp', start: 11, end: 16, inline: true });
    expect(at('first line\n/')).toMatchObject({ kind: 'slash', query: '', inline: true });
  });

  it('leaves paths and URLs alone', () => {
    expect(at('look at src/app')).toBeUndefined();
    expect(at('see https://x.com/a')).toBeUndefined();
    expect(at('cd /usr/local')).toBeUndefined();
  });

  it('still finds @ mentions', () => {
    expect(at('check @src/ma')).toEqual({ kind: 'mention', query: 'src/ma', start: 6, end: 13 });
  });
});
