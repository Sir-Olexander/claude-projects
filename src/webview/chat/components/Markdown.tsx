import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { renderMarkdown } from '../lib/markdown';

/**
 * While text streams in, re-render the markdown at most every few dozen ms
 * (longer texts get a longer interval) instead of on every delta.
 */
function useThrottledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  latest.current = text;

  useEffect(() => {
    if (!streaming) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      if (shown !== text) setShown(text);
      return;
    }
    const interval = text.length > 20_000 ? 400 : text.length > 5_000 ? 180 : 60;
    const wait = lastAt.current + interval - performance.now();
    if (wait <= 0) {
      lastAt.current = performance.now();
      if (shown !== text) setShown(text);
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        lastAt.current = performance.now();
        setShown(latest.current);
      }, wait);
    }
  }, [text, streaming]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return streaming ? shown : text;
}

export const Markdown = memo(function Markdown({ text, streaming = false, class: cls }: { text: string; streaming?: boolean; class?: string }) {
  const shown = useThrottledText(text, streaming);
  const html = useMemo(() => renderMarkdown(shown), [shown]);
  return <div class={`md${cls ? ' ' + cls : ''}${streaming ? ' md-streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
