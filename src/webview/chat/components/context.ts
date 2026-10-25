import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import type { ChatItem } from '../../../shared/protocol';

export interface ChatContextValue {
  cwd: string;
  /** Items whose parentToolUseId is the given tool id (subagent output). */
  childrenOf: (toolUseId: string) => ChatItem[] | undefined;
  /** Renders a list of items (used for nested subagent timelines). */
  renderItems: (items: ChatItem[], nested: boolean) => ComponentChildren;
}

export const ChatContext = createContext<ChatContextValue>({
  cwd: '',
  childrenOf: () => undefined,
  renderItems: () => null,
});
