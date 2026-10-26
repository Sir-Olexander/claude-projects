/** The "/" command or "@" file mention being typed at the caret, if any. */
export interface Trigger {
  kind: 'slash' | 'mention';
  query: string;
  /** A "/" typed after other text (not at the start of the message). */
  inline?: boolean;
  /** Index in the text where the trigger token starts (the / or @). */
  start: number;
  end: number;
}

export function findTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], start: 0, end: caret };
  // "/" after a space anywhere in the message: commands and skills can be named mid-prompt too.
  const inline = /\s\/([^\s/]*)$/.exec(before);
  if (inline) return { kind: 'slash', query: inline[1], start: caret - inline[1].length - 1, end: caret, inline: true };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: 'mention', query: at[2], start: caret - at[2].length - 1, end: caret };
  return undefined;
}

