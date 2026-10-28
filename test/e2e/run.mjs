// Runs test/e2e/suite.ts inside the installed VS Code with a throwaway profile.
//   node test/e2e/run.mjs
// (Build first: npm run build.) Uses VS Code at $VSCODE_PATH, else on macOS
// /Applications/Visual Studio Code.app, else a copy @vscode/test-electron downloads. Uses the fake Claude CLI and a temporary CLAUDE_CONFIG_DIR.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const { runTests } = require('@vscode/test-electron');

const here = dirname(fileURLToPath(import.meta.url));
const real = process.argv.includes('--real');
const visual = process.argv.includes('--visual') || real;
const cdpPort = 9339;
const root = join(here, '..', '..');
// .native: on Windows it also expands 8.3 short names (C:\Users\RUNNER~1), like the extension does.
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-e2e-')));
const repo = join(base, 'repo');
const claudeHome = join(base, 'claude-home');
mkdirSync(repo);
mkdirSync(join(claudeHome, 'sessions'), { recursive: true });

// A small repo with a worktree.
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'Test');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'a.txt'), 'one\n');
git('add', '-A');
git('commit', '-q', '-m', 'Initial commit');
mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
appendFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/worktrees/\n');
git('worktree', 'add', '-q', '-b', 'feature-x', join(repo, '.claude', 'worktrees', 'feature-x'));
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');

// A second project for the visual pass.
const repo2 = join(base, 'web-app');
mkdirSync(repo2);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo2 });

// An existing session transcript for the repo.
const sessionId = '44444444-4444-4444-4444-444444444444';
const enc = repo.replace(/[^a-zA-Z0-9]/g, '-');
mkdirSync(join(claudeHome, 'projects', enc), { recursive: true });
const t = '2026-10-20T10:00:00.000Z';
const lines = [
  { type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd: repo, gitBranch: 'main', timestamp: t, message: { role: 'user', content: 'Earlier question' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: repo, gitBranch: 'main', timestamp: t, message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Earlier answer' }] } },
  { type: 'ai-title', aiTitle: 'E2E existing session', sessionId },
];
if (visual) {
  const T = (i) => `2026-10-20T10:0${i}:00.000Z`;
  const base0 = { sessionId, cwd: repo, gitBranch: 'main' };
  let parent = 'a1';
  const add = (o) => {
    lines.push({ ...base0, ...o, parentUuid: parent });
    parent = o.uuid;
  };
  add({ type: 'user', uuid: 'u2', timestamp: T(1), message: { role: 'user', content: 'Add input validation to the signup form and make sure the tests pass.' } });
  add({ type: 'assistant', uuid: 'a2', timestamp: T(1), message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'The form lives in src/signup.ts. I should read it first, then add a validate() helper and update the tests.' }] } });
  add({ type: 'assistant', uuid: 'a3', timestamp: T(1), message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: "I'll start by reading the signup form." }] } });
  add({ type: 'assistant', uuid: 'a4', timestamp: T(1), message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: join(repo, 'src', 'signup.ts') } }] } });
  add({ type: 'user', uuid: 'r4', timestamp: T(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read1', content: '1\texport function signup(email: string) {\n2\t  return api.post(email);\n3\t}' }] }, toolUseResult: { type: 'text', file: { filePath: join(repo, 'src', 'signup.ts'), numLines: 3, startLine: 1, totalLines: 3 } } });
  add({ type: 'assistant', uuid: 'a5', timestamp: T(2), message: { id: 'm3', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [{ content: 'Add validate() helper', status: 'completed', activeForm: 'Adding validate() helper' }, { content: 'Call it from signup()', status: 'in_progress', activeForm: 'Calling it from signup()' }, { content: 'Run the test suite', status: 'pending', activeForm: 'Running the test suite' }] } }] } });
  add({ type: 'user', uuid: 'r5', timestamp: T(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_todo', content: 'Todos updated' }] } });
  add({ type: 'assistant', uuid: 'a6', timestamp: T(3), message: { id: 'm4', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_edit1', name: 'Edit', input: { file_path: join(repo, 'src', 'signup.ts'), old_string: 'export function signup(email: string) {\n  return api.post(email);', new_string: 'export function signup(email: string) {\n  if (!isValidEmail(email)) throw new Error(\'Invalid email\');\n  return api.post(email.trim());' } }] } });
  add({ type: 'user', uuid: 'r6', timestamp: T(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit1', content: 'The file was updated.' }] }, toolUseResult: { filePath: join(repo, 'src', 'signup.ts'), structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' export function signup(email: string) {', '-  return api.post(email);', "+  if (!isValidEmail(email)) throw new Error('Invalid email');", '+  return api.post(email.trim());', ' }'] }] } });
  add({ type: 'assistant', uuid: 'a7', timestamp: T(4), message: { id: 'm5', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'npm test -- signup', description: 'Run the signup tests' } }] } });
  add({ type: 'user', uuid: 'r7', timestamp: T(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: 'PASS  src/signup.test.ts\n  ✓ rejects invalid emails (3 ms)\n  ✓ trims whitespace (1 ms)\n\nTests: 2 passed, 2 total' }] }, toolUseResult: { stdout: 'PASS', stderr: '', interrupted: false } });
  add({ type: 'assistant', uuid: 'a8', timestamp: T(5), message: { id: 'm6', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done. `signup()` now rejects invalid emails and trims whitespace:\n\n```ts\nif (!isValidEmail(email)) throw new Error(\'Invalid email\');\n```\n\nBoth tests in **src/signup.test.ts** pass.' }] } });
  add({ type: 'system', subtype: 'turn_duration', uuid: 'd8', timestamp: T(5), durationMs: 48200 });
}
writeFileSync(join(claudeHome, 'projects', enc, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// Older sessions that aren't running, for the dashboard's Recent list.
if (visual) {
  const old = [
    [repo, 'feature-x', 'Fix flaky login test', 'The login test fails about one run in five, find out why', 3],
    [repo2, 'main', 'Set up the web app routing', 'Add routes for /settings and /billing', 26],
    [repo, 'main', 'Explain the release script', 'What does scripts/release.sh do?', 50],
  ];
  old.forEach(([cwd, branch, title, prompt, hoursAgo], i) => {
    const id = `7777777${i}-7777-7777-7777-777777777777`;
    const dir = join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const ts = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(
      file,
      [
        { type: 'user', uuid: `o${i}`, parentUuid: null, sessionId: id, cwd, gitBranch: branch, timestamp: ts, message: { role: 'user', content: prompt } },
        { type: 'ai-title', aiTitle: title, sessionId: id },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const t = new Date(ts);
    utimesSync(file, t, t);
  });
}

// Settings for the throwaway profile.
const userData = join(base, 'user-data');
mkdirSync(join(userData, 'User'), { recursive: true });
writeFileSync(
  join(userData, 'User', 'settings.json'),
  JSON.stringify({
    ...(real ? {} : { 'claudeProjects.claudePath': join(root, 'test', 'fixtures', 'fake-claude.mjs') }),
    'claudeProjects.notifications.enabled': false,
    // Never read the real shared .env from a test.
    'claudeProjects.chat.globalEnvFile': join(base, 'shared.env'),
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'extensions.autoUpdate': false,
    'window.newWindowDimensions': 'maximized',
    'workbench.colorTheme': 'Default Dark Modern',
  }),
);

// Optionally make the official Claude Code extension available (symlink, read-only use).
const extensionsDir = join(base, 'extensions');
mkdirSync(extensionsDir, { recursive: true });
if (process.argv.includes('--with-official')) {
  const { readdirSync, symlinkSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const src = join(homedir(), '.vscode', 'extensions');
  const official = readdirSync(src).filter((d) => d.startsWith('anthropic.claude-code-')).sort().pop();
  if (official) {
    // A junction on Windows: directory symlinks there need admin rights.
    symlinkSync(join(src, official), join(extensionsDir, official), process.platform === 'win32' ? 'junction' : 'dir');
    console.log('linked', official);
  }
}

// Bundle the suite.
const suiteOut = join(base, 'suite.js');
await esbuild.build({ entryPoints: [join(here, real ? 'real.ts' : visual ? 'visual.ts' : 'suite.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: suiteOut, logLevel: 'warning' });

// VS Code must not inherit Electron/VS Code variables from the shell that runs us.
for (const k of Object.keys(process.env)) if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) delete process.env[k];

try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : undefined),
    extensionDevelopmentPath: root,
    extensionTestsPath: suiteOut,
    launchArgs: [...(visual ? [`--remote-debugging-port=${cdpPort}`] : []), repo, '--user-data-dir', userData, '--extensions-dir', extensionsDir, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry', '--new-window'],
    extensionTestsEnv: {
      CP_E2E_REPO: realpathSync.native(repo),
      CP_E2E_REPO2: realpathSync.native(repo2),
      CP_E2E_SESSION: sessionId,
      ...(real ? {} : { CLAUDE_CONFIG_DIR: claudeHome }),
      CP_REAL_PROJECTS: process.env.CP_REAL_PROJECTS ?? '',
      CP_REAL_SESSION_CWD: process.env.CP_REAL_SESSION_CWD ?? '',
      CP_REAL_SESSION_ID: process.env.CP_REAL_SESSION_ID ?? '',
      CP_E2E_IMAGE: process.env.CP_E2E_IMAGE ?? '',
      CP_REAL_DEFAULT_MODEL: process.env.CP_REAL_DEFAULT_MODEL ?? '',
      CP_REAL_DEFAULT_EFFORT: process.env.CP_REAL_DEFAULT_EFFORT ?? '',
      CP_E2E_CDP_PORT: visual ? String(cdpPort) : '',
      CP_E2E_SHOTS: process.env.CP_E2E_SHOTS ?? '',
      CP_E2E_OFFICIAL: process.argv.includes('--with-official') ? '1' : '',
    },
  });
  console.log('E2E: passed');
} catch (err) {
  console.error('E2E: failed', err);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP_E2E) rmSync(base, { recursive: true, force: true });
}
