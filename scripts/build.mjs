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
execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-release-notes.mjs')], { stdio: 'inherit' });

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
  { name: 'bridge', ...nodeCommon, entryPoints: [path.join(root, 'src/dev/bridge.ts')], outfile: path.join(root, 'dist/dev/bridge.cjs') },
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
  {
    // (voice) the worker: its own bundle, so transformers.js, onnxruntime-web and kokoro-js never enter app.js. `import.meta.url` is
    // the worker's own URL, so onnxruntime-web uses the glue code embedded in its bundle instead of importing it from wasmPaths.
    name: 'voice-worker',
    entryPoints: [path.join(root, 'src/renderer/voice/worker.ts')],
    outfile: path.join(root, 'dist/renderer/voice-worker.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    sourcemap: true,
    define: { ...define, 'process.env.NODE_ENV': '"production"', 'import.meta.url': 'self.location.href' },
    logLevel: 'warning',
  },
  {
    // (voice) the recorder's AudioWorklet: a file next to the page, loaded by relative URL (`script-src 'self'`; no blob: or data: module)
    name: 'voice-recorder',
    entryPoints: [path.join(root, 'src/renderer/voice/recorder.worklet.ts')],
    outfile: path.join(root, 'dist/renderer/voice-recorder.worklet.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    logLevel: 'warning',
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
// (voice) the onnxruntime-web binary the worker runs; main reads it from here for `jaffer:voice-file` (VOICE_RUNTIME_WASM)
if (!only || only === 'voice-worker') {
  fs.mkdirSync(rdst, { recursive: true });
  const wasm = 'ort-wasm-simd-threaded.jsep.wasm';
  fs.copyFileSync(path.join(root, 'node_modules/onnxruntime-web/dist', wasm), path.join(rdst, wasm));
}
if (!watch) console.log('build complete');
