import type { ChatToExtMessage } from '../../../shared/protocol';
import { post } from '../../common/vscodeApi';

export function send(msg: ChatToExtMessage): void {
  post<ChatToExtMessage>(msg);
}

export function openFile(path: string, line?: number): void {
  send({ type: 'open-file', path, line });
}

export function openDiff(toolUseId: string): void {
  send({ type: 'open-diff', toolUseId });
}

export function openUrl(url: string): void {
  send({ type: 'open-url', url });
}

export function copyText(text: string): void {
  send({ type: 'copy', text });
  // Also try the browser clipboard (works in recent VS Code webviews); the extension copy is the fallback.
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  } catch {
    // ignore
  }
}
