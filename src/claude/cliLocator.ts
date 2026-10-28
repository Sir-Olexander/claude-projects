import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { run } from '../util/exec';
import { expandHome } from '../util/paths';

const isWindows = process.platform === 'win32';

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    // Windows has no execute bit; the file extension decides (scripts run with node, see launch.ts).
    if (isWindows) return /\.(exe|cmd|bat|js|mjs|cjs)$/i.test(p);
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** File names a command can have: "claude", or on Windows claude.exe, then claude.cmd/.bat (npm's shims). */
function commandNames(name: string): string[] {
  return isWindows ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
}

function findOnPath(name: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of commandNames(name)) {
      const candidate = join(dir.replace(/^"(.*)"$/, '$1'), n);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Windows' PATH variable is spelled "Path"; process.env ignores case there, a copied object does not. */
function currentPath(): string | undefined {
  return process.env.PATH ?? process.env.Path;
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
      const candidate = join(root, d, 'resources', 'native-binary', isWindows ? 'claude.exe' : 'claude');
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
  // Windows apps get the full user PATH from the registry; there is no login shell to ask.
  if (isWindows) return loginShellPath;
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
    const p = expandHome(setting.replace(/^"(.*)"$/, '$1'));
    if (isExecutable(p)) return { path: p, source: 'setting' };
    // On Windows, accept the path without its extension too.
    if (isWindows) for (const ext of ['.exe', '.cmd', '.bat']) if (isExecutable(p + ext)) return { path: p + ext, source: 'setting' };
  }
  const onPath = findOnPath('claude', currentPath());
  if (onPath) return { path: onPath, source: 'path' };
  for (const k of knownLocations()) if (isExecutable(k)) return { path: k, source: 'known-location' };
  const shellPath = await getLoginShellPath();
  const fromShell = findOnPath('claude', shellPath);
  if (fromShell) return { path: fromShell, source: 'login-shell' };
  const bundled = bundledWithOfficialExtension();
  if (bundled) return { path: bundled, source: 'official-extension' };
  return undefined;
}

/** Where the installers put `claude`. */
function knownLocations(): string[] {
  const home = homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      // Native installer (install.ps1 / install.cmd)
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.cmd'),
      // npm install -g
      join(appData, 'npm', 'claude.cmd'),
      join(home, '.bun', 'bin', 'claude.exe'),
      join(home, 'scoop', 'shims', 'claude.exe'),
      join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
      join(localAppData, 'pnpm', 'claude.cmd'),
      join(localAppData, 'Volta', 'bin', 'claude.exe'),
    ];
  }
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
  ];
}

/** PATH to give child processes: current PATH plus the login shell's (deduplicated). */
export async function childPath(): Promise<string> {
  const parts = (currentPath() ?? '').split(delimiter).filter(Boolean);
  const has = (p: string) => parts.some((x) => (isWindows ? x.toLowerCase() === p.toLowerCase() : x === p));
  const shell = await getLoginShellPath();
  for (const p of (shell ?? '').split(delimiter)) if (p && !has(p)) parts.push(p);
  const extra = isWindows ? [join(homedir(), '.local', 'bin')] : [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const p of extra) if (!has(p)) parts.push(p);
  return parts.join(delimiter);
}
