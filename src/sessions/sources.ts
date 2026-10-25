import { SESSION_SOURCE_LABELS, type SessionSource } from '../shared/protocol';

/** Maps Claude Code's `entrypoint` to where the session runs. */
export function sourceOf(entrypoint: string | undefined, kind?: string): { source: SessionSource; label: string } {
  let source: SessionSource;
  switch (entrypoint) {
    case 'cli':
      source = 'terminal';
      break;
    case 'claude-vscode':
      source = 'vscode';
      break;
    case 'claude-desktop':
    case 'claude-desktop-3p':
    case 'local-agent':
    case 'local_agent':
      source = 'desktop';
      break;
    case 'sdk-ts':
    case 'sdk-py':
    case 'sdk-cli':
      source = 'sdk';
      break;
    default:
      source = kind && kind !== 'interactive' ? 'other' : entrypoint ? 'other' : 'terminal';
  }
  return { source, label: SESSION_SOURCE_LABELS[source] };
}
