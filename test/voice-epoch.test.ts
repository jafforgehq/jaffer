import { describe, expect, it } from 'vitest';
import { VoiceEpoch } from '../src/shared/voice-epoch';

describe('VoiceEpoch', () => {
  it('unchanged between the read and the start: starts', () => {
    const e = new VoiceEpoch();
    const t = e.take();
    expect(e.still(t)).toBe(true);
  });
  it('a cancel or voice-off between the read and the start prevents it', () => {
    const e = new VoiceEpoch();
    const t = e.take();
    e.bump();
    expect(e.still(t)).toBe(false);
    expect(e.still(e.take())).toBe(true); // a later, fresh ask is fine
  });
});
