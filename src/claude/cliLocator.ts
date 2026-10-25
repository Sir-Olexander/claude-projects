import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { run } from '../util/exec';
import { expandHome } from '../util/paths';

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Binary bundled with the official Claude Code extension (newest version first). */
function bundledWithOfficialExtension(): string | undefined {
  const roots = [join(homedir(), '.vscode', 'extensions'), join(homedir(), '.vscode-insiders', 'extensions'), join(homedir(), '.cursor', 'extensions')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-'));
    } catch {
      continue;
    }
    dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      const candidate = join(root, d, 'resources', 'native-binary', 'claude');
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

let loginShellPath: string | undefined | null = null;

/** PATH from the user's login shell (VS Code launched from the Dock may have a short PATH). */
async function getLoginShellPath(): Promise<string | undefined> {
  if (loginShellPath !== null) return loginShellPath;
  loginShellPath = undefined;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const r = await run(shell, ['-l', '-c', 'printf "%s" "$PATH"'], { timeoutMs: 5000 });
    if (r.code === 0 && r.stdout.trim()) loginShellPath = r.stdout.trim();
  } catch {
    // ignore
  }
  return loginShellPath;
}

export interface CliLocation {
  path: string;
  source: 'setting' | 'path' | 'known-location' | 'login-shell' | 'official-extension';
}

/**
 * Finds the `claude` CLI. Order: the user's setting, the current PATH, common
 * install locations, the login shell's PATH, then the binary bundled with the
 * official extension.
 */
export async function locateClaude(configured: string | undefined): Promise<CliLocation | undefined> {
  const setting = configured?.trim();
  if (setting) {
    const p = expandHome(setting);
    if (isExecutable(p)) return { path: p, source: 'setting' };
  }
  const onPath = findOnPath('claude', process.env.PATH);
  if (onPath) return { path: onPath, source: 'path' };
  const known = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(homedir(), '.npm-global', 'bin', 'claude'),
    join(homedir(), '.bun', 'bin', 'claude'),
  ];
  for (const k of known) if (isExecutable(k)) return { path: k, source: 'known-location' };
  const shellPath = await getLoginShellPath();
  const fromShell = findOnPath('claude', shellPath);
  if (fromShell) return { path: fromShell, source: 'login-shell' };
  const bundled = bundledWithOfficialExtension();
  if (bundled) return { path: bundled, source: 'official-extension' };
  return undefined;
}

/** PATH to give child processes: current PATH plus the login shell's (deduplicated). */
export async function childPath(): Promise<string> {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const shell = await getLoginShellPath();
  for (const p of (shell ?? '').split(delimiter)) if (p && !parts.includes(p)) parts.push(p);
  for (const p of [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) if (!parts.includes(p)) parts.push(p);
  return parts.join(delimiter);
}
