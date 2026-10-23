import { describe, expect, it } from 'vitest';
import { aboutMb, percent, voiceErrorSentence } from '../src/shared/voice-ui';
import { VOICE_TOTAL_BYTES } from '../src/shared/voice-manifest';

describe('voice-ui', () => {
  it('rounds the download size to the nearest 5 MB', () => {
    expect(VOICE_TOTAL_BYTES).toBe(172_995_806);
    expect(aboutMb()).toBe(175);
    expect(aboutMb(172_400_000)).toBe(170);
    expect(aboutMb(1)).toBe(5);
  });
  it('gives a plain sentence per code, with no path', () => {
    for (const c of ['network', 'checksum', 'host', 'aborted', 'unknown', 'toString', 5, undefined]) {
      const s = voiceErrorSentence(c);
      expect(s).toMatch(/\.$/);
      expect(s).not.toMatch(/[/\\]/);
    }
    expect(voiceErrorSentence('network')).toMatch(/network/);
    expect(voiceErrorSentence('toString')).toBe(voiceErrorSentence('unknown'));
  });
  it('percent is clamped', () => {
    expect(percent(50, 200)).toBe(25);
    expect(percent(5, 0)).toBe(0);
    expect(percent(300, 200)).toBe(100);
  });
});
