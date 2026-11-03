import { describe, expect, it } from 'vitest';
import { mapChatTabs, readTabTag, stripTabTag, tabTag } from '../../src/panels/unloadedTabs';

const chat = (label: string) => ({ label, viewType: 'mainThreadWebview-claudeProjects.chat' });
const VT = 'claudeProjects.chat';
const A = tabTag(1);
const B = tabTag(2);

describe('tab tags', () => {
  it('are invisible, distinct and read back from the end of a title', () => {
    expect(new Set([0, 1, 2, 3, 4, 255, 0xffffff].map(tabTag)).size).toBe(7);
    expect(tabTag(12345)).toMatch(/^[⁣​‌‍⁠]+$/);
    expect(readTabTag('2 •' + A)).toBe(A);
    expect(stripTabTag('2 •' + A)).toBe('2 •');
    expect(readTabTag('2 •')).toBeUndefined();
    expect(stripTabTag('Family 👨‍👩‍👧')).toBe('Family 👨‍👩‍👧');
    expect(readTabTag('Family 👨‍👩‍👧' + B)).toBe(B);
  });
});

describe('mapChatTabs', () => {
  it('numbers chat tabs left to right and lists the unloaded ones', () => {
    const groups = [{ viewColumn: 1, tabs: [{ label: 'Claude Sessions', viewType: 'mainThreadWebview-claudeProjects.dashboard' }, chat(''), chat('Fix login' + A), chat('')] }];
    const map = mapChatTabs(groups, [{ tag: A }], VT);
    expect(map.unloaded.map((t) => [t.key, t.number])).toEqual([
      ['tab:1:1', 0],
      ['tab:1:3', 2],
    ]);
    expect(map.panelNumbers).toEqual([1]);
  });

  it('matches by tag, not by the number a tab still shows', () => {
    // Tab A still shows "1", which is now panel B's number: A must still get its own tab.
    const groups = [{ viewColumn: 1, tabs: [chat('1' + A), chat('1' + B)] }];
    const map = mapChatTabs(groups, [{ tag: B }, { tag: A }], VT);
    expect(map.panelNumbers).toEqual([1, 0]);
    expect(map.unloaded).toEqual([]);
  });

  it('numbers across groups; a restored tab with an old tag is unloaded and shown without it', () => {
    const groups = [
      { viewColumn: 1, tabs: [chat('Same' + A), chat('3' + tabTag(99))] },
      { viewColumn: 2, tabs: [chat('Same' + B), { label: 'a.ts' }] },
    ];
    const map = mapChatTabs(groups, [{ tag: B }, { tag: A }], VT);
    expect(map.unloaded).toEqual([{ key: 'tab:1:1', viewColumn: 1, index: 1, label: '3', number: 1 }]);
    expect(map.panelNumbers).toEqual([2, 0]);
  });

  it('ignores other webviews and text tabs; panels without a tab get no number', () => {
    const groups = [{ viewColumn: 1, tabs: [{ label: 'x' + A, viewType: 'mainThreadWebview-other.chat' }, { label: 'b.ts' }] }];
    expect(mapChatTabs(groups, [{ tag: A }], VT)).toEqual({ unloaded: [], panelNumbers: [undefined] });
  });

  it('settles on 0, 1, 2… when VS Code reports title changes late', () => {
    // The extension renumbers on every tab event, from the labels VS Code has reported
    // so far; its title changes reach VS Code (and come back as tab events) later.
    // Matching by visible number used to loop here and give two tabs the same number.
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 500; run++) {
      const count = 3 + Math.floor(rnd() * 4);
      const panels = Array.from({ length: count }, (_, i) => ({ id: i, tag: tabTag(i), number: i as number | undefined, title: String(i) + tabTag(i) }));
      const main = panels.map((p) => ({ id: p.id, label: p.title }));
      const op = Math.floor(rnd() * 3);
      if (op === 0) {
        const [t] = main.splice(Math.floor(rnd() * main.length), 1);
        main.splice(Math.floor(rnd() * (main.length + 1)), 0, t);
      } else if (op === 1) {
        const [t] = main.splice(Math.floor(rnd() * main.length), 1);
        panels.splice(panels.findIndex((p) => p.id === t.id), 1);
      } else {
        const p = { id: 100, tag: tabTag(100), number: undefined, title: 'New session' + tabTag(100) };
        panels.push(p);
        main.splice(Math.floor(rnd() * (main.length + 1)), 0, { id: p.id, label: p.title });
      }
      panels.sort(() => rnd() - 0.5);
      const events = [main.map((t) => ({ ...t }))];
      const sent: { id: number; title: string }[] = [];
      let steps = 0;
      while ((events.length || sent.length) && steps++ < 200) {
        if (events.length && (!sent.length || rnd() < 0.5)) {
          const seen = events.shift()!;
          const map = mapChatTabs([{ viewColumn: 1, tabs: seen.map((t) => chat(t.label)) }], panels, VT);
          panels.forEach((p, i) => {
            const n = map.panelNumbers[i] ?? p.number;
            if (n === p.number) return;
            p.number = n;
            p.title = String(n) + p.tag;
            sent.push({ id: p.id, title: p.title });
          });
        } else {
          const m = sent.shift()!;
          main.find((t) => t.id === m.id)!.label = m.title;
          events.push(main.map((t) => ({ ...t })));
        }
      }
      expect(steps, `run ${run} settles`).toBeLessThan(200);
      expect(main.map((t) => panels.find((p) => p.id === t.id)!.number), `run ${run}`).toEqual(main.map((_, i) => i));
    }
  });
});
