import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import type { AssistantTextItem, ChatItem, ImageAttachment, SystemItem, ThinkingItem, TurnEndItem, UserItem } from '../../../shared/protocol';
import { clockTime, formatDuration } from '../lib/format';
import { attachmentSrc } from '../lib/images';
import { useExpanded } from '../ui';
import { Markdown } from './Markdown';
import { ToolCall } from './ToolCall';
import { Icon } from './ui';

export function ImageThumbs({ images, onRemove }: { images: ImageAttachment[]; onRemove?: (index: number) => void }) {
  const [zoom, setZoom] = useState<ImageAttachment | undefined>();
  return (
    <>
      <div class="thumbs">
        {images.map((img, i) => (
          <div class="thumb" key={i} title={img.name}>
            <img src={attachmentSrc(img)} alt={img.name ?? 'image'} onClick={() => setZoom(img)} />
            {onRemove ? (
              <button type="button" class="thumb-remove" title="Remove image" aria-label="Remove image" onClick={() => onRemove(i)}>
                <Icon name="close" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {zoom ? (
        <div class="lightbox" onClick={() => setZoom(undefined)} role="dialog" aria-label="Image preview">
          <img src={attachmentSrc(zoom)} alt={zoom.name ?? 'image'} />
        </div>
      ) : null}
    </>
  );
}

export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  let text = item.text;
  let command = item.command;
  if (command && text.trim().startsWith(command)) {
    text = text.trim().slice(command.length).trim();
  }
  if (command) {
    const parts = command.trim().split(/\s+/);
    command = parts[0];
    if (parts.length > 1 && !text) text = parts.slice(1).join(' ');
  }
  return (
    <div class={`msg-user${item.queued ? ' is-queued' : ''}`} title={item.timestamp ? clockTime(item.timestamp) : undefined}>
      <div class="user-bubble">
        {item.queued ? (
          <span class="queued-badge">
            <Icon name="clock" /> Queued
          </span>
        ) : null}
        {command ? <span class="cmd-chip">{command.startsWith('/') ? command : '/' + command}</span> : null}
        {text ? <span class="user-text">{text}</span> : null}
        {item.images?.length ? <ImageThumbs images={item.images} /> : null}
      </div>
    </div>
  );
});

export const AssistantText = memo(function AssistantText({ item }: { item: AssistantTextItem }) {
  if (!item.text.trim() && !item.streaming) return null;
  return (
    <div class={`tl text${item.streaming ? ' is-streaming' : ''}`}>
      <Markdown text={item.text} streaming={!!item.streaming} />
    </div>
  );
});

export const Thinking = memo(function Thinking({ item }: { item: ThinkingItem }) {
  const hasText = item.text.trim().length > 0;
  const [open, toggle] = useExpanded(`thinking:${item.id}`, false);
  return (
    <div class={`tl thinking${item.streaming ? ' is-streaming' : ''}${open ? ' is-open' : ''}`}>
      <div class={`thinking-head${hasText ? ' clickable' : ''}`} onClick={hasText ? () => toggle() : undefined} role={hasText ? 'button' : undefined} aria-expanded={hasText ? open : undefined}>
        <span class="thinking-label">{item.streaming ? 'Thinking' : 'Thought'}</span>
        {item.streaming ? <span class="dots" aria-hidden="true" /> : null}
        {hasText ? <Icon name="chevron-right" class="thinking-chevron" /> : null}
      </div>
      {open && hasText ? (
        <div class="thinking-body">
          <Markdown text={item.text} streaming={!!item.streaming} />
        </div>
      ) : null}
    </div>
  );
});

export const SystemNotice = memo(function SystemNotice({ item }: { item: SystemItem }) {
  switch (item.tag) {
    case 'compact':
    case 'resumed':
    case 'forked':
      return (
        <div class="divider">
          <span>
            <Icon name={item.tag === 'compact' ? 'fold' : item.tag === 'forked' ? 'repo-forked' : 'history'} /> {item.text}
          </span>
        </div>
      );
    case 'interrupted':
      return (
        <div class="sys sys-interrupted">
          <span class="elbow">⎿</span> {item.text}
        </div>
      );
    case 'command-output':
      return (
        <div class="sys sys-output">
          <pre>{item.text}</pre>
        </div>
      );
    case 'mode':
    case 'model':
      return (
        <div class="sys sys-center">
          <Icon name={item.tag === 'mode' ? 'shield' : 'sparkle'} /> {item.text}
        </div>
      );
    case 'retry':
      return (
        <div class="sys sys-warning">
          <Icon name="sync" /> {item.text}
        </div>
      );
  }
  if (item.level === 'error') {
    return (
      <div class="sys sys-error">
        <Icon name="error" />
        <span class="sys-text">{item.text}</span>
      </div>
    );
  }
  if (item.level === 'warning') {
    return (
      <div class="sys sys-warning">
        <Icon name="warning" />
        <span class="sys-text">{item.text}</span>
      </div>
    );
  }
  return (
    <div class="sys sys-info">
      <Icon name="info" />
      <span class="sys-text">{item.text}</span>
    </div>
  );
});

export const TurnEnd = memo(function TurnEnd({ item }: { item: TurnEndItem }) {
  if (item.isError) {
    return (
      <div class="sys sys-error">
        <Icon name="error" />
        <span class="sys-text">{item.errorText || 'The turn ended with an error.'}</span>
      </div>
    );
  }
  if (!item.durationMs || item.durationMs < 10_000) return null;
  return (
    <div class="turn-end">
      <span class="turn-end-glyph">✻</span> Worked for {formatDuration(item.durationMs)}
    </div>
  );
});

/** Renders one chat item. `kids` are nested subagent items for Task/Agent tools. */
export function ItemView({ item, kids }: { item: ChatItem; kids?: ChatItem[] }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />;
    case 'text':
      return <AssistantText item={item} />;
    case 'thinking':
      return <Thinking item={item} />;
    case 'tool':
      return <ToolCall item={item} kids={kids} />;
    case 'system':
      return <SystemNotice item={item} />;
    case 'turn-end':
      return <TurnEnd item={item} />;
    default:
      return null;
  }
}
