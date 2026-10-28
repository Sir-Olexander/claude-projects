/**
 * VS Code restores webview tabs lazily: a chat tab from the last session is only
 * handed to the extension when it is first shown. Until then it is just a tab
 * (often with an empty label) and no session is attached to it.
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
}

export function isChatTab(tab: TabLike, chatViewType: string): boolean {
  return !!tab.viewType && (tab.viewType === chatViewType || tab.viewType.endsWith(`-${chatViewType}`));
}

/** Chat tabs not backed by a loaded panel (matched by column and label). */
export function findUnloadedTabs(groups: readonly GroupLike[], loaded: readonly LoadedPanel[], chatViewType: string): UnloadedTab[] {
  const out: UnloadedTab[] = [];
  for (const g of groups) {
    const titles = loaded.filter((p) => p.viewColumn === g.viewColumn).map((p) => p.title);
    g.tabs.forEach((tab, index) => {
      if (!isChatTab(tab, chatViewType)) return;
      const i = titles.indexOf(tab.label);
      if (i >= 0) {
        titles.splice(i, 1);
        return;
      }
      out.push({ key: `tab:${g.viewColumn}:${index}`, viewColumn: g.viewColumn, index, label: tab.label });
    });
  }
  return out;
}
