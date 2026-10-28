import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchFor, quoteForCmd, setEnv, shimTarget } from '../../src/claude/launch';
import { reservedName } from '../../src/sessions/globalEnv';

// npm's cmd-shim output for a script and for a native binary.
const JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;
const EXE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

describe('launching claude', () => {
  it('runs the CLI directly outside Windows', () => {
    expect(launchFor('/usr/local/bin/claude', ['-p'], 'darwin')).toEqual({ command: '/usr/local/bin/claude', args: ['-p'] });
    expect(launchFor('C:\\x\\claude.exe', ['-p'], 'win32')).toEqual({ command: 'C:\\x\\claude.exe', args: ['-p'] });
  });

  it('finds what an npm shim runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-shim-'));
    // On macOS/Linux the backslashes in the shim are just characters; build the target with them.
    const pkg = join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(pkg, { recursive: true });
    const sep = process.platform === 'win32' ? '\\' : '/';
    const asShim = (s: string) => (sep === '/' ? s.replace(/\\/g, '/') : s);
    writeFileSync(join(pkg, 'cli.js'), '');
    expect(shimTarget(join(dir, 'claude.cmd'), () => asShim(JS_SHIM))).toBe(join(pkg, 'cli.js'));
    mkdirSync(join(pkg, 'bin'));
    writeFileSync(join(pkg, 'bin', 'claude.exe'), '');
    expect(shimTarget(join(dir, 'claude.cmd'), () => asShim(EXE_SHIM))).toBe(join(pkg, 'bin', 'claude.exe'));
    expect(shimTarget(join(dir, 'missing.cmd'))).toBeUndefined();
    expect(shimTarget(join(dir, 'claude.cmd'), () => '@echo off\r\nclaude-real %*')).toBeUndefined();
  });

  it('quotes arguments for cmd.exe', () => {
    expect(quoteForCmd('stream-json', false)).toBe('^"stream-json^"');
    expect(quoteForCmd('a b', false)).toBe('^"a^ b^"');
    expect(quoteForCmd('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(quoteForCmd('a&b', true)).toBe('^^^"a^^^&b^^^"');
  });

  it('sets env vars once on Windows', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\old', Other: '1' };
    setEnv(env, 'PATH', 'C:\\new', 'win32');
    expect(env).toEqual({ PATH: 'C:\\new', Other: '1' });
    const mac: NodeJS.ProcessEnv = { Path: '/old' };
    setEnv(mac, 'PATH', '/new', 'darwin');
    expect(mac).toEqual({ Path: '/old', PATH: '/new' });
  });

  it('keeps system variables out of the shared .env in any case', () => {
    expect(reservedName('Path')).toBeDefined();
    expect(reservedName('anthropic_api_key')).toBeDefined();
    expect(reservedName('USERPROFILE')).toBeDefined();
    expect(reservedName('MY_TOKEN')).toBeUndefined();
  });
});
