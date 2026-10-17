import { describe, expect, it } from 'vitest';
import { screenReaderOn } from '../src/shared/screen-reader';

describe('screenReaderOn: when the terminal exposes its text to a screen reader', () => {
  it('on is always, off is never, auto follows what macOS reports', () => {
    expect(screenReaderOn('on', false)).toBe(true);
    expect(screenReaderOn('on', true)).toBe(true);
    expect(screenReaderOn('off', true)).toBe(false);
    expect(screenReaderOn('off', false)).toBe(false);
    expect(screenReaderOn('auto', true)).toBe(true);
    expect(screenReaderOn('auto', false)).toBe(false);
  });
  it('an unknown value counts as auto', () => {
    for (const m of ['', 'yes', 'ON', 'true', 'auto ', undefined as unknown as string]) {
      expect(screenReaderOn(m, true)).toBe(true);
      expect(screenReaderOn(m, false)).toBe(false);
    }
  });
});
