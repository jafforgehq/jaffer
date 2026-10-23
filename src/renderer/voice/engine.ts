/**
 * The page side of the voice worker (`worker.ts`, built to `voice-worker.js`). Imports only the worker's message *types*, so the main
 * bundle carries none of transformers.js: the worker script loads at the first `startEngine`, which happens only once voice is on.
 * `startEngine` reads every manifest file and the ORT binary through `window.jaffer.voice.file` (main refuses while the switch is off),
 * hands them to the worker (transferred, not copied) and waits for both models; any failure is `'unavailable'`. `speak` plays each
 * sentence as it arrives (24 kHz from Kokoro) through one `AudioContext` and resolves when the last one has played or speech was
 * stopped; `transcribe` sends 16 kHz mono and resolves with Whisper's raw text (cleaning is `voice-text.ts`'s job). A worker crash,
 * like `stopEngine`, rejects whatever is pending with `'unavailable'` and ends the engine; a failure of one call rejects it with
 * `'error'`. Audio and text live only in memory, for the call.
 */
import { VOICE_FILES, VOICE_RUNTIME_WASM } from '../../shared/voice-manifest';
import type { FromWorker, ToWorker } from './worker';

export interface EngineDeps {
  worker(): Worker;
  file(name: string): Promise<Uint8Array>;
  audio?(): AudioContext;
}
const defaults: EngineDeps = {
  worker: () => new Worker('voice-worker.js'),
  file: (name) => window.jaffer.voice.file(name),
  audio: () => new AudioContext(),
};

type Pending = { resolve(text: string): void; reject(why: string): void };
let worker: Worker | null = null;
let starting: Promise<void> | null = null;
/** Fails a start still waiting for the models (stopEngine during the load). */
let failStart: (() => void) | null = null;
let deps: EngineDeps = defaults;
let seq = 0;
const pending = new Map<number, Pending>();
let ctx: AudioContext | null = null;
/** The speech now playing: its sources, and whether the worker said it sent the last sentence. */
let current: { id: number; resolve(): void; sources: Set<AudioBufferSourceNode>; at: number; sent: boolean } | null = null;

const send = (m: ToWorker, t?: Transferable[]) => worker?.postMessage(m, t ?? []);

function endSpeech() {
  const c = current;
  current = null;
  if (!c) return;
  for (const s of c.sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } }
  c.resolve();
}
const finishIfPlayed = () => { if (current?.sent && current.sources.size === 0) endSpeech(); };

function play(id: number, pcm: Float32Array, rate: number) {
  const c = current;
  if (!c || c.id !== id || pcm.length === 0) return;
  ctx ??= (deps.audio ?? defaults.audio!)();
  const buf = ctx.createBuffer(1, pcm.length, rate);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  c.at = Math.max(c.at, ctx.currentTime);
  src.start(c.at);
  c.at += buf.duration;
  c.sources.add(src);
  src.onended = () => { c.sources.delete(src); finishIfPlayed(); };
}

function onMessage(m: FromWorker) {
  if (m.type === 'audio') play(m.id, m.pcm, m.rate);
  else if (m.type === 'done') { if (current?.id === m.id) { current.sent = true; finishIfPlayed(); } }
  else if (m.type === 'text') { pending.get(m.id)?.resolve(m.text); pending.delete(m.id); }
  else if (m.type === 'error' && m.id !== undefined) {
    pending.get(m.id)?.reject('error');
    pending.delete(m.id);
    if (current?.id === m.id) endSpeech();
  }
}

/** Loads the files and starts the worker; resolves once Kokoro and Whisper are loaded. A second call while one runs shares it. */
export function startEngine(inject?: EngineDeps): Promise<void> {
  if (worker && !starting) return Promise.resolve();
  if (starting) return starting;
  deps = inject ?? defaults;
  const run = (async () => {
    let w: Worker | null = null;
    try {
      const names = VOICE_FILES.map((f) => f.name);
      const bytes = await Promise.all([...names, VOICE_RUNTIME_WASM].map((n) => deps.file(n)));
      const files = Object.fromEntries(names.map((n, i) => [n, bytes[i]!]));
      const wasm = bytes[names.length]!;
      w = deps.worker();
      worker = w;
      await new Promise<void>((resolve, reject) => {
        failStart = () => reject(new Error('stopped'));
        w!.onmessage = (e: MessageEvent<FromWorker>) => {
          if (e.data.type === 'ready') { w!.onmessage = (ev: MessageEvent<FromWorker>) => onMessage(ev.data); resolve(); }
          else if (e.data.type === 'error') reject(new Error(e.data.message));
        };
        w!.onerror = () => reject(new Error('worker failed'));
        send({ type: 'load', files, wasm }, [...new Set(bytes.map((b) => b.buffer as ArrayBuffer))]);
      });
      w.onerror = () => stopEngine();
      w.onmessageerror = () => stopEngine();
    } catch {
      if (w) { w.terminate(); if (worker === w) worker = null; }
      throw 'unavailable';
    } finally {
      starting = null;
      failStart = null;
    }
  })();
  starting = run;
  return run;
}

/** Speaks `text` at `speed` (Kokoro's speed, 1 = normal); a speech already playing is stopped first. */
export function speak(text: string, speed: number): Promise<void> {
  if (!worker || starting) return Promise.reject('unavailable');
  if (current) stopSpeaking();
  const id = ++seq;
  return new Promise<void>((resolve) => {
    current = { id, resolve, sources: new Set(), at: 0, sent: false };
    send({ type: 'speak', id, text, speed });
  });
}

/** Stops the speech now playing (and any the worker still holds); the pending `speak` resolves. */
export function stopSpeaking(): void {
  send({ type: 'stop' });
  endSpeech();
}

/** Whisper's text for 16 kHz mono samples. */
export function transcribe(pcm16k: Float32Array): Promise<string> {
  if (!worker || starting) return Promise.reject('unavailable');
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'transcribe', id, pcm: pcm16k });
  });
}

/** Ends the worker (its memory with it) and the audio; whatever is pending is rejected with 'unavailable', speech resolves. */
export function stopEngine(): void {
  failStart?.();
  endSpeech();
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject('unavailable');
  pending.clear();
  void ctx?.close().catch(() => {});
  ctx = null;
}
