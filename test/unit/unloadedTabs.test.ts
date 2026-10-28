import { describe, expect, it } from 'vitest';
import { mapChatTabs, stripTabNumber } from '../../src/panels/unloadedTabs';

const chat = (label: string) => ({ label, viewType: 'mainThreadWebview-claudeProjects.chat' });
const VT = 'claudeProjects.chat';

describe('mapChatTabs', () => {
  it('numbers chat tabs left to right and lists the unloaded ones', () => {
    const groups = [{ viewColumn: 1, tabs: [{ label: 'Claude Sessions', viewType: 'mainThreadWebview-claudeProjects.dashboard' }, chat(''), chat('Fix login'), chat('')] }];
    const map = mapChatTabs(groups, [{ viewColumn: 1, title: 'Fix login' }], VT);
    expect(map.unloaded.map((t) => [t.key, t.number])).toEqual([
      ['tab:1:1', 0],
      ['tab:1:3', 2],
    ]);
    expect(map.panelNumbers).toEqual([1]);
  });

  it('matches titles that already carry an (old) number', () => {
    const groups = [{ viewColumn: 1, tabs: [chat('5 · Fix login')] }];
    expect(mapChatTabs(groups, [{ viewColumn: 1, title: '5 · Fix login' }], VT).panelNumbers).toEqual([0]);
  });

  it('matches by column, counts duplicate titles and numbers across groups', () => {
    const groups = [
      { viewColumn: 1, tabs: [chat('Same'), chat('Same')] },
      { viewColumn: 2, tabs: [chat('Same'), { label: 'a.ts' }] },
    ];
    const map = mapChatTabs(groups, [{ viewColumn: 1, title: 'Same' }, { viewColumn: 2, title: 'Same' }], VT);
    expect(map.unloaded).toEqual([{ key: 'tab:1:1', viewColumn: 1, index: 1, label: 'Same', number: 1 }]);
    expect(map.panelNumbers).toEqual([0, 2]);
  });

  it('ignores other webviews and text tabs; panels without a tab get no number', () => {
    const groups = [{ viewColumn: 1, tabs: [{ label: 'x', viewType: 'mainThreadWebview-other.chat' }, { label: 'b.ts' }] }];
    expect(mapChatTabs(groups, [{ viewColumn: 1, title: 'New' }], VT)).toEqual({ unloaded: [], panelNumbers: [undefined] });
  });

  it('strips only a leading tab number', () => {
    expect(stripTabNumber('12 · Fix 3 · bugs')).toBe('Fix 3 · bugs');
    expect(stripTabNumber('Fix')).toBe('Fix');
  });
});
