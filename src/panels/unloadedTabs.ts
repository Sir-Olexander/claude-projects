/**
 * VS Code restores webview tabs lazily: a chat tab from the last session is only
 * handed to the extension when it is first shown. Until then it is just a tab
 * (with an empty label, so only its icon shows) and no session is attached to it.
 *
 * Chat tabs are numbered 0, 1, 2… left to right (editor group by group), loaded or
 * not, so a tab can be told apart in the dashboard even before it loads.
 */

export interface TabLike {
  /** Webview view type of the tab, if it is a webview tab (VS Code may prefix it). */
  viewType?: string;
  label: string;
}

export interface GroupLike {
  viewColumn: number;
  tabs: readonly TabLike[];
}

/** A loaded chat panel: where it is and the title its tab shows. */
export interface LoadedPanel {
  viewColumn?: number;
  title: string;
}

export interface UnloadedTab {
  /** `tab:<viewColumn>:<index in group>`; check it again before acting on it. */
  key: string;
  viewColumn: number;
  index: number;
  label: string;
  /** Position among this window's chat tabs, from 0. */
  number: number;
}

export interface ChatTabMap {
  unloaded: UnloadedTab[];
  /** Tab number of each loaded panel (same order as the input); undefined if its tab wasn't found. */
  panelNumbers: (number | undefined)[];
}

export function isChatTab(tab: TabLike, chatViewType: string): boolean {
  return !!tab.viewType && (tab.viewType === chatViewType || tab.viewType.endsWith(`-${chatViewType}`));
}

/** "3 · Fix login" → "Fix login" (the number changes as tabs move). */
export function stripTabNumber(title: string): string {
  return title.replace(/^\d+ · /, '');
}

/** Matches chat tabs to loaded panels (by column and title) and numbers them. */
export function mapChatTabs(groups: readonly GroupLike[], loaded: readonly LoadedPanel[], chatViewType: string): ChatTabMap {
  const unloaded: UnloadedTab[] = [];
  const panelNumbers: (number | undefined)[] = loaded.map(() => undefined);
  let n = 0;
  for (const g of groups) {
    const free = loaded.map((p, i) => i).filter((i) => loaded[i].viewColumn === g.viewColumn);
    g.tabs.forEach((tab, index) => {
      if (!isChatTab(tab, chatViewType)) return;
      const number = n++;
      const label = stripTabNumber(tab.label);
      const at = free.findIndex((i) => stripTabNumber(loaded[i].title) === label);
      if (at >= 0) {
        panelNumbers[free[at]] = number;
        free.splice(at, 1);
        return;
      }
      unloaded.push({ key: `tab:${g.viewColumn}:${index}`, viewColumn: g.viewColumn, index, label, number });
    });
  }
  return { unloaded, panelNumbers };
}
