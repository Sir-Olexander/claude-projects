import { basename } from 'node:path';
import type { PermissionOption } from '../shared/protocol';
import type { PermissionUpdate } from '../claude/sdkTypes';

/** "npm test:*" -> "npm test commands", "echo hi *" -> "echo hi commands", "git status" -> "git status". */
function describeBashRule(content: string): string {
  const prefix = content.replace(/(:\*|\s\*)$/, '');
  return prefix !== content ? `${prefix} commands` : content;
}

function describeRule(r: { toolName: string; ruleContent?: string }): string {
  if (!r.ruleContent) return r.toolName === 'Bash' ? 'Bash commands' : `${r.toolName}`;
  if (r.toolName === 'Bash') return describeBashRule(r.ruleContent);
  if (r.toolName === 'WebFetch' && r.ruleContent.startsWith('domain:')) return `fetches from ${r.ruleContent.slice(7)}`;
  return `${r.toolName}(${r.ruleContent})`;
}

function where(dest: PermissionUpdate['destination'], cwd: string): string {
  switch (dest) {
    case 'localSettings':
    case 'projectSettings':
      return ` in ${basename(cwd) || 'this project'}`;
    case 'userSettings':
      return ' in all projects';
    default:
      return ' during this session';
  }
}

/**
 * The options shown on a permission card, built from the CLI's
 * permission_suggestions the way Claude Code's own prompt words them.
 */
export function permissionOptions(suggestions: PermissionUpdate[] | undefined, cwd: string, suppressAlways: boolean | undefined): PermissionOption[] {
  const options: PermissionOption[] = [{ id: 'allow', label: 'Yes', kind: 'allow' }];
  if (suppressAlways || !suggestions?.length) return options;

  const setMode = suggestions.find((s) => s.type === 'setMode');
  if (setMode?.mode === 'acceptEdits') {
    options.push({ id: 'allow-always', label: 'Yes, allow all edits during this session', kind: 'allow-always' });
    return options;
  }
  const parts: string[] = [];
  for (const s of suggestions) {
    if ((s.type === 'addRules' || s.type === 'replaceRules') && s.behavior !== 'deny' && s.rules?.length) {
      parts.push(`${s.rules.map(describeRule).join(', ')}${where(s.destination, cwd)}`);
    } else if (s.type === 'addDirectories' && s.directories?.length) {
      const dirs = s.directories.map((d) => basename(d) || d).join(', ');
      parts.push(`access to ${dirs}${s.destination === 'session' ? ' during this session' : where(s.destination, cwd)}`);
    } else if (s.type === 'setMode' && s.mode) {
      parts.push(`switching to ${s.mode} mode`);
    }
  }
  if (parts.length) options.push({ id: 'allow-always', label: `Yes, and don't ask again for ${parts.join(' and ')}`, kind: 'allow-always' });
  return options;
}

export const DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export function denyWithFeedback(feedback: string): string {
  return `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${feedback}`;
}

/** Strips ANSI escapes and control characters from CLI-provided text before display. */
export function sanitizeDisplay(s: string | undefined): string | undefined {
  if (!s) return s;
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
