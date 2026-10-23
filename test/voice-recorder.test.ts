import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { record, RECORDER_NAME, RECORDER_WORKLET } from '../src/renderer/voice/recorder';

/** `record()` against a fake MediaDevices, AudioContext and worklet port: the worklet's frames are pushed by hand (2048 samples = 128 ms at 16 kHz). */
const tick = () => new Promise((r) => setTimeout(r, 0));
const FRAME = 2048;

let tracks: Array<{ stopped: boolean; stop(): void }>;
let asked: MediaStreamConstraints | undefined;
let ctxs: Array<{ closed: boolean; opts: unknown; module?: string }>;
let nodes: Array<{ port: { onmessage: ((e: { data: unknown }) => void) | null }; name: string; connected: boolean }>;
let deny: string | null;

const mediaDevices = () => ({
  getUserMedia: async (c: MediaStreamConstraints) => {
    asked = c;
    if (deny) throw Object.assign(new Error('no'), { name: deny });
    return { getTracks: () => tracks };
  },
}) as unknown as MediaDevices;

beforeEach(() => {
  tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  ctxs = [];
  nodes = [];
  deny = null;
  asked = undefined;
  (globalThis as any).AudioContext = class {
    sampleRate = 16000;
    closed = false;
    module?: string;
    audioWorklet = { addModule: async (u: string) => void (this.module = u) };
    constructor(public opts: unknown) { ctxs.push(this); }
    createMediaStreamSource() { const n = nodes; return { connect: () => void (n.at(-1)!.connected = true), disconnect() {} }; }
    close() { this.closed = true; return Promise.resolve(); }
  };
  (globalThis as any).AudioWorkletNode = class {
    port = { onmessage: null };
    connected = false;
    constructor(_c: unknown, public name: string) { nodes.push(this as any); }
    disconnect() {}
  };
});
afterEach(() => { delete (globalThis as any).AudioContext; delete (globalThis as any).AudioWorkletNode; });

const ready = async () => { for (let i = 0; i < 10 && !nodes[0]?.port.onmessage; i++) await tick(); expect(nodes[0]?.port.onmessage).toBeTruthy(); };
const push = (rms: number, n = 1) => { for (let i = 0; i < n; i++) nodes[0]!.port.onmessage!({ data: { rms, samples: new Float32Array(FRAME).fill(rms) } }); };
const allStopped = () => tracks.every((t) => t.stopped) && ctxs.every((c) => c.closed);

describe('record()', () => {
  it('asks for mono audio with echo cancellation and noise suppression, at 16 kHz, through the worklet file next to the page', async () => {
    const ctl = new AbortController();
    const p = record({ signal: ctl.signal, mediaDevices: mediaDevices() });
    await ready();
    expect(asked).toEqual({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    expect(ctxs[0]!.opts).toEqual({ sampleRate: 16000 });
    expect(ctxs[0]!.module).toBe(RECORDER_WORKLET);
    expect(RECORDER_WORKLET).toBe('voice-recorder.worklet.js');
    expect(nodes[0]!.name).toBe(RECORDER_NAME);
    expect(nodes[0]!.connected).toBe(true);
    ctl.abort();
    await p;
  });

  it('resolves with the 16 kHz samples after speech then 1.5 s of silence; every track stopped, the context closed', async () => {
    const levels: number[] = [];
    const p = record({ signal: new AbortController().signal, mediaDevices: mediaDevices(), onLevel: (r) => levels.push(r) });
    await ready();
    push(0, 2);
    push(0.2, 5);
    push(0.001, 11); // 11 × 128 ms = 1408 ms: not yet
    let done = false;
    void p.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    push(0.001, 1); // 1536 ms of quiet
    const pcm = await p;
    expect(pcm).toBeInstanceOf(Float32Array);
    expect(pcm!.length).toBe(19 * FRAME);
    expect(pcm![2 * FRAME]).toBeCloseTo(0.2);
    expect(levels.length).toBe(19);
    expect(allStopped()).toBe(true);
  });

  it('a NaN level counts as quiet and never stops the clock (time comes from the sample count)', async () => {
    const p = record({ signal: new AbortController().signal, mediaDevices: mediaDevices() });
    await ready();
    push(Number.NaN, 64); // 8064 ms after the first frame, nothing heard
    expect(await p).toBeNull();
  });

  it('resolves null when nothing is said for 8 s; every track stopped', async () => {
    const p = record({ signal: new AbortController().signal, mediaDevices: mediaDevices() });
    await ready();
    push(0.001, 64);
    expect(await p).toBeNull();
    expect(allStopped()).toBe(true);
  });

  it('resolves null on abort, also before the microphone opened; every track stopped', async () => {
    const ctl = new AbortController();
    const p = record({ signal: ctl.signal, mediaDevices: mediaDevices() });
    await ready();
    push(0.2, 3);
    ctl.abort();
    expect(await p).toBeNull();
    expect(allStopped()).toBe(true);
    expect(nodes[0]!.port.onmessage).toBeNull();

    const early = new AbortController();
    const q = record({ signal: early.signal, mediaDevices: mediaDevices() });
    early.abort(); // (while getUserMedia is still answering)
    expect(await q).toBeNull();
    expect(allStopped()).toBe(true);
  });

  it('stops at 60 s even while the person keeps talking', async () => {
    const p = record({ signal: new AbortController().signal, mediaDevices: mediaDevices() });
    await ready();
    push(0.2, 470); // 60.03 s after the first frame
    expect((await p)!.length).toBe(470 * FRAME);
  });

  it('a refused microphone rejects mic-denied, a missing one mic-missing; nothing is left open', async () => {
    deny = 'NotAllowedError';
    await expect(record({ signal: new AbortController().signal, mediaDevices: mediaDevices() })).rejects.toBe('mic-denied');
    deny = 'NotFoundError';
    await expect(record({ signal: new AbortController().signal, mediaDevices: mediaDevices() })).rejects.toBe('mic-missing');
    expect(ctxs.length).toBe(0);
  });
});
