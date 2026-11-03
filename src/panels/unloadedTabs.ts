/**
 * VS Code restores webview tabs lazily: a chat tab from the last session is only
 * handed to the extension when it is first shown. Until then it is just a tab
 * (with an empty label, so only its icon shows) and no session is attached to it.
 *
 * Chat tabs are numbered 0, 1, 2… left to right (editor group by group), loaded or
 * not. In icon-only mode the number is the tab's title.
 *
 * The extension API doesn't say which tab belongs to which panel, so each panel's
 * title ends with an invisible tag that never changes (see tabTag). Tabs are matched
 * to panels by that tag, not by their visible text: VS Code reports a title change
 * back a little later, so a tab can still show an old number that is now another
 * panel's. Matching on the visible text paired tabs with the wrong panels, gave two
 * tabs the same number and kept renumbering them in a loop.
 */

/** Starts a tab tag; the tag's digits follow. All of these characters are invisible. */
const TAG_START = '\u2063';
const TAG_DIGITS = ['\u200B', '\u200C', '\u200D', '\u2060'];
const TAG_RE = new RegExp(`${TAG_START}[${TAG_DIGITS.join('')}]+$`);

/** Invisible text for a panel's id, to put at the end of its tab title. */
export function tabTag(id: number): string {
  let digits = '';
  let n = Math.max(0, Math.floor(id));
  do {
    digits = TAG_DIGITS[n % 4] + digits;
    n = Math.floor(n / 4);
  } while (n > 0);
  return TAG_START + digits;
}

/** The tag at the end of a tab title, if it has one. */
export function readTabTag(label: string): string | undefined {
  return TAG_RE.exec(label)?.[0];
}

/** A tab title without its tag: the text the tab shows. */
export function stripTabTag(label: string): string {
  return label.replace(TAG_RE, '');
}

export interface TabLike {
  /** Webview view type of the tab, if it is a webview tab (VS Code may prefix it). */
  viewType?: string;
  label: string;
}

export interface GroupLike {
  viewColumn: number;
  tabs: readonly TabLike[];
}

/** A loaded chat panel, known by the tag at the end of its title. */
export interface LoadedPanel {
  tag: string;
}

export interface UnloadedTab {
  /** `tab:<viewColumn>:<index in group>`; check it again before acting on it. */
  key: string;
  viewColumn: number;
  index: number;
  /** The title the tab shows (without a tag). */
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

/** Matches chat tabs to loaded panels (by the tag in their titles) and numbers them. */
export function mapChatTabs(groups: readonly GroupLike[], loaded: readonly LoadedPanel[], chatViewType: string): ChatTabMap {
  const unloaded: UnloadedTab[] = [];
  const panelNumbers: (number | undefined)[] = loaded.map(() => undefined);
  const byTag = new Map(loaded.map((p, i) => [p.tag, i]));
  let n = 0;
  for (const g of groups) {
    g.tabs.forEach((tab, index) => {
      if (!isChatTab(tab, chatViewType)) return;
      const number = n++;
      const tag = readTabTag(tab.label);
      const i = tag === undefined ? undefined : byTag.get(tag);
      if (i !== undefined && panelNumbers[i] === undefined) {
        panelNumbers[i] = number;
        return;
      }
      unloaded.push({ key: `tab:${g.viewColumn}:${index}`, viewColumn: g.viewColumn, index, label: stripTabTag(tab.label), number });
    });
  }
  return { unloaded, panelNumbers };
}
