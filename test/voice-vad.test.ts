import { describe, expect, it } from 'vitest';
import { EndOfSpeech, MAX_RECORDING_MS, NO_SPEECH_MS, SILENCE_END_MS, SPEECH_RMS } from '../src/shared/voice-vad';

const LOUD = SPEECH_RMS * 5;
const run = (e: EndOfSpeech, from: number, to: number, rms: number, last: { v?: string } = {}) => {
  for (let t = from; t <= to; t += 100) last.v = e.push(rms, t);
  return last.v;
};

describe('EndOfSpeech', () => {
  it('ends after 1.5 s of silence following speech', () => {
    const e = new EndOfSpeech();
    expect(run(e, 0, 1000, LOUD)).toBe('speech');
    expect(e.push(0, 1000 + SILENCE_END_MS - 100)).toBe('silence');
    expect(e.push(0, 1000 + SILENCE_END_MS)).toBe('end');
    expect(e.push(LOUD, 99999)).toBe('end');
  });
  it('gives none after 8 s with no speech, and keeps saying so', () => {
    const e = new EndOfSpeech();
    expect(run(e, 0, NO_SPEECH_MS - 100, 0)).toBe('silence');
    expect(e.push(0, NO_SPEECH_MS)).toBe('none');
    expect(e.push(LOUD, NO_SPEECH_MS + 100)).toBe('none');
  });
  it('ends at the 60 s limit while speech continues', () => {
    const e = new EndOfSpeech();
    expect(run(e, 5000, MAX_RECORDING_MS + 4900, LOUD)).toBe('speech');
    expect(e.push(LOUD, 5000 + MAX_RECORDING_MS)).toBe('end');
  });
  it('a short dip keeps going', () => {
    const e = new EndOfSpeech();
    run(e, 0, 1000, LOUD);
    expect(e.push(0, 2400)).toBe('silence');
    expect(e.push(LOUD, 2500)).toBe('speech');
  });
});
