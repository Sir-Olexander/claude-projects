import { memo } from 'preact/compat';
import { useMemo, useState } from 'preact/hooks';
import type { FileDiff } from '../lib/diff';
import { highlightLine, languageForPath } from '../lib/markdown';

/**
 * Compact unified diff: line numbers, +/- gutter, syntax-highlighted code,
 * green/red line backgrounds from the theme's diff editor colors.
 */
export const DiffView = memo(function DiffView({ diff, collapsedLines = 14, startOpen = false }: { diff: FileDiff; collapsedLines?: number; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const language = languageForPath(diff.filePath);
  const lines = open ? diff.lines : diff.lines.slice(0, collapsedLines);
  const hidden = diff.lines.length - lines.length;
  const rendered = useMemo(
    () =>
      lines.map((l, i) => {
        if (l.type === 'hunk' || l.type === 'meta') {
          return (
            <div class="diff-row diff-hunk" key={i}>
              <span class="diff-hunk-text">{l.text}</span>
            </div>
          );
        }
        const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        return (
          <div class={`diff-row diff-${l.type}`} key={i}>
            {diff.hasLineNumbers ? <span class="diff-no">{l.type === 'add' ? l.newNo ?? '' : l.oldNo ?? l.newNo ?? ''}</span> : null}
            <span class="diff-sign">{sign}</span>
            <span class="diff-code" dangerouslySetInnerHTML={{ __html: highlightLine(l.text, language) || '&nbsp;' }} />
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diff, open, collapsedLines, language],
  );
  return (
    <div class={`diff-view${diff.hasLineNumbers ? ' with-numbers' : ''}`}>
      <div class="diff-lines">
        <div class="diff-inner">{rendered}</div>
      </div>
      {hidden > 0 || (open && diff.lines.length > collapsedLines) ? (
        <button type="button" class="diff-more" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          {open ? 'Show less' : `Show ${hidden} more line${hidden === 1 ? '' : 's'}`}
        </button>
      ) : null}
      {diff.truncated && open ? <div class="diff-truncated">Diff truncated — open it in the editor to see everything.</div> : null}
    </div>
  );
});

export function DiffStats({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return (
    <span class="diff-stats">
      {added ? <span class="ins">+{added}</span> : null}
      {removed ? <span class="del">−{removed}</span> : null}
    </span>
  );
}
