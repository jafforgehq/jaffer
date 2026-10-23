import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { speak, startEngine, stopEngine, stopSpeaking, transcribe, type EngineDeps } from '../src/renderer/voice/engine';
import { VOICE_FILES, VOICE_RUNTIME_WASM } from '../src/shared/voice-manifest';

/** A stand-in for the voice worker: records what the page posts and lets the test answer. */
class FakeWorker {
  posted: any[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  autoReady = true;
  postMessage(m: any) {
    this.posted.push(m);
    if (m.type === 'load' && this.autoReady) queueMicrotask(() => this.reply({ type: 'ready' }));
  }
  terminate() { this.terminated = true; }
  reply(data: unknown) { this.onmessage?.({ data }); }
  last(type: string) { return [...this.posted].reverse().find((m) => m.type === type); }
}

let w: FakeWorker;
const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  worker: () => { w = new FakeWorker(); return w as unknown as Worker; },
  file: async () => new Uint8Array(4),
  ...over,
});

afterEach(() => stopEngine());

describe('voice engine (page side)', () => {
  it("startEngine rejects with 'unavailable' when a file call fails, and starts no worker", async () => {
    let made = 0;
    await expect(startEngine(deps({ file: async () => { throw new Error('Voice is off.'); }, worker: () => { made++; return new FakeWorker() as unknown as Worker; } }))).rejects.toBe('unavailable');
    expect(made).toBe(0);
  });

  it("startEngine rejects with 'unavailable' when the worker cannot load the models", async () => {
    const p = startEngine(deps({ worker: () => { w = new FakeWorker(); w.autoReady = false; return w as unknown as Worker; } }));
    await new Promise((r) => setTimeout(r, 0));
    w.reply({ type: 'error', message: 'boom' });
    await expect(p).rejects.toBe('unavailable');
    expect(w.terminated).toBe(true);
  });

  it('hands the worker every manifest file and the runtime WASM', async () => {
    const asked: string[] = [];
    await startEngine(deps({ file: async (n) => { asked.push(n); return new Uint8Array(1); } }));
    expect(asked.sort()).toEqual([...VOICE_FILES.map((f) => f.name), VOICE_RUNTIME_WASM].sort());
    const load = w.last('load');
    expect(Object.keys(load.files).sort()).toEqual(VOICE_FILES.map((f) => f.name).sort());
    expect(load.wasm).toBeInstanceOf(Uint8Array);
  });

  it('speak resolves after the worker posts done, and passes the speed', async () => {
    await startEngine(deps());
    let done = false;
    const p = speak('Hello there.', 1.25).then(() => { done = true; });
    const m = w.last('speak');
    expect(m).toMatchObject({ type: 'speak', text: 'Hello there.', speed: 1.25 });
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    w.reply({ type: 'done', id: m.id });
    await p;
    expect(done).toBe(true);
  });

  it('speak waits for the last sentence to finish playing, and stopSpeaking stops what plays', async () => {
    const sources: any[] = [];
    const ctx = {
      currentTime: 0, destination: {},
      createBuffer: (_c: number, n: number, rate: number) => ({ duration: n / rate, copyToChannel() {} }),
      createBufferSource: () => { const s: any = { connect() {}, start(at: number) { s.at = at; }, stop() { s.stopped = true; }, onended: null }; sources.push(s); return s; },
      close: async () => {},
    };
    await startEngine(deps({ audio: () => ctx as unknown as AudioContext }));
    let done = false;
    const p = speak('One. Two.', 1).then(() => { done = true; });
    const { id } = w.last('speak');
    w.reply({ type: 'audio', id, pcm: new Float32Array(24000), rate: 24000 });
    w.reply({ type: 'audio', id, pcm: new Float32Array(12000), rate: 24000 });
    w.reply({ type: 'done', id });
    expect(sources.map((s) => s.at)).toEqual([0, 1]); // queued back to back
    sources[0].onended();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    sources[1].onended();
    await p;
    // a second speech, stopped while it plays
    const q = speak('Three.', 1);
    const id2 = w.last('speak').id;
    w.reply({ type: 'audio', id: id2, pcm: new Float32Array(10), rate: 24000 });
    const staleId = id;
    w.reply({ type: 'audio', id: staleId, pcm: new Float32Array(10), rate: 24000 }); // a stale id plays nothing
    expect(sources).toHaveLength(3);
    stopSpeaking();
    await q;
    expect(sources[2].stopped).toBe(true);
  });

  it('stopSpeaking posts stop and resolves the pending speak', async () => {
    await startEngine(deps());
    const p = speak('A long reply.', 1);
    stopSpeaking();
    expect(w.last('stop')).toBeTruthy();
    await expect(p).resolves.toBeUndefined();
  });

  it('stopEngine while the files are still being read: no worker is made and the start rejects', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let made = 0;
    const p = startEngine(deps({ file: async () => { await gate; return new Uint8Array(1); }, worker: () => { made++; w = new FakeWorker(); return w as unknown as Worker; } }));
    stopEngine();
    release();
    await expect(p).rejects.toBe('unavailable');
    expect(made).toBe(0);
  });

  it('transcribe returns the worker text', async () => {
    await startEngine(deps());
    const pcm = new Float32Array(16000);
    const p = transcribe(pcm);
    const m = w.last('transcribe');
    expect(m.pcm).toBe(pcm);
    w.reply({ type: 'text', id: m.id, text: ' run the tests' });
    await expect(p).resolves.toBe(' run the tests');
  });

  it('stopEngine terminates the worker and rejects what is pending', async () => {
    await startEngine(deps());
    const t = transcribe(new Float32Array(10));
    stopEngine();
    expect(w.terminated).toBe(true);
    await expect(t).rejects.toBe('unavailable');
    await expect(transcribe(new Float32Array(10))).rejects.toBe('unavailable');
  });

  it('a worker crash rejects what is pending and ends the engine', async () => {
    await startEngine(deps());
    const t = transcribe(new Float32Array(10));
    w.onerror?.(new Event('error'));
    await expect(t).rejects.toBe('unavailable');
    expect(w.terminated).toBe(true);
  });
});

describe('voice worker has no network (source scan)', () => {
  const strip = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const src = strip('src/renderer/voice/worker.ts');
  const guard = strip('src/renderer/voice/net-guard.ts');
  it('imports the net guard first, before any library', () => {
    expect(src.match(/^import\s[^;]*;/m)?.[0]).toBe("import './net-guard';");
  });
  it('turns remote models off, feeds models only from the custom cache, one WASM thread, no proxy', () => {
    expect(src).toMatch(/env\.allowRemoteModels\s*=\s*false/);
    expect(src).toMatch(/env\.useCustomCache\s*=\s*true/);
    expect(src).toMatch(/env\.useBrowserCache\s*=\s*false/);
    // ORT would otherwise import its glue code from cdn.jsdelivr.net (transformers sets that default); cleared at module level
    expect(src).toMatch(/^ow\.wasmPaths\s*=\s*undefined;/m);
    expect(src).toMatch(/^ow\.numThreads\s*=\s*1;/m);
    expect(src).toMatch(/^ow\.proxy\s*=\s*false;/m);
  });
  it('the worker reaches no network API itself; the guard fetches only data: and blob:', () => {
    for (const s of [src, guard]) {
      expect(s).not.toMatch(/(?<![A-Za-z])fetch\(/); // only realFetch(, inside the guard
      expect(s).not.toMatch(/https?:\/\//);
      expect(s).not.toMatch(/importScripts\(|new XMLHttpRequest|new WebSocket|new EventSource|sendBeacon\(/);
    }
    expect(guard).toMatch(/startsWith\('data:'\) \|\| u\.startsWith\('blob:'\)/);
  });
  it('the main bundle never imports the worker or transformers.js', () => {
    const renderer = path.join(__dirname, '..', 'src/renderer');
    const offenders: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && p !== path.join(renderer, 'voice', 'worker.ts')) {
        const s = fs.readFileSync(p, 'utf8');
        if (/from\s+['"](@huggingface\/transformers|kokoro-js|phonemizer|onnxruntime-web)['"]/.test(s) || /^import\s+(?!type\b)[^;]*from\s+['"][./]*worker['"]/m.test(s)) offenders.push(p);
      }
    } };
    walk(renderer);
    expect(offenders).toEqual([]);
  });
});
