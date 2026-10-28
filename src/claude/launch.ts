import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const SCRIPT_EXT = ['.js', '.mjs', '.cjs'];

/** How to start a program: the command, arguments to put before the caller's, and spawn flags. */
export interface Launch {
  command: string;
  args: string[];
  /** Arguments are already quoted for cmd.exe (Windows only). */
  windowsVerbatimArguments?: boolean;
}

/**
 * How to run the `claude` CLI at `cliPath` with `args`.
 *
 * On Windows, npm installs `claude.cmd`, a batch file. Node cannot start batch
 * files without a shell, so we read the shim and run what it points at
 * (claude.exe, or node with cli.js). Only when the shim cannot be read do we go
 * through cmd.exe, with every argument quoted for it.
 */
export function launchFor(cliPath: string, args: string[], platform: NodeJS.Platform = process.platform): Launch {
  if (platform !== 'win32') return { command: cliPath, args };
  const ext = extname(cliPath).toLowerCase();
  // A script (e.g. the tests' fake CLI): Windows can't run it directly.
  if (SCRIPT_EXT.includes(ext)) return { command: 'node', args: [cliPath, ...args] };
  if (ext !== '.cmd' && ext !== '.bat') return { command: cliPath, args };
  const target = shimTarget(cliPath);
  if (target) {
    const targetExt = extname(target).toLowerCase();
    if (targetExt === '.exe') return { command: target, args };
    const localNode = resolve(dirname(cliPath), 'node.exe');
    return { command: existsSync(localNode) ? localNode : 'node', args: [target, ...args] };
  }
  return viaCmd(cliPath, args);
}

/** What an npm/pnpm/yarn .cmd shim runs: the last "%dp0%\…" path ending in .exe or a script. */
export function shimTarget(shimPath: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | undefined {
  let text: string;
  try {
    text = read(shimPath);
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const m of text.matchAll(/"%~?dp0%?[\\/]?([^"%]+\.(?:exe|js|mjs|cjs))"/gi)) found = m[1];
  if (!found) return undefined;
  const target = resolve(dirname(shimPath), found);
  return existsSync(target) ? target : undefined;
}

// Characters cmd.exe treats specially; escaped with ^.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for a program started through cmd.exe (same rules as cross-spawn). */
export function quoteForCmd(arg: string, isBatchFile: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(CMD_META, '^$1');
  // A batch file re-parses its arguments once more.
  if (isBatchFile) a = a.replace(CMD_META, '^$1');
  return a;
}

function viaCmd(file: string, args: string[]): Launch {
  // A line break would end the cmd.exe command line.
  const line = [file.replace(CMD_META, '^$1'), ...args.map((a) => quoteForCmd(a.replace(/\r?\n/g, ' '), true))].join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * Sets an environment variable in an env object meant for a child process.
 * Windows variable names ignore case, and process.env has "Path", so a plain
 * env.PATH = … would leave two PATHs for the child to pick from.
 */
export function setEnv(env: NodeJS.ProcessEnv, name: string, value: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    const upper = name.toUpperCase();
    for (const k of Object.keys(env)) if (k !== name && k.toUpperCase() === upper) delete env[k];
  }
  env[name] = value;
}
