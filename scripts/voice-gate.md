# Voice feasibility gate

A manual check, not repo code: it runs the **built** voice worker (`dist/renderer/voice-worker.js`) and the real
`src/renderer/voice/engine.ts` in a scratch Electron app whose window has Jaffer's `webPreferences` (sandbox, context isolation,
no node integration), Jaffer's CSP and Jaffer's permission policy, loaded from a `file://` page. It proves that the worker starts
from a `file://` page, that onnxruntime-web runs WASM from bytes handed over IPC with one thread, that transformers.js and kokoro-js
load every model from bytes through the worker's custom cache, that Kokoro speaks through an `AudioContext`, and that Whisper base.en
hears what Kokoro said. It also logs every request the window's session makes: only the page and its script may appear.

Never point it at a real `~/.jaffer`: `HOME` and `JAFFER_HOME` are throwaway folders (the name of `JAFFER_HOME` contains "jaffer").

## Steps

Replace `/path/to/jaffer` everywhere below (also inside `page-src.ts` and `dl.ts`) with the absolute path of your Jaffer checkout.

```sh
G=$TMPDIR/voice-gate            # any throwaway folder outside the repo
mkdir -p $G/home/.jaffer-gate $G/app
cd /path/to/jaffer && npm run build

# 1. the model files, through the app's own verified download (about 173 MB)
cat > $G/dl.ts <<'TS'
import { downloadVoice, voiceStatus } from '/path/to/jaffer/src/main/voice-models';
const dir = process.argv[2];
await downloadVoice(dir, { signal: new AbortController().signal, onProgress: () => {} });
console.log(await voiceStatus(dir));
TS
npx esbuild $G/dl.ts --bundle --platform=node --format=esm --outfile=$G/dl.mjs
HOME=$G/home JAFFER_HOME=$G/home/.jaffer-gate node $G/dl.mjs $G/home/.jaffer-gate/voice

# 2. the files below go into $G/app; then bundle the page and copy the worker
npx esbuild $G/app/page-src.ts --bundle --platform=browser --format=iife --target=chrome140 --outfile=$G/app/page.js
cp dist/renderer/voice-worker.js $G/app/

# 3. run
cd $G/app && HOME=$G/home JAFFER_HOME=$G/home/.jaffer-gate VOICE_DIR=$G/home/.jaffer-gate/voice \
  ORT_WASM=/path/to/jaffer/dist/renderer/ort-wasm-simd-threaded.jsep.wasm \
  /path/to/jaffer/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron main.cjs
```

Expected (2026-10-23, Apple silicon): `[net]` lines only for `index.html` and `page.js`; `startEngine resolved`; `speak resolved
after playback: 2 sentences`; `transcribe: " Hello, this is a test. Can you hear me?"`; `stopSpeaking resolved the speak`; `after
stopEngine: rejected unavailable`; `GATE PASS`.

## `main.cjs`

```js
// Gate harness: same webPreferences, CSP and permission policy as Jaffer's window; prints results and quits.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
const VOICE = process.env.VOICE_DIR;
const ORT_WASM = process.env.ORT_WASM;
ipcMain.handle('file', (_e, name) => {
  if (name === 'ort-wasm-simd-threaded.jsep.wasm') return new Uint8Array(fs.readFileSync(ORT_WASM));
  const p = path.join(VOICE, name);
  if (!p.startsWith(VOICE + path.sep)) throw new Error('bad name');
  return new Uint8Array(fs.readFileSync(p));
});
ipcMain.on('log', (_e, m) => console.log('[page]', m));
ipcMain.on('done', (_e, ok) => { console.log(ok ? 'GATE PASS' : 'GATE FAIL'); app.exit(ok ? 0 : 1); });
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
  const allow = (wc, p) => wc === win.webContents && p === 'clipboard-sanitized-write';
  win.webContents.session.setPermissionRequestHandler((wc, p, cb) => cb(allow(wc, p)));
  win.webContents.session.setPermissionCheckHandler((wc, p) => allow(wc, p));
  win.webContents.session.webRequest.onBeforeRequest((d, cb) => { console.log('[net]', d.resourceType, d.url.slice(0, 140)); cb({}); });
  win.webContents.on('console-message', (e) => console.log('[console]', e.message));
  win.loadFile(path.join(__dirname, 'index.html'));
  setTimeout(() => { console.log('GATE TIMEOUT'); app.exit(2); }, 240000);
});
```

## `preload.cjs`

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('jaffer', { voice: { file: (n) => ipcRenderer.invoke('file', n) } });
contextBridge.exposeInMainWorld('gate', { log: (m) => ipcRenderer.send('log', m), done: (ok) => ipcRenderer.send('done', ok) });
```

## `index.html` (the CSP is `src/renderer/index.html`'s)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'" />
    <title>gate</title>
  </head>
  <body><script src="page.js"></script></body>
</html>
```

## `page-src.ts`

```ts
import { speak, startEngine, stopEngine, stopSpeaking, transcribe } from '/path/to/jaffer/src/renderer/voice/engine';
declare const gate: { log(m: string): void; done(ok: boolean): void };
(async () => {
  const heard: Float32Array[] = [];
  let made = 0;
  try {
    let t0 = Date.now();
    await startEngine({
      worker: () => { made++; const w = new Worker('voice-worker.js'); w.addEventListener('message', (e) => { if (e.data.type === 'audio') heard.push(e.data.pcm.slice()); }); return w; },
      file: (n) => (window as any).jaffer.voice.file(n),
      audio: () => new AudioContext(),
    });
    gate.log(`startEngine resolved in ${Date.now() - t0} ms (workers made: ${made})`);
    t0 = Date.now();
    await speak('Hello, this is a test. Can you hear me?', 1);
    const n = heard.reduce((a, b) => a + b.length, 0);
    gate.log(`speak resolved after playback: ${heard.length} sentences, ${n} samples (${(n / 24000).toFixed(2)} s audio), ${Date.now() - t0} ms`);
    const all = new Float32Array(n); let o = 0; for (const h of heard) { all.set(h, o); o += h.length; }
    const m = Math.floor(n / 1.5), pcm = new Float32Array(m);
    for (let i = 0; i < m; i++) { const p = i * 1.5, j = Math.floor(p), f = p - j; pcm[i] = all[j]! * (1 - f) + (all[j + 1] ?? 0) * f; }
    t0 = Date.now();
    const text = await transcribe(pcm);
    gate.log(`transcribe: ${JSON.stringify(text)} in ${Date.now() - t0} ms`);
    t0 = Date.now();
    const p = speak('This sentence is long enough to be stopped before it ends, and another one follows it.', 1.2);
    setTimeout(() => stopSpeaking(), 300);
    await p;
    gate.log(`stopSpeaking resolved the speak in ${Date.now() - t0} ms`);
    stopEngine();
    await transcribe(pcm).then(() => gate.log('transcribe after stopEngine resolved (wrong)'), (why) => gate.log(`after stopEngine: rejected ${why}`));
    gate.done(/hello/i.test(text) && /hear me/i.test(text));
  } catch (e) { gate.log('ERROR ' + e); gate.done(false); }
})();
```
