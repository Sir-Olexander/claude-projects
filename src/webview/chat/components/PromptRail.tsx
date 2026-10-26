import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { store } from '../store';

export interface RailPrompt {
  id: string;
  text: string;
}

interface Mark {
  id: string;
  /** Position in the conversation, 0 (top) to 1 (bottom). */
  at: number;
  text: string;
}

/**
 * A strip of dots along the right edge, one per message you sent, placed where
 * it sits in the conversation. Hover shows the message; click jumps to it. The
 * dot for the prompt you're reading is highlighted.
 */
export function PromptRail({ scroller, prompts, version }: { scroller: RefObject<HTMLDivElement | null>; prompts: RailPrompt[]; version: number }) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [active, setActive] = useState<string | undefined>();
  const [hover, setHover] = useState<string | undefined>();

  const offsetOf = (el: HTMLElement, node: HTMLElement) => node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const height = Math.max(1, el.scrollHeight);
    const next: Mark[] = [];
    for (const p of prompts) {
      const node = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(p.id)}"]`);
      if (node) next.push({ id: p.id, at: Math.min(1, Math.max(0, offsetOf(el, node) / height)), text: p.text });
    }
    setMarks((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [scroller, prompts]);

  const updateActive = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    let current: string | undefined;
    for (const p of prompts) {
      const node = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(p.id)}"]`);
      if (node && offsetOf(el, node) <= el.scrollTop + el.clientHeight * 0.35) current = p.id;
    }
    setActive(current);
  }, [scroller, prompts]);

  useLayoutEffect(() => {
    measure();
    updateActive();
  }, [measure, updateActive, version]);

  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActive();
      });
    };
    const ro = new ResizeObserver(() => measure());
    ro.observe(inner);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, measure, updateActive]);

  if (marks.length < 2) return null;
  const tip = hover ? marks.find((m) => m.id === hover) : undefined;
  return (
    <nav class="prompt-rail" aria-label="Your messages">
      {marks.map((m, i) => (
        <button
          key={m.id}
          type="button"
          class={`prompt-dot${m.id === active ? ' is-active' : ''}`}
          style={{ top: `${m.at * 100}%` }}
          aria-label={`Go to your message ${i + 1}: ${m.text.slice(0, 80)}`}
          onMouseEnter={() => setHover(m.id)}
          onMouseLeave={() => setHover((h) => (h === m.id ? undefined : h))}
          onFocus={() => setHover(m.id)}
          onBlur={() => setHover(undefined)}
          onClick={() => store.scrollTo(m.id)}
        />
      ))}
      {tip ? (
        <div class="prompt-tip" style={{ top: `${tip.at * 100}%` }} role="tooltip">
          {tip.text.length > 160 ? `${tip.text.slice(0, 159)}…` : tip.text}
        </div>
      ) : null}
    </nav>
  );
}
