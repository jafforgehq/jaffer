/**
 * The recorder's AudioWorklet (built to `dist/renderer/voice-recorder.worklet.js`, loaded by `recorder.ts`): collects the microphone's
 * first channel in blocks of 2048 samples (128 ms at 16 kHz) and posts each with its RMS, the buffer transferred. Nothing else.
 */
declare const registerProcessor: (name: string, ctor: unknown) => void;
declare class AudioWorkletProcessor { readonly port: MessagePort }

const N = 2048;

class Recorder extends AudioWorkletProcessor {
  private buf = new Float32Array(N);
  private n = 0;
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]!;
      if (this.n < N) continue;
      let s = 0;
      for (let j = 0; j < N; j++) s += this.buf[j]! * this.buf[j]!;
      this.port.postMessage({ rms: Math.sqrt(s / N), samples: this.buf }, [this.buf.buffer]);
      this.buf = new Float32Array(N);
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('jaffer-recorder', Recorder);
export {};
