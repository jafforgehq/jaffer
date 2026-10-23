/**
 * Pause detection for a recording: fed one RMS per audio frame with its timestamp (ms, monotonic; the first push is t0).
 * 'speech' while loud, 'silence' while quiet (before or after speech) and still running, 'end' after SILENCE_END_MS of quiet
 * following speech or at MAX_RECORDING_MS, 'none' when NO_SPEECH_MS pass with no speech at all. 'end'/'none' are final.
 * SILENCE_END_MS (1.5 s) is the spec's. SPEECH_RMS, NO_SPEECH_MS and MAX_RECORDING_MS are plan ASSUMPTIONS, untuned on real mics.
 */
export const SPEECH_RMS = 0.01;
export const SILENCE_END_MS = 1500;
export const NO_SPEECH_MS = 8000;
export const MAX_RECORDING_MS = 60000;

export type EndOfSpeechResult = 'speech' | 'silence' | 'end' | 'none';

export class EndOfSpeech {
  private t0: number | undefined;
  private lastSpeech: number | undefined;
  private done: 'end' | 'none' | undefined;

  push(rms: number, tMs: number): EndOfSpeechResult {
    if (this.done) return this.done;
    this.t0 ??= tMs;
    const loud = rms >= SPEECH_RMS;
    if (loud) this.lastSpeech = tMs;
    if (tMs - this.t0 >= MAX_RECORDING_MS) return (this.done = 'end');
    if (this.lastSpeech !== undefined) {
      if (!loud && tMs - this.lastSpeech >= SILENCE_END_MS) return (this.done = 'end');
      return loud ? 'speech' : 'silence';
    }
    if (tMs - this.t0 >= NO_SPEECH_MS) return (this.done = 'none');
    return 'silence';
  }
}
