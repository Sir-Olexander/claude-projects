import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store';
import { copyText } from './actions';
import { Icon } from './ui';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Text fields keep their own copy, cut and paste. */
function isEditable(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? '';
}

/** Raw text of the message under an element (your prompt, or Claude's reply as Markdown). */
function messageTextAt(el: Element | null): string | undefined {
  const id = el?.closest<HTMLElement>('.bm-frame')?.dataset.itemId;
  const item = id ? store.state?.items.find((i) => i.id === id) : undefined;
  if (item && (item.kind === 'user' || item.kind === 'text') && item.text.trim()) return item.text;
  return undefined;
}

interface MenuState {
  x: number;
  y: number;
  selection: string;
  message?: string;
}

/**
 * Copying in the chat: Cmd/Ctrl+C and Cmd/Ctrl+X copy the selected text
 * (messages can't be cut, so X copies too), and right-click opens a small
 * Copy menu. Handled here rather than left to VS Code, whose forwarding of
 * these keys and menus to webviews isn't reliable.
 */
export function CopyMenu() {
  const [menu, setMenu] = useState<MenuState | undefined>();
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'c' && key !== 'x') return;
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
      const text = selectedText();
      if (!text) return;
      e.preventDefault();
      copyText(text);
    };
    const onCopy = (e: ClipboardEvent) => {
      // VS Code's own Copy command runs execCommand('copy'): make sure it gets the selection.
      if (isEditable(document.activeElement)) return;
      const text = selectedText();
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    const onContext = (e: MouseEvent) => {
      if (isEditable(e.target)) return; // VS Code's menu for text fields (cut, copy, paste)
      const target = e.target as Element | null;
      const selection = selectedText();
      const message = messageTextAt(target);
      if (!selection && !message) return;
      e.preventDefault();
      setActive(0);
      setMenu({ x: e.clientX, y: e.clientY, selection, message });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('contextmenu', onContext);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('contextmenu', onContext);
    };
  }, []);

  const items = menu
    ? [
        { label: 'Copy', icon: 'copy', keys: isMac ? '⌘C' : 'Ctrl+C', text: menu.selection },
        ...(menu.message ? [{ label: 'Copy message', icon: 'comment', keys: '', text: menu.message }] : []),
      ].filter((i) => i.text)
    : [];

  // Close on any outside click, scroll, Esc or window blur; arrows and Enter pick.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const it = items[active];
        if (it) copyText(it.text);
        close();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu, active, items.length]);

  // Keep the menu inside the panel.
  useEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4));
    const y = menu.y + r.height > window.innerHeight - 4 ? Math.max(4, menu.y - r.height) : menu.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [menu]);

  if (!menu || !items.length) return null;
  return (
    <div ref={ref} class="copy-menu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
      {items.map((it, i) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          class={`copy-menu-item${i === active ? ' is-active' : ''}`}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => e.preventDefault() /* keep the selection */}
          onClick={() => {
            copyText(it.text);
            setMenu(undefined);
          }}
        >
          <Icon name={it.icon} />
          <span class="copy-menu-label">{it.label}</span>
          {it.keys ? <span class="copy-menu-keys">{it.keys}</span> : null}
        </button>
      ))}
    </div>
  );
}
