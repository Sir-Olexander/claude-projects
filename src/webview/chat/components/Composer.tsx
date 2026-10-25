import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { EFFORT_LABELS, PERMISSION_MODE_DESCRIPTIONS, PERMISSION_MODE_LABELS, type ChatState, type EffortLevel, type ImageAttachment, type PermissionMode } from '../../../shared/protocol';
import { fileToAttachment, isImageFile } from '../lib/images';
import { displayPath } from '../lib/paths';
import { store, type FileSuggestions } from '../store';
import { getDraft, saveDraft } from '../ui';
import { send } from './actions';
import { ImageThumbs } from './items';
import { Popup, type PopupItem } from './Popup';
import { Icon } from './ui';

export const MODE_ICONS: Record<PermissionMode, string> = {
  default: 'shield',
  acceptEdits: 'edit',
  plan: 'checklist',
  auto: 'sparkle',
  bypassPermissions: 'warning',
  dontAsk: 'circle-slash',
};

type MenuKind = 'slash' | 'mention' | 'mode' | 'model' | 'effort' | 'presets';

/** Menus opened from a toolbar button (not from typing). */
const isButtonMenu = (m: MenuKind | null) => m === 'mode' || m === 'model' || m === 'effort' || m === 'presets';

const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_HINTS: Record<EffortLevel, string> = {
  low: 'Fastest, for simple tasks',
  medium: 'Balanced speed and depth',
  high: 'Thinks more before acting',
  xhigh: 'Deeper reasoning for hard problems',
  max: 'Most thorough (this session only)',
};

/** Five little bars, filled up to the level. */
function EffortGauge({ level }: { level?: EffortLevel }) {
  const n = level ? EFFORT_ORDER.indexOf(level) + 1 : 0;
  return (
    <span class={`effort-gauge${level ? '' : ' is-default'}`} aria-hidden="true">
      {EFFORT_ORDER.map((_, i) => (
        <span key={i} class={i < n ? 'on' : undefined} style={{ height: `${4 + i * 2}px` }} />
      ))}
    </span>
  );
}

interface Trigger {
  kind: 'slash' | 'mention';
  query: string;
  /** Index in the text where the trigger token starts (the / or @). */
  start: number;
  end: number;
}

function findTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], start: 0, end: caret };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: 'mention', query: at[2], start: caret - at[2].length - 1, end: caret };
  return undefined;
}

function rankCommands(cmds: ChatState['slashCommands'], q: string) {
  const query = q.toLowerCase();
  const scored = cmds
    .map((c) => {
      const n = c.name.toLowerCase();
      let score = -1;
      if (!query) score = 1;
      else if (n === query) score = 100;
      else if (n.startsWith(query)) score = 50 - n.length / 100;
      else if (n.includes(query)) score = 20;
      else if (query.length >= 3 && (c.description ?? '').toLowerCase().includes(query)) score = 5;
      return { c, score };
    })
    .filter((x) => x.score >= 0);
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, 60).map((x) => x.c);
}

function ContextRing({ percent, used, max }: { percent: number; used?: number; max?: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  const tone = p >= 90 ? 'error' : p >= 70 ? 'warn' : 'ok';
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const title = `Context: ${Math.round(p)}% used${used ? ` · ${fmt(used)}${max ? ` of ${fmt(max)}` : ''} tokens` : ''}`;
  return (
    <span class={`ctx-ring ctx-${tone}`} title={title} aria-label={title}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={r} class="ctx-track" />
        <circle cx="8" cy="8" r={r} class="ctx-fill" stroke-dasharray={`${(p / 100) * c} ${c}`} transform="rotate(-90 8 8)" />
      </svg>
      {p >= 50 ? <span class="ctx-pct">{Math.round(p)}%</span> : null}
    </span>
  );
}

export function Composer({ state }: { state: ChatState }) {
  const [text, setText] = useState(getDraft);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [trigger, setTrigger] = useState<Trigger | undefined>();
  const [active, setActive] = useState(0);
  const [mentions, setMentions] = useState<FileSuggestions['items']>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const busy = state.status === 'running' || state.status === 'starting';
  const hasContent = text.trim().length > 0 || images.length > 0;

  // Auto-grow the textarea.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  useEffect(() => {
    const offFocus = store.on('focus-input', () => ta.current?.focus());
    const offInsert = store.on('insert-text', (t) => {
      const add = String(t ?? '');
      setText((cur) => {
        const next = cur && !/\s$/.test(cur) ? `${cur} ${add}` : cur + add;
        saveDraft(next);
        return next;
      });
      setTimeout(() => {
        const el = ta.current;
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      }, 0);
    });
    const offSuggest = store.on('file-suggestions', (s) => {
      const fs = s as FileSuggestions;
      if (fs.requestId === requestId.current) {
        setMentions(fs.items);
        setMentionLoading(false);
        setActive(0);
      }
    });
    // Focus the input when the panel opens.
    const t = setTimeout(() => ta.current?.focus(), 50);
    return () => {
      offFocus();
      offInsert();
      offSuggest();
      clearTimeout(t);
    };
  }, []);

  // Menus opened from a toolbar button are driven from the message box (arrows, Enter, Esc).
  useEffect(() => {
    if (isButtonMenu(menu)) ta.current?.focus();
  }, [menu]);

  // Close button menus when clicking elsewhere.
  useEffect(() => {
    if (!isButtonMenu(menu)) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.popup') && !t.closest('.mode-btn') && !t.closest('.model-btn') && !t.closest('.effort-btn') && !t.closest('.presets-btn')) setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const requestMentions = useCallback((query: string) => {
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    setMentionLoading(true);
    mentionTimer.current = setTimeout(() => {
      requestId.current += 1;
      send({ type: 'file-suggestions', requestId: requestId.current, query });
    }, 90);
  }, []);

  const refreshTrigger = useCallback(
    (value: string, caret: number) => {
      const t = findTrigger(value, caret);
      setTrigger(t);
      if (!t) {
        if (menu === 'slash' || menu === 'mention') setMenu(null);
        return;
      }
      if (t.kind === 'slash') {
        if (menu !== 'slash') setActive(0);
        setMenu('slash');
      } else {
        if (menu !== 'mention' || trigger?.query !== t.query) {
          setActive(0);
          requestMentions(t.query);
        }
        setMenu('mention');
      }
    },
    [menu, trigger, requestMentions],
  );

  const slashItems = useMemo(() => (menu === 'slash' ? rankCommands(state.slashCommands, trigger?.query ?? '') : []), [menu, trigger, state.slashCommands]);

  const popupItems: PopupItem[] = useMemo(() => {
    switch (menu) {
      case 'slash':
        return slashItems.map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.argumentHint || undefined, description: c.description?.replace(/\s*\((user|project|plugin[^)]*)\)\s*$/, '') }));
      case 'mention':
        return mentions.map((m) => ({ key: m.path, label: displayPath(m.path, state.cwd) + (m.isDirectory && !m.path.endsWith('/') ? '/' : ''), icon: m.isDirectory ? 'folder' : 'file' }));
      case 'mode':
        return state.availableModes.map((m) => ({ key: m, label: PERMISSION_MODE_LABELS[m], description: PERMISSION_MODE_DESCRIPTIONS[m], icon: MODE_ICONS[m], checked: m === state.permissionMode }));
      case 'model':
        return state.availableModels.map((m) => ({ key: m.value, label: m.displayName, description: m.description, checked: m.value === state.modelValue }));
      case 'presets':
        return (state.promptPresets ?? []).map((p, i) => ({ key: String(i), label: p.label, description: p.prompt.replace(/\s+/g, ' ').trim(), icon: 'symbol-snippet' }));
      case 'effort':
        return [
          { key: 'default', label: 'Default', description: "The model's default effort", checked: !state.effort },
          ...EFFORT_ORDER.filter((e) => (state.availableEfforts ?? []).includes(e)).map((e) => ({ key: e, label: EFFORT_LABELS[e], description: EFFORT_HINTS[e], checked: state.effort === e })),
        ];
      default:
        return [];
    }
  }, [menu, slashItems, mentions, state.availableModes, state.availableModels, state.permissionMode, state.modelValue, state.cwd, state.effort, state.availableEfforts, state.promptPresets]);

  const replaceRange = (start: number, end: number, insert: string) => {
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    saveDraft(next);
    const caret = start + insert.length;
    setTimeout(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = caret;
      refreshTrigger(next, caret);
    }, 0);
  };

  const choose = (index: number) => {
    const item = popupItems[index];
    if (!item) return;
    if (menu === 'slash' && trigger) {
      replaceRange(trigger.start, trigger.end, `/${item.key} `);
      setMenu(null);
    } else if (menu === 'mention' && trigger) {
      const m = mentions[index];
      const rel = displayPath(m.path, state.cwd);
      const insert = m.isDirectory ? `@${rel.replace(/\/?$/, '/')}` : `@${rel} `;
      replaceRange(trigger.start, trigger.end, insert);
      if (!m.isDirectory) setMenu(null);
    } else if (menu === 'mode') {
      send({ type: 'set-mode', mode: item.key as PermissionMode });
      setMenu(null);
      ta.current?.focus();
    } else if (menu === 'model') {
      send({ type: 'set-model', model: item.key });
      setMenu(null);
      ta.current?.focus();
    } else if (menu === 'presets') {
      const preset = state.promptPresets?.[Number(item.key)];
      setMenu(null);
      if (preset) {
        // The preset goes in front of whatever is already typed; the cursor ends after everything.
        const next = text.startsWith(preset.prompt) ? text : preset.prompt + text;
        setText(next);
        saveDraft(next);
        setTimeout(() => {
          const el = ta.current;
          if (!el) return;
          el.focus();
          el.selectionStart = el.selectionEnd = next.length;
        }, 0);
      }
    } else if (menu === 'effort') {
      send({ type: 'set-effort', effort: item.key as EffortLevel | 'default' });
      setMenu(null);
      ta.current?.focus();
    }
  };

  const submit = () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    send({ type: 'send', text: t, images: images.length ? images : undefined });
    store.requestScrollToBottom();
    setText('');
    saveDraft('');
    setImages([]);
    setMenu(null);
    setTrigger(undefined);
  };

  const cycleMode = () => {
    const modes = state.availableModes;
    if (!modes.length) return;
    const i = modes.indexOf(state.permissionMode);
    send({ type: 'set-mode', mode: modes[(i + 1) % modes.length] });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const popupOpen = isButtonMenu(menu) || ((menu === 'slash' || menu === 'mention') && !!trigger);
    if (popupOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (popupItems.length ? (a + 1) % popupItems.length : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (popupItems.length ? (a - 1 + popupItems.length) % popupItems.length : 0));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && popupItems.length > 0) {
        e.preventDefault();
        choose(active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      send({ type: 'interrupt' });
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(isImageFile);
    const out: ImageAttachment[] = [];
    for (const f of list) {
      const a = await fileToAttachment(f);
      if (a) out.push(a);
    }
    if (out.length) setImages((cur) => [...cur, ...out].slice(0, 20));
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files ?? []);
    const imgs = files.filter(isImageFile);
    if (imgs.length) {
      void addFiles(imgs);
      return;
    }
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    const paths = uris
      .map((u) => {
        try {
          return u.startsWith('file:') ? decodeURIComponent(new URL(u).pathname) : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is string => !!p);
    if (paths.length) {
      const insert = paths.map((p) => `@${displayPath(p, state.cwd)}`).join(' ') + ' ';
      const el = ta.current;
      const pos = el ? el.selectionStart : text.length;
      replaceRange(pos, pos, (pos > 0 && !/\s$/.test(text.slice(0, pos)) ? ' ' : '') + insert);
    }
  };

  const modelLabel = state.modelLabel || state.availableModels.find((m) => m.value === state.modelValue)?.displayName || 'Default model';
  const placeholder = busy ? 'Queue another message…' : state.status === 'new' ? 'Ask Claude to edit…' : 'Reply to Claude…';

  return (
    <div class="composer-wrap">
      {menu && (isButtonMenu(menu) || trigger) ? (
        <Popup
          title={menu === 'slash' ? 'Commands' : menu === 'mention' ? 'Files' : menu === 'mode' ? 'Mode' : menu === 'effort' ? 'Effort' : menu === 'presets' ? 'Prompt presets' : 'Model'}
          items={popupItems}
          active={active}
          onSelect={choose}
          onHover={setActive}
          align={menu === 'model' || menu === 'effort' ? 'right' : menu === 'mode' || menu === 'presets' ? 'left' : 'full'}
          empty={menu === 'mention' ? (mentionLoading ? 'Searching…' : 'No matching files') : menu === 'slash' ? 'No matching commands' : 'Nothing to choose'}
          footer={menu === 'mode' ? <span><kbd>⇧</kbd><kbd>Tab</kbd> to switch modes</span> : menu === 'effort' ? <span>Applies from Claude's next reply</span> : menu === 'presets' ? <span>Edit presets in Settings › Claude Projects › Prompt Presets</span> : undefined}
        />
      ) : null}
      <div
        class={`composer${dragOver ? ' is-drag' : ''}`}
        data-mode={state.permissionMode}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop as unknown as (e: Event) => void}
      >
        {images.length ? (
          <div class="composer-attachments">
            <ImageThumbs images={images} onRemove={(i) => setImages((cur) => cur.filter((_, j) => j !== i))} />
          </div>
        ) : null}
        <textarea
          ref={ta}
          class="composer-input"
          rows={1}
          placeholder={placeholder}
          value={text}
          aria-label="Message Claude"
          onInput={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            setText(el.value);
            saveDraft(el.value);
            if (isButtonMenu(menu)) setMenu(null);
            refreshTrigger(el.value, el.selectionStart);
          }}
          onKeyDown={onKeyDown as unknown as (e: Event) => void}
          onKeyUp={(e) => {
            const k = (e as KeyboardEvent).key;
            if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
              const el = e.currentTarget as HTMLTextAreaElement;
              refreshTrigger(el.value, el.selectionStart);
            }
          }}
          onClick={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            refreshTrigger(el.value, el.selectionStart);
          }}
          onPaste={onPaste as unknown as (e: Event) => void}
        />
        <div class="composer-bar">
          <button
            type="button"
            class={`bar-btn mode-btn mode-${state.permissionMode}`}
            title={`${PERMISSION_MODE_LABELS[state.permissionMode]}: ${PERMISSION_MODE_DESCRIPTIONS[state.permissionMode]} (Shift+Tab to switch)`}
            onClick={() => {
              setActive(Math.max(0, state.availableModes.indexOf(state.permissionMode)));
              setMenu(menu === 'mode' ? null : 'mode');
            }}
          >
            <Icon name={MODE_ICONS[state.permissionMode]} />
            <span class="bar-label">{PERMISSION_MODE_LABELS[state.permissionMode]}</span>
          </button>
          {state.canAttachImages ? (
            <button type="button" class="bar-btn bar-icon" title="Attach images" aria-label="Attach images" onClick={() => fileInput.current?.click()}>
              <Icon name="attach" />
            </button>
          ) : null}
          <button
            type="button"
            class="bar-btn bar-icon"
            title="Mention a file (@)"
            aria-label="Mention a file"
            onClick={() => {
              const el = ta.current;
              const pos = el ? el.selectionStart : text.length;
              const pre = pos > 0 && !/\s$/.test(text.slice(0, pos)) ? ' @' : '@';
              replaceRange(pos, pos, pre);
            }}
          >
            <Icon name="mention" />
          </button>
          <button
            type="button"
            class="bar-btn bar-icon"
            title="Commands and skills (/)"
            aria-label="Commands"
            onClick={() => {
              if (!text.startsWith('/')) replaceRange(0, 0, '/');
              else ta.current?.focus();
            }}
          >
            <span class="slash-glyph">/</span>
          </button>
          {state.promptPresets?.length ? (
            <button
              type="button"
              class="bar-btn bar-icon presets-btn"
              title="Prompt presets"
              aria-label="Prompt presets"
              onClick={() => {
                setActive(0);
                setMenu(menu === 'presets' ? null : 'presets');
              }}
            >
              <Icon name="symbol-snippet" />
            </button>
          ) : null}
          <button
            type="button"
            class={`bar-btn bar-icon auto-btn${state.autoContinue ? ' is-on' : ''}`}
            aria-pressed={state.autoContinue}
            title={
              state.autoContinue
                ? 'Continue automatically when usage limits reset: on. If this chat stops at a limit, it sends “continue” once the limit resets. Click to turn off.'
                : 'Continue automatically when usage limits reset: off. Click to turn on.'
            }
            aria-label="Continue automatically when usage limits reset"
            onClick={() => send({ type: 'set-auto-continue', on: !state.autoContinue })}
          >
            <Icon name="debug-continue" />
          </button>
          <span class="bar-spacer" />
          {state.contextUsage?.percent !== undefined ? <ContextRing percent={state.contextUsage.percent} used={state.contextUsage.usedTokens} max={state.contextUsage.maxTokens} /> : null}
          {state.availableModels.length ? (
            <button
              type="button"
              class="bar-btn model-btn"
              title="Choose model"
              onClick={() => {
                setActive(Math.max(0, state.availableModels.findIndex((m) => m.value === state.modelValue)));
                setMenu(menu === 'model' ? null : 'model');
              }}
            >
              <span class="bar-label">{modelLabel}</span>
              <Icon name="chevron-down" class="bar-caret" />
            </button>
          ) : state.modelLabel ? (
            <span class="bar-static" title="Model">
              {state.modelLabel}
            </span>
          ) : null}
          {(state.availableEfforts ?? []).length ? (
            <button
              type="button"
              class="bar-btn effort-btn"
              title={`Effort: ${state.effort ? EFFORT_LABELS[state.effort] : 'model default'}. Click to change.`}
              aria-label="Choose effort"
              onClick={() => {
                const keys = ['default', ...EFFORT_ORDER.filter((e) => (state.availableEfforts ?? []).includes(e))];
                setActive(Math.max(0, keys.indexOf(state.effort ?? 'default')));
                setMenu(menu === 'effort' ? null : 'effort');
              }}
            >
              <EffortGauge level={state.effort} />
              <span class="bar-label">{state.effort ? EFFORT_LABELS[state.effort] : 'Effort'}</span>
            </button>
          ) : null}
          {busy && !hasContent ? (
            <button type="button" class="send-btn is-stop" title="Stop (Esc)" aria-label="Stop" data-mode={state.permissionMode} onClick={() => send({ type: 'interrupt' })}>
              <Icon name="primitive-square" />
            </button>
          ) : (
            <button type="button" class="send-btn" title={busy ? 'Queue message (Enter)' : 'Send (Enter)'} aria-label="Send" data-mode={state.permissionMode} disabled={!hasContent} onClick={submit}>
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          class="hidden-input"
          onChange={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            if (el.files) void addFiles(el.files);
            el.value = '';
          }}
        />
      </div>
    </div>
  );
}
