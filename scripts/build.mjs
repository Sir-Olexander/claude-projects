// Build script: bundles the extension host code and the webview apps with esbuild.
//   node scripts/build.mjs               one-off development build
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --production  minified build for packaging
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(join(root, 'dist', 'webview'), { recursive: true });

// Codicons for the webviews (same icon font VS Code uses).
const codicons = join(root, 'node_modules', '@vscode', 'codicons', 'dist');
cpSync(join(codicons, 'codicon.css'), join(root, 'dist', 'webview', 'codicon.css'));
cpSync(join(codicons, 'codicon.ttf'), join(root, 'dist', 'webview', 'codicon.ttf'));

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
};

const configs = [
  {
    ...common,
    entryPoints: { extension: join(root, 'src', 'extension.ts') },
    outdir: join(root, 'dist'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: {
      chat: join(root, 'src', 'webview', 'chat', 'main.tsx'),
      dashboard: join(root, 'src', 'webview', 'dashboard', 'main.tsx'),
    },
    outdir: join(root, 'dist', 'webview'),
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.ttf': 'file', '.svg': 'dataurl', '.png': 'dataurl' },
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build] watching for changes…');
} else {
  const results = await Promise.allSettled(configs.map((c) => esbuild.build(c)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    for (const f of failed) console.error(f.reason?.message ?? f.reason);
    process.exit(1);
  }
}
