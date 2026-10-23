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

## The session block (Task 6b)

Jaffer's window session cancels every `http(s)`, `ws(s)` and `ftp` request (`BLOCKED_URL_FILTER` and `requestAllowed` in
`src/shared/request-policy.ts`, wired in `createWindow`). Two checks prove it holds in a real Electron renderer for the page **and** for
workers, which have no CSP and no net guard of their own here.

**1. The gate above with the block on.** In `main.cjs` replace the `onBeforeRequest` line with the app's own filter (bundle the policy
first: `npx esbuild /path/to/jaffer/src/shared/request-policy.ts --format=cjs --platform=node --outfile=$G/app/request-policy.cjs`):

```js
  const { requestAllowed, BLOCKED_URL_FILTER } = require('./request-policy.cjs');
  win.webContents.session.webRequest.onBeforeRequest({ urls: BLOCKED_URL_FILTER }, (d, cb) => cb({ cancel: !requestAllowed(d.url) }));
```

Expected: `GATE PASS` as before (the worker needs no network).

**2. The probe.** A page with **no CSP** (so the session is the only barrier) runs the same probes itself, from a dedicated worker
without the net guard, and from a blob module worker whose static `import` names the network: `fetch`, XHR, dynamic `import()`,
`WebSocket` and an image, each against a local `127.0.0.1` server that counts hits and WebSocket upgrades, and, with the block on, against
`https://example.com`, `https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js` and `wss://example.com`. `BLOCK=0` is the control (the
probes must reach the server); never run the control with the external targets. Put these files in `$G/app3` with `request-policy.cjs`, then:

```sh
cd $G/app3 && for B in 0 1; do HOME=$G/home JAFFER_HOME=$G/home/.jaffer-gate BLOCK=$B \
  /path/to/jaffer/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron main.cjs; done
```

Expected (2026-10-23, Electron 44): `BLOCK=0 server hits=8 ws upgrades=2` and every local fetch, XHR and import `LOADED` (the image fails
to decode the server's text but still hits it); `BLOCK=1 server hits=0 ws upgrades=0`, every probe `failed`, the callback saw 17
requests (`xhr`, `script`, `webSocket`, `image`; 10 local, 7 external) and cancelled all 17; `data:` image, `blob:` image and the
`file:` page `LOADED` in both runs.

### `app3/main.cjs`

```js
// Probe for Task 6b: does the window session's onBeforeRequest see (and cancel) requests made by the page AND by a worker?
// BLOCK=1 turns the block on; BLOCK=0 is the control run (the probes must then reach the local server).
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http'); const path = require('node:path');
const { requestAllowed, BLOCKED_URL_FILTER } = require('./request-policy.cjs');
const BLOCK = process.env.BLOCK === '1';
let hits = 0, upgrades = 0; const seen = {}; let cancelled = 0;
const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.png') ? 'image/png' : 'text/plain', 'access-control-allow-origin': '*' }); res.end(req.url.endsWith('.js') ? 'export default 42;' : 'ok'); });
srv.on('upgrade', (_req, sock) => { upgrades++; sock.destroy(); });
const results = [];
ipcMain.on('log', (_e, m) => { results.push(m); console.log('[probe]', m); });
ipcMain.on('done', () => {
  setTimeout(() => {
    console.log(`BLOCK=${BLOCK ? 1 : 0} server hits=${hits} ws upgrades=${upgrades} callbacks by resourceType=${JSON.stringify(seen)} cancelled=${cancelled}`);
    app.exit(0);
  }, 1500);
});
app.whenReady().then(() => srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
  const allow = (wc, p) => wc === win.webContents && p === 'clipboard-sanitized-write';
  win.webContents.session.setPermissionRequestHandler((wc, p, cb) => cb(allow(wc, p)));
  win.webContents.session.setPermissionCheckHandler((wc, p) => allow(wc, p));
  if (BLOCK) win.webContents.session.webRequest.onBeforeRequest({ urls: BLOCKED_URL_FILTER }, (d, cb) => {
    const k = `${d.resourceType}:${new URL(d.url).protocol}`; seen[k] = (seen[k] ?? 0) + 1;
    const c = !requestAllowed(d.url); if (c) cancelled++; cb({ cancel: c });
  });
  win.webContents.on('console-message', (e) => console.log('[console]', e.message.slice(0, 200)));
  win.loadFile(path.join(__dirname, 'index.html'), { query: { port: String(port), ext: BLOCK ? '1' : '0' } });
  setTimeout(() => { console.log('PROBE TIMEOUT', `hits=${hits}`); app.exit(2); }, 60000);
}));
```

### `app3/preload.cjs`

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', { log: (m) => ipcRenderer.send('log', m), done: () => ipcRenderer.send('done') });
```

### `app3/index.html` (no CSP on purpose)

```html
<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><script src="page.js"></script></body></html>
```

### `app3/probes.js`

```js
// shared by page and worker: each probe resolves to a short outcome string
async function runProbes(where, port, ext) {
  const L = `http://127.0.0.1:${port}`;
  const t = (p, ms = 5000) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
  const ok = (v) => 'LOADED ' + String(v).slice(0, 30), bad = (e) => 'failed: ' + String(e && e.message || e).slice(0, 60);
  const ws = (u) => new Promise((r) => { try { const s = new WebSocket(u); s.onopen = () => r('OPEN'); s.onerror = () => r('failed: error event'); s.onclose = (e) => r('closed ' + e.code); } catch (e) { r(bad(e)); } });
  const out = [];
  const add = async (name, p) => out.push(`${where} ${name}: ${await t(p.then(ok, bad))}`);
  await add('fetch local', fetch(`${L}/${where}-fetch`).then((r) => r.text()));
  await add('import local', import(`${L}/${where}-import.js`).then((m) => m.default));
  out.push(`${where} websocket local: ${await t(ws(`ws://127.0.0.1:${port}/${where}-ws`))}`);
  await add('xhr local', new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', `${L}/${where}-xhr`); x.onload = () => res(x.status); x.onerror = () => rej('xhr error'); x.send(); }));
  if (typeof Image !== 'undefined') await add('img local', new Promise((res, rej) => { const i = new Image(); i.onload = () => res('img'); i.onerror = () => rej('img error'); i.src = `${L}/${where}-x.png`; }));
  if (ext) {
    await add('fetch https://example.com', fetch('https://example.com').then((r) => r.status));
    await add('import jsdelivr lodash', import('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js').then(() => 'module'));
    out.push(`${where} websocket wss://example.com: ${await t(ws('wss://example.com'))}`);
    if (typeof Image !== 'undefined') await add('img https://example.com/x.png', new Promise((res, rej) => { const i = new Image(); i.onload = () => res('img'); i.onerror = () => rej('img error'); i.src = 'https://example.com/x.png'; }));
  }
  return out;
}
```

### `app3/worker.js`

```js
importScripts('probes.js'); // a file: URL, allowed
onmessage = async (e) => { postMessage(await runProbes('worker', e.data.port, e.data.ext)); };
```

### `app3/page.js`

```js
(async () => {
  const q = new URLSearchParams(location.search); const port = q.get('port'), ext = q.get('ext') === '1';
  await new Promise((r) => { const s = document.createElement('script'); s.src = 'probes.js'; s.onload = r; document.head.append(s); });
  for (const l of await runProbes('page', port, ext)) probe.log(l);
  // the same probes from a dedicated worker that has NO net guard
  const w = new Worker('worker.js');
  const lines = await new Promise((r) => { w.onmessage = (e) => r(e.data); w.onerror = (e) => r(['worker error ' + e.message]); w.postMessage({ port, ext }); });
  for (const l of lines) probe.log(l);
  // and from a module worker made from a blob (the worker's own static import of a network URL)
  const src = `import v from 'http://127.0.0.1:${port}/blobmod-import.js'; postMessage('blob module worker LOADED ' + v);`;
  const mw = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  probe.log(await new Promise((r) => { mw.onmessage = (e) => r(e.data); mw.onerror = () => r('blob module worker static import: failed (error event)'); setTimeout(() => r('blob module worker: timeout'), 5000); }));
  // local schemes still load: data: and blob: images, and this file:// page itself
  const img = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r('LOADED'); i.onerror = () => r('failed'); i.src = u; });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  probe.log('data: image ' + await img(png));
  const blob = await (await fetch(png)).blob();
  probe.log('blob: image ' + await img(URL.createObjectURL(blob)));
  probe.log('file:// page ' + location.protocol);
  probe.done();
})();
```


## The microphone (Task 8)

The same kind of scratch app proves the recorder in a real Electron renderer: Jaffer's `webPreferences`, its CSP, `main.ts`'s permission
decision with the real `pageMayUseMic` and the session block (`request-policy.ts`), on a `file://` page, with Chromium's fake capture
device instead of a microphone (so macOS is never asked). It checks (i) `getUserMedia({audio})` succeeds with Voice on and is refused
(`NotAllowedError`) with Voice off; (ii) `audioWorklet.addModule('./voice-recorder.worklet.js')` works from the `file://` page under
`script-src 'self'` (no CSP change), at a 16 kHz `AudioContext`; (iii) the real `record()` returns 16 kHz samples that end 1.5 s after
the speech; (iv) with the permission handler refusing, `record()` rejects `'mic-denied'`; (v) the session block still holds (a page fetch
is stopped by the CSP first; a `file://` worker, which has no CSP, is stopped by the session: `net cancelled: 1`).

Two findings shape the recipe. `--use-fake-ui-for-media-stream` **bypasses Electron's permission request handler** (with it, Voice off
still got the microphone), so it is left out (`FAKE_UI=1` only to see that). Chromium's default fake device beeps about once a second,
which never leaves 1.5 s of quiet, so `record()` then runs to its 60 s cap; the recipe feeds a WAV instead (0.5 s quiet, 1.5 s of a
modulated tone, 10 s quiet). The audio service reads that file and its own sandbox refuses it ("Failed to read ... as input to the fake
device"), so the gate turns off only `AudioServiceSandbox`; the renderer keeps `sandbox: true`.

```sh
G=$TMPDIR/mic-gate              # any throwaway folder outside the repo
mkdir -p $G/home/.jaffer-gate $G/app
cd /path/to/jaffer && npm run build
# the files below go into $G/app; then:
python3 -I - $G/app/speech.wav <<'PY'
import wave, struct, math, random, sys
random.seed(1); r = 48000
sp = [int(14000 * (0.5 + 0.5 * math.sin(2 * math.pi * 4 * i / r)) * (0.6 * math.sin(2 * math.pi * (200 + 150 * math.sin(2 * math.pi * 0.7 * i / r)) * i / r) + 0.1 * random.uniform(-1, 1))) for i in range(int(1.5 * r))]
s = [0] * int(0.5 * r) + sp + [0] * int(10 * r)
w = wave.open(sys.argv[1], 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(r); w.writeframes(struct.pack('<%dh' % len(s), *s)); w.close()
PY
npx esbuild $G/app/page-src.ts --bundle --platform=browser --format=iife --target=chrome140 --outfile=$G/app/page.js
npx esbuild src/shared/voice-permission.ts --format=cjs --platform=node --outfile=$G/app/voice-permission.cjs
npx esbuild src/shared/request-policy.ts --bundle --format=cjs --platform=node --outfile=$G/app/request-policy.cjs
cp dist/renderer/voice-recorder.worklet.js $G/app/
E=/path/to/jaffer/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
cd $G/app
HOME=$G/home JAFFER_HOME=$G/home/.jaffer-gate VOICE=1 WAV=$G/app/speech.wav $E main.cjs
HOME=$G/home JAFFER_HOME=$G/home/.jaffer-gate VOICE=0 $E main.cjs
```

Expected (2026-10-23, Electron 44, Apple silicon). `VOICE=1 WAV=…`: `(iii, first capture) record: 57344 samples = 3.58 s at 16 kHz`
(28 frames, 13 loud, about 3.9 s), `(i) getUserMedia ok: Fake Default Audio Input`, `(ii) addModule ok; sampleRate 16000`, `(iii) record:
57344 samples = 3.58 s at 16 kHz`, both `(v)` fetches `failed`, `net cancelled: 1`, the request handler asked `media` with
`["audio"]`, `GATE PASS`. `VOICE=0`: `(i) getUserMedia rejected: NotAllowedError`, `(ii) addModule ok`, `(iv) record rejected:
mic-denied`, `GATE PASS`. Without `WAV` and with Voice on (the beeping device): `record: 962560 samples = 60.16 s` (the 60 s cap).

Not covered here, and not verifiable without a signed build: macOS's own microphone prompt and `systemPreferences` (`jaffer:voice-mic`),
the `NSMicrophoneUsageDescription` text and the audio-input entitlement; and a real microphone (levels, echo cancellation while Kokoro
speaks; the microphone is closed while it speaks anyway).

### `mic-gate/main.cjs`

```js
// Mic gate (Task 8): Jaffer's webPreferences, CSP, permission decision (pageMayUseMic) and session block, a file:// page, Chromium's fake mic.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pageMayUseMic } = require('./voice-permission.cjs');
const { requestAllowed, BLOCKED_URL_FILTER } = require('./request-policy.cjs');
const VOICE = process.env.VOICE === '1';
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (process.env.FAKE_UI === '1') app.commandLine.appendSwitch('use-fake-ui-for-media-stream'); // (bypasses the permission request handler: never for (iv))
// the fake input file is read by the audio service, whose own sandbox refuses it; the renderer keeps sandbox: true
if (process.env.WAV) { app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${process.env.WAV}%noloop`); app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox'); }
let cancelled = 0; const asked = [];
ipcMain.on('log', (_e, m) => console.log('[page]', m));
ipcMain.on('done', (_e, ok) => { console.log(`permission asks: ${JSON.stringify(asked)}; net cancelled: ${cancelled}`); console.log(ok ? 'GATE PASS' : 'GATE FAIL'); app.exit(ok ? 0 : 1); });
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
  // main.ts's pagePermission, verbatim apart from appCfg
  const pagePermission = (wc, permission, mediaTypes) => wc === win.webContents && (permission === 'clipboard-sanitized-write' || pageMayUseMic(VOICE, permission, mediaTypes));
  win.webContents.session.setPermissionRequestHandler((wc, p, cb, d) => { asked.push(`req:${p}:${JSON.stringify(d.mediaTypes)}`); cb(pagePermission(wc, p, 'mediaTypes' in d ? d.mediaTypes : undefined)); });
  win.webContents.session.setPermissionCheckHandler((wc, p, _o, d) => { asked.push(`chk:${p}:${d.mediaType}`); return pagePermission(wc, p, d.mediaType ? [d.mediaType] : undefined); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: BLOCKED_URL_FILTER }, (d, cb) => { const c = !requestAllowed(d.url); if (c) cancelled++; cb({ cancel: c }); });
  win.webContents.on('console-message', (e) => console.log('[console]', e.message));
  win.loadFile(path.join(__dirname, 'index.html'), { query: { voice: VOICE ? '1' : '0', first: process.env.WAV ? '1' : '0' } });
  setTimeout(() => { console.log('GATE TIMEOUT'); app.exit(2); }, 90000);
});
```

### `mic-gate/preload.cjs`

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gate', { log: (m) => ipcRenderer.send('log', m), done: (ok) => ipcRenderer.send('done', ok) });
```

### `mic-gate/index.html`

The gate index.html of the first section (Jaffer's CSP, `<script src="page.js">`).

### `mic-gate/net-worker.js`

```js
fetch('https://example.com').then((r) => postMessage('status ' + r.status), (e) => postMessage('failed: ' + e.message));
```

### `mic-gate/page-src.ts`

```ts
import { record } from '/path/to/jaffer/src/renderer/voice/recorder';
declare const gate: { log(m: string): void; done(ok: boolean): void };
(async () => {
  const voice = new URLSearchParams(location.search).get('voice') === '1';
  const ok: boolean[] = [];
  try {
    gate.log(`page ${location.protocol}`);
    if (new URLSearchParams(location.search).get('first') === '1') {
      // the fake file starts with the first capture: record() must be that capture to see the tone
      const t0 = performance.now(); let frames = 0, loud = 0;
      const pcm = await record({ signal: AbortSignal.timeout(70000), onLevel: (r) => { frames++; if (r >= 0.01) loud++; } }).catch((e) => (gate.log(`rejected ${e}`), null));
      gate.log(`(iii, first capture) record: ${pcm ? `${pcm.length} samples = ${(pcm.length / 16000).toFixed(2)} s at 16 kHz, peak ${pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(3)}` : 'null'}, ${frames} frames (${loud} loud), ${Math.round(performance.now() - t0)} ms`);
      ok.push(!!pcm && pcm.length > 16000 && pcm.length < 16000 * 10);
    }
    // (i) getUserMedia alone
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      gate.log(`(i) getUserMedia ok: ${s.getAudioTracks().map((t) => t.label).join(',')}`); s.getTracks().forEach((t) => t.stop()); ok.push(voice);
    } catch (e) { gate.log(`(i) getUserMedia rejected: ${(e as Error).name}`); ok.push(!voice && (e as Error).name === 'NotAllowedError'); }
    // (ii) the worklet module from the file:// page under the CSP
    const ctx = new AudioContext({ sampleRate: 16000 });
    try { await ctx.audioWorklet.addModule('./voice-recorder.worklet.js'); gate.log(`(ii) addModule ok; sampleRate ${ctx.sampleRate}`); ok.push(ctx.sampleRate === 16000); }
    catch (e) { gate.log(`(ii) addModule FAILED: ${e}`); ok.push(false); }
    await ctx.close();
    // (iii)/(iv) record()
    const t0 = performance.now();
    let frames = 0, loud = 0;
    try {
      const pcm = await record({ signal: AbortSignal.timeout(70000), onLevel: (r) => { frames++; if (r >= 0.01) loud++; } });
      gate.log(`(iii) record: ${pcm ? `${pcm.length} samples = ${(pcm.length / 16000).toFixed(2)} s at 16 kHz` : 'null'}, ${frames} frames (${loud} loud), ${Math.round(performance.now() - t0)} ms`);
      ok.push(voice && !!pcm && pcm.length > 16000);
    } catch (e) { gate.log(`(iv) record rejected: ${e}`); ok.push(!voice && e === 'mic-denied'); }
    // (v) the session block: a page fetch to the network fails
    const f = await fetch('https://example.com').then((r) => `status ${r.status}`, (e) => `failed: ${(e as Error).message}`);
    gate.log(`(v) page fetch https://example.com: ${f}`); ok.push(f.startsWith('failed'));
    // a file:// worker has no CSP of its own: only the session block stands between it and the network
    const w = await new Promise<string>((r) => { const wk = new Worker('net-worker.js'); wk.onmessage = (e) => r(String(e.data)); wk.onerror = () => r('worker error'); });
    gate.log(`(v) worker fetch https://example.com: ${w}`); ok.push(w.startsWith('failed'));
    gate.log(`checks: ${JSON.stringify(ok)}`);
    gate.done(ok.every(Boolean));
  } catch (e) { gate.log('ERROR ' + e); gate.done(false); }
})();
```
