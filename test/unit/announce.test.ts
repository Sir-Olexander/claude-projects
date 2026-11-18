import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { shouldAnnounceHub } from '../../src/announce';

describe('Claude Chats announcement', () => {
  it('shows once to existing users who have not chosen where chats open', () => {
    expect(shouldAnnounceHub({ announced: false, existingUser: true, openInChosen: false })).toBe(true);
  });
  it('never shows twice', () => {
    expect(shouldAnnounceHub({ announced: true, existingUser: true, openInChosen: false })).toBe(false);
  });
  it('skips fresh installs', () => {
    expect(shouldAnnounceHub({ announced: false, existingUser: false, openInChosen: false })).toBe(false);
  });
  it('skips people who already set chat.openIn', () => {
    expect(shouldAnnounceHub({ announced: false, existingUser: true, openInChosen: true })).toBe(false);
  });
});
