import { readFileSync } from 'node:fs';

/**
 * The shared .env file for Open Here chats: variables every chat's Claude
 * process gets in its environment, so commands can use them ("$API_KEY")
 * without the values being pasted into the conversation.
 */
export interface GlobalEnv {
  vars: Record<string, string>;
  /** Names that were left out, with why. */
  skipped: { name: string; reason: string }[];
}

/**
 * Names that would change how Claude Code itself runs (or break the shell)
 * are never taken from the file. ANTHROPIC_API_KEY in particular would switch
 * Claude Code from the subscription to API billing.
 */
export function reservedName(name: string): string | undefined {
  if (/^(ANTHROPIC|CLAUDE|CLAUDECODE)_|^CLAUDECODE$/.test(name)) return 'used by Claude Code itself';
  if (['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TMPDIR', 'NODE_OPTIONS'].includes(name)) return 'needed by the system';
  return undefined;
}

/** Parses .env text: KEY=value, optional "export", quotes, # comments. */
export function parseEnv(text: string): GlobalEnv {
  const vars: Record<string, string> = {};
  const skipped: GlobalEnv['skipped'] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    let value = m[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const q = value[0];
      let body = value.slice(1);
      // A quoted value may continue over several lines.
      while (!body.includes(q) && i + 1 < lines.length) body += '\n' + lines[++i];
      const end = body.indexOf(q);
      value = end >= 0 ? body.slice(0, end) : body;
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    const reason = reservedName(name);
    if (reason) skipped.push({ name, reason });
    else vars[name] = value;
  }
  return { vars, skipped };
}

export function readGlobalEnv(path: string): GlobalEnv | undefined {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** What Claude is told about the shared variables (names only, never values). */
export function globalEnvPrompt(names: string[]): string {
  return [
    'Shared environment variables are set in this session (from the user\'s global .env file):',
    names.map((n) => `- ${n}`).join('\n'),
    'Their values are secret. Use them by reference: "$NAME" in shell commands, or read them from the environment in code (os.environ, process.env…).',
    'Never print, echo, log or display their values, never write them into files, commits or messages, and never ask the user for them.',
    'If a project needs one in its own .env, write a reference to it (for example API_KEY=${API_KEY}) or tell the user, instead of copying the value.',
  ].join('\n');
}

export const GLOBAL_ENV_TEMPLATE = `# Shared variables for Claude Projects "Open Here" chats.
#
# Every chat's Claude process gets these in its environment, so Claude can use
# them in commands ("$MY_API_KEY") without the values being written into the
# chat. Claude is told the names, not the values. New chats (and chats restarted
# after an edit) pick up changes.
#
# Names starting with ANTHROPIC_ or CLAUDE_, and PATH/HOME/SHELL, are ignored:
# they would change how Claude Code itself runs.
#
# MY_API_KEY=sk-...
# SHARED_SERVER_URL=https://example.com
`;
