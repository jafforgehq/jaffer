import { describe, expect, it } from 'vitest';
import { pageMayUseMic } from '../src/shared/voice-permission';

describe('pageMayUseMic', () => {
  it('grants audio when voice is on', () => expect(pageMayUseMic(true, 'media', ['audio'])).toBe(true));
  it('refuses audio when voice is off', () => expect(pageMayUseMic(false, 'media', ['audio'])).toBe(false));
  it('refuses video, audio plus video, unstated kinds and any other permission', () => {
    expect(pageMayUseMic(true, 'media', ['video'])).toBe(false);
    expect(pageMayUseMic(true, 'media', ['audio', 'video'])).toBe(false);
    expect(pageMayUseMic(true, 'media', ['unknown'])).toBe(false);
    expect(pageMayUseMic(true, 'media', [])).toBe(false);
    expect(pageMayUseMic(true, 'media', undefined)).toBe(false);
    for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'geolocation', 'mediaKeySystem']) expect(pageMayUseMic(true, p, ['audio'])).toBe(false);
  });
});
