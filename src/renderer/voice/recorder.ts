/**
 * One recording from the microphone (spec "Voice mode"; the only place that calls `getUserMedia`, a source scan pins it). Mono audio with
 * echo cancellation and noise suppression, through an `AudioContext` at 16 kHz (Chromium resamples the device), to the worklet
 * `voice-recorder.worklet.js` (built from `recorder.worklet.ts`, loaded by a relative URL next to the page: `script-src 'self'`), which
 * posts each ~2048 samples with their RMS. `EndOfSpeech` decides the end; its clock is the sample count (always finite, and it cannot
 * drift from the audio). Resolves with the samples on 'end' (1.5 s of quiet after speech, or 60 s), null on 'none' (8 s without speech)
 * or abort; a `getUserMedia` refusal rejects `'mic-denied'` (NotAllowedError, SecurityError) or `'mic-missing'` (anything else).
 * Every path stops every track and closes the context. The samples live in memory for the call only: never logged, never written.
 */
import { EndOfSpeech } from '../../shared/voice-vad';

export type MicError = 'mic-denied' | 'mic-missing';
export const RECORDER_WORKLET = 'voice-recorder.worklet.js';
export const RECORDER_NAME = 'jaffer-recorder';
const RATE = 16000;

export async function record(opts: { onLevel?(rms: number): void; signal: AbortSignal; mediaDevices?: MediaDevices }): Promise<Float32Array | null> {
  if (opts.signal.aborted) return null;
  let stream: MediaStream;
  try {
    stream = await (opts.mediaDevices ?? navigator.mediaDevices).getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    throw (name === 'NotAllowedError' || name === 'SecurityError' ? 'mic-denied' : 'mic-missing') satisfies MicError;
  }
  let ctx: AudioContext | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let onAbort = () => {};
  try {
    if (opts.signal.aborted) return null;
    ctx = new AudioContext({ sampleRate: RATE });
    await ctx.audioWorklet.addModule(RECORDER_WORKLET);
    if (opts.signal.aborted) return null;
    const rate = Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : RATE;
    src = ctx.createMediaStreamSource(stream);
    // no outputs: a sink, which Chromium runs without a connection to the speakers (so nothing of the microphone is played back)
    const n = (node = new AudioWorkletNode(ctx, RECORDER_NAME, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 }));
    const eos = new EndOfSpeech();
    const chunks: Float32Array[] = [];
    let total = 0;
    return await new Promise<Float32Array | null>((resolve) => {
      onAbort = () => resolve(null);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      n.port.onmessage = (e: MessageEvent<{ rms?: unknown; samples?: unknown }>) => {
        const samples = e.data?.samples;
        if (!(samples instanceof Float32Array)) return;
        chunks.push(samples);
        total += samples.length;
        const rms = typeof e.data.rms === 'number' && Number.isFinite(e.data.rms) ? e.data.rms : 0; // (only finite numbers reach EndOfSpeech)
        opts.onLevel?.(rms);
        const r = eos.push(rms, (total / rate) * 1000);
        if (r === 'none') resolve(null);
        else if (r === 'end') {
          const out = new Float32Array(total);
          let o = 0;
          for (const c of chunks) (out.set(c, o), (o += c.length));
          chunks.length = 0;
          resolve(out);
        }
      };
      src!.connect(n);
    });
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    if (node) { node.port.onmessage = null; try { node.disconnect(); } catch { /* not connected */ } }
    try { src?.disconnect(); } catch { /* not connected */ }
    for (const t of stream.getTracks()) t.stop();
    void ctx?.close().catch(() => {});
  }
}
