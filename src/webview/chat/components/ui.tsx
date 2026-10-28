import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Icons the codicon font doesn't have, drawn on its 16px grid in the text colour. */
const SVG_ICONS: Record<string, ComponentChildren> = {
  // A band-aid, for the "Yolo auto" mode.
  bandaid: (
    <>
      <g transform="rotate(-45 8 8)" fill="none" stroke="currentColor" stroke-width="1.1">
        <rect x="1" y="5" width="14" height="6" rx="3" />
        <path d="M5.5 5v6M10.5 5v6" />
      </g>
      <g transform="rotate(-45 8 8)" fill="currentColor">
        <circle cx="7.1" cy="7.1" r="0.6" />
        <circle cx="8.9" cy="7.1" r="0.6" />
        <circle cx="7.1" cy="8.9" r="0.6" />
        <circle cx="8.9" cy="8.9" r="0.6" />
      </g>
    </>
  ),
};

export function Icon({ name, class: cls, title, spin }: { name: string; class?: string; title?: string; spin?: boolean }) {
  const svg = SVG_ICONS[name];
  if (svg) {
    return (
      <svg class={`codicon codicon-${name} svg-icon${cls ? ' ' + cls : ''}`} viewBox="0 0 16 16" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : 'true'}>
        {title ? <title>{title}</title> : null}
        {svg}
      </svg>
    );
  }
  return <i class={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}${cls ? ' ' + cls : ''}`} title={title} aria-hidden={title ? undefined : 'true'} />;
}

export function IconButton(props: {
  icon: string;
  title: string;
  onClick: (e: MouseEvent) => void;
  class?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      class={`icon-btn${props.class ? ' ' + props.class : ''}`}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick(e as unknown as MouseEvent);
      }}
    >
      <Icon name={props.icon} />
      {props.label ? <span class="icon-btn-label">{props.label}</span> : null}
    </button>
  );
}

/** A clipped block that expands on demand ("Show more"). */
export function Clipped({
  children,
  maxHeight = 120,
  class: cls,
  watch,
}: {
  children: ComponentChildren;
  maxHeight?: number;
  class?: string;
  /** Re-measure when this value changes (e.g. content length). */
  watch?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > maxHeight + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxHeight, watch]);
  const style = open || !overflows ? undefined : { maxHeight: `${maxHeight}px` };
  return (
    <div class={`clipped${overflows && !open ? ' is-clipped' : ''}${cls ? ' ' + cls : ''}`}>
      <div class="clipped-inner" ref={ref} style={style}>
        {children}
      </div>
      {overflows ? (
        <button type="button" class="show-more" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/** Small pill/badge. */
export function Badge({ children, tone = 'neutral', icon }: { children: ComponentChildren; tone?: 'neutral' | 'warn' | 'error' | 'ok' | 'accent'; icon?: string }) {
  return (
    <span class={`badge badge-${tone}`}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}
