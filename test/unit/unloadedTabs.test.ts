import { describe, expect, it } from 'vitest';
import { findUnloadedTabs } from '../../src/panels/unloadedTabs';

const chat = (label: string) => ({ label, viewType: 'mainThreadWebview-claudeProjects.chat' });

describe('findUnloadedTabs', () => {
  it('lists chat tabs that have no loaded panel', () => {
    const groups = [{ viewColumn: 1, tabs: [{ label: 'Claude Sessions', viewType: 'mainThreadWebview-claudeProjects.dashboard' }, chat(''), chat('Fix login'), chat('')] }];
    const out = findUnloadedTabs(groups, [{ viewColumn: 1, title: 'Fix login' }], 'claudeProjects.chat');
    expect(out.map((t) => t.key)).toEqual(['tab:1:1', 'tab:1:3']);
  });

  it('matches loaded panels by column and counts duplicate titles', () => {
    const groups = [
      { viewColumn: 1, tabs: [chat('Same'), chat('Same')] },
      { viewColumn: 2, tabs: [chat('Same'), { label: 'a.ts' }] },
    ];
    const out = findUnloadedTabs(groups, [{ viewColumn: 1, title: 'Same' }, { viewColumn: 2, title: 'Same' }], 'claudeProjects.chat');
    expect(out).toEqual([{ key: 'tab:1:1', viewColumn: 1, index: 1, label: 'Same' }]);
  });

  it('ignores other webviews and text tabs', () => {
    const groups = [{ viewColumn: 1, tabs: [{ label: 'x', viewType: 'mainThreadWebview-other.chat' }, { label: 'b.ts' }] }];
    expect(findUnloadedTabs(groups, [], 'claudeProjects.chat')).toEqual([]);
  });
});
