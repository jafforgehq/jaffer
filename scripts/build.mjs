// Bundles everything with esbuild: daemon, CLI, Electron main/preload, and the renderer.
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-shell.mjs')], { stdio: 'inherit' });

const define = { __JAFFER_VERSION__: JSON.stringify(pkg.version) };
const nodeCommon = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  define,
  // native addon + electron are resolved at runtime, never bundled
  external: ['@lydell/node-pty', 'electron'],
};

const targets = [
  { name: 'daemon', ...nodeCommon, entryPoints: [path.join(root, 'src/daemon/main.ts')], outfile: path.join(root, 'dist/daemon/jafferd.cjs') },
  { name: 'cli', ...nodeCommon, entryPoints: [path.join(root, 'src/cli/main.ts')], outfile: path.join(root, 'dist/cli/jaffer.cjs') },
  { name: 'main', ...nodeCommon, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(root, 'dist/main/main.cjs') },
  { name: 'preload', ...nodeCommon, entryPoints: [path.join(root, 'src/main/preload.ts')], outfile: path.join(root, 'dist/main/preload.cjs') },
  {
    name: 'renderer',
    entryPoints: [path.join(root, 'src/renderer/index.tsx')],
    outfile: path.join(root, 'dist/renderer/app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    sourcemap: true,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { ...define, 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'css', '.ttf': 'dataurl', '.woff2': 'dataurl' },
    logLevel: 'info',
  },
].filter((t) => fs.existsSync(t.entryPoints[0]) && (!only || t.name === only));

const { name: _n, ...rest } = {};
void _n;
void rest;

for (const t of targets) {
  const { name, ...opts } = t;
  fs.mkdirSync(path.dirname(opts.outfile), { recursive: true });
  if (watch) {
    const ctx = await context(opts);
    await ctx.watch();
    console.log(`watching ${name}`);
  } else {
    await build(opts);
  }
}

// static renderer assets
const rsrc = path.join(root, 'src/renderer');
const rdst = path.join(root, 'dist/renderer');
if (fs.existsSync(path.join(rsrc, 'index.html')) && (!only || only === 'renderer')) {
  fs.mkdirSync(rdst, { recursive: true });
  for (const f of ['index.html']) fs.copyFileSync(path.join(rsrc, f), path.join(rdst, f));
}
if (!watch) console.log('build complete');
