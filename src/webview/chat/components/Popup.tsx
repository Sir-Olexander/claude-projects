import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './ui';

export interface PopupItem {
  key: string;
  label: ComponentChildren;
  /** Muted text after the label (e.g. argument hint). */
  detail?: string;
  /** Second line / right side description. */
  description?: string;
  icon?: string;
  checked?: boolean;
}

/** Menu shown above the composer. Keyboard navigation is driven by the owner. */
export function Popup({
  title,
  items,
  active,
  onSelect,
  onHover,
  align = 'full',
  empty,
  footer,
}: {
  title?: string;
  items: PopupItem[];
  active: number;
  onSelect: (index: number) => void;
  onHover?: (index: number) => void;
  align?: 'full' | 'left' | 'right';
  empty?: string;
  footer?: ComponentChildren;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, items.length]);
  return (
    <div class={`popup popup-${align}`} role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {title ? <div class="popup-title">{title}</div> : null}
      <div class="popup-list" ref={list}>
        {items.length === 0 ? <div class="popup-empty">{empty ?? 'No matches'}</div> : null}
        {items.map((it, i) => (
          <div
            key={it.key}
            data-index={i}
            role="option"
            aria-selected={i === active}
            class={`popup-item${i === active ? ' is-active' : ''}`}
            onMouseEnter={() => onHover?.(i)}
            onClick={() => onSelect(i)}
          >
            {it.icon ? <Icon name={it.icon} class="popup-icon" /> : null}
            <div class="popup-text">
              <div class="popup-line">
                <span class="popup-label">{it.label}</span>
                {it.detail ? <span class="popup-detail">{it.detail}</span> : null}
              </div>
              {it.description ? <div class="popup-desc">{it.description}</div> : null}
            </div>
            {it.checked ? <Icon name="check" class="popup-check" /> : null}
          </div>
        ))}
      </div>
      {footer ? <div class="popup-footer">{footer}</div> : null}
    </div>
  );
}
