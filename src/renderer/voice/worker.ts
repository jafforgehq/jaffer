/**
 * The voice worker (`dist/renderer/voice-worker.js`, its own esbuild target: the main bundle never imports this file, so a person who
 * never turns voice on loads none of it). Kokoro 82M (`kokoro-js`, espeak-ng phonemes from the `phonemizer` bundle, which embeds its
 * WASM and data) speaks, Whisper base.en transcribes, both on transformers.js over onnxruntime-web's WASM backend.
 *
 * **No network, by construction** (the page is a `file://` page and a worker loaded from it has no CSP of its own, so the guards are
 * here, and `net-guard.ts`, imported first, installs them before any library code runs): the page hands over every byte in `load`
 * (the 13 manifest files and the ORT binary, read by main through `jaffer:voice-file`);
 * transformers.js reads models only from the custom cache below (`allowRemoteModels = false`; `allowLocalModels` must stay true or
 * transformers.js refuses to start when both are off, and its local path points nowhere and goes through the fetch guard); kokoro-js
 * reads its voice files from `caches.open()`, which this worker replaces with the same in-memory cache; `fetch` serves only `data:` and
 * `blob:` URLs and the other network APIs are gone (`net-guard.ts`); and `wasmPaths` is cleared at module level, because transformers.js sets it
 * to cdn.jsdelivr.net at import and ORT would then `import()` its glue code from there (the feasibility gate saw that request) instead of
 * the copy embedded in its bundle (`import.meta.url` is defined as the worker's own URL by the build so ORT finds it).
 * One thread (`numThreads = 1`: a `file://` page is not cross-origin isolated, so there is no SharedArrayBuffer).
 *
 * Kokoro runs on WASM only: on the gate's Mac, Kokoro q8 on WebGPU loaded and ran but its audio was garbled (Whisper heard "Okay, thing,
 * thing, thing." for "Hello, this is a test.") and it was no faster than WASM. Audio stays in memory and is never logged.
 */
import './net-guard'; // first: it must run before any library code below
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';

/** Page to worker. */
export type ToWorker =
  | { type: 'load'; files: Record<string, Uint8Array>; wasm: Uint8Array }
  | { type: 'speak'; id: number; text: string; speed: number }
  | { type: 'stop' }
  | { type: 'transcribe'; id: number; pcm: Float32Array };
/** Worker to page. `audio` is one sentence at `rate` Hz; `done` ends a speak (also a stopped one). */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; id?: number; message: string }
  | { type: 'audio'; id: number; pcm: Float32Array; rate: number }
  | { type: 'done'; id: number }
  | { type: 'text'; id: number; text: string };

const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const WHISPER = 'onnx-community/whisper-base.en';
const VOICE = 'af_heart';
/** A model id in a request becomes the manifest folder: `.../<repo>/[resolve/<rev>/]<file>` -> `<dir>/<file>`. */
const REPOS: Record<string, string> = { [`${KOKORO}/`]: 'kokoro/', [`${WHISPER}/`]: 'whisper/' };

const scope = self as unknown as { postMessage(m: FromWorker, t?: Transferable[]): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const post = (m: FromWorker, t?: Transferable[]) => scope.postMessage(m, t);

// right after the imports: transformers.js set this to cdn.jsdelivr.net, and ORT would `import()` its glue code from there
const ow = env.backends.onnx.wasm!;
ow.wasmPaths = undefined;
ow.numThreads = 1;
ow.proxy = false;

let files: Record<string, Uint8Array> = {};
const lookup = (key: unknown): Uint8Array | undefined => {
  const s = String(key instanceof Request ? key.url : key);
  for (const [repo, dir] of Object.entries(REPOS)) {
    const i = s.indexOf(repo);
    if (i >= 0) return files[dir + s.slice(i + repo.length).replace(/^resolve\/[^/]+\//, '')];
  }
  return undefined;
};
const cache = {
  async match(key: unknown) { const b = lookup(key); return b ? new Response(b as BodyInit, { headers: { 'content-length': String(b.byteLength) } }) : undefined; },
  async put() { /* nothing is ever stored */ },
};
Object.defineProperty(self, 'caches', { value: { open: async () => cache }, configurable: true });

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/voice-none/';
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = cache;

let tts: KokoroTTS | null = null;
let asr: AutomaticSpeechRecognitionPipeline | null = null;
/** Speak ids are increasing: `stop` cancels every speak the page had sent until then, running or queued. */
let latest = 0;
let stopUpTo = 0;
let jobs = Promise.resolve();

async function load(m: Extract<ToWorker, { type: 'load' }>) {
  files = m.files;
  ow.wasmBinary = m.wasm;
  tts = await KokoroTTS.from_pretrained(KOKORO, { dtype: 'q8', device: 'wasm' });
  // (typed loosely: the overloads of `pipeline` are a union too large for tsc)
  const make = pipeline as unknown as (task: 'automatic-speech-recognition', model: string, o: object) => Promise<AutomaticSpeechRecognitionPipeline>;
  asr = await make('automatic-speech-recognition', WHISPER, { dtype: 'q8', device: 'wasm' });
  // the sessions hold the model now; keep only the voices, which kokoro-js reads at its first sentence
  files = Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('kokoro/voices/')));
  post({ type: 'ready' });
}

async function say(id: number, text: string, speed: number) {
  const split = new TextSplitterStream();
  split.push(text);
  split.close(); // (kokoro-js's own string path never closes its splitter, so its last sentence would never come)
  for await (const { audio } of tts!.stream(split, { voice: VOICE, speed: Math.min(2, Math.max(0.5, speed || 1)) })) {
    if (id <= stopUpTo) break;
    const pcm = audio.audio as Float32Array;
    post({ type: 'audio', id, pcm, rate: audio.sampling_rate }, [pcm.buffer]);
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'stop') { stopUpTo = latest; return; }
  if (m.type === 'speak') latest = Math.max(latest, m.id);
  // one model run at a time, in order; a speak stopped while it waited is skipped
  jobs = jobs.then(async () => {
    try {
      if (m.type === 'load') await load(m);
      else if (!tts || !asr) post({ type: 'error', id: 'id' in m ? m.id : undefined, message: 'not loaded' });
      else if (m.type === 'speak') { try { if (m.id > stopUpTo) await say(m.id, m.text, m.speed); } finally { post({ type: 'done', id: m.id }); } }
      else if (m.type === 'transcribe') { const out = await asr(m.pcm); post({ type: 'text', id: m.id, text: Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text }); }
    } catch (err) {
      post({ type: 'error', id: 'id' in m ? m.id : undefined, message: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  });
};
