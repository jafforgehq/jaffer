import { describe, expect, it } from 'vitest';
import { contextShare, IMPATIENT_AFTER_MS, isNight, petFx, WINCE_MS, winceExit } from '../src/shared/pet-fx';

const base = { claude: 'idle' as const, tool: null, agents: 0, busy: false, now: 1_000_000 };

describe('petFx', () => {
  it('thinks while Claude works with no tool call open, no agents and no command', () => {
    expect(petFx({ ...base, claude: 'working' })).toBe('think');
    expect(petFx({ ...base, claude: 'working', tool: 'read' })).toBeNull();
    expect(petFx({ ...base, claude: 'working', agents: 1 })).toBeNull();
    expect(petFx({ ...base, claude: 'working', busy: true })).toBeNull();
  });

  it('winces for a moment after a failed command, then stops', () => {
    expect(petFx({ ...base, failedAt: base.now - 100 })).toBe('wince');
    expect(petFx({ ...base, failedAt: base.now - WINCE_MS })).toBeNull();
    expect(petFx({ ...base, failedAt: base.now + 5 })).toBeNull(); // (a clock that ran backwards)
  });

  it('packs boxes while Claude compacts, even over thinking', () => {
    expect(petFx({ ...base, claude: 'working', compacting: true })).toBe('compact');
  });

  it('gets insistent only after a long wait for the person, and never wince over a request', () => {
    expect(petFx({ ...base, claude: 'needs-you', since: base.now - 1000 })).toBeNull();
    expect(petFx({ ...base, claude: 'needs-you', since: base.now - IMPATIENT_AFTER_MS })).toBe('impatient');
    expect(petFx({ ...base, claude: 'needs-you', since: base.now - 1000, failedAt: base.now - 10 })).toBeNull();
  });
});

describe('winceExit', () => {
  it('is false for success, Ctrl-C and a killed program, true for other numbers', () => {
    for (const e of [0, 130, 143, null, undefined, 'x', NaN]) expect(winceExit(e)).toBe(false);
    for (const e of [1, 2, 127, 255]) expect(winceExit(e)).toBe(true);
  });
});

describe('contextShare', () => {
  it('is tokens over window, or null when unknown or inconsistent', () => {
    expect(contextShare({ tokens: 500, window: 1000 })).toBe(0.5);
    expect(contextShare({ tokens: 500 })).toBeNull();
    expect(contextShare({ tokens: 2000, window: 1000 })).toBeNull();
    expect(contextShare(undefined)).toBeNull();
    expect(contextShare({ tokens: 0, window: 1000 })).toBeNull();
  });
});

describe('isNight', () => {
  it('is 23:00 to 05:59', () => {
    expect(isNight(new Date(2026, 0, 1, 23, 0))).toBe(true);
    expect(isNight(new Date(2026, 0, 1, 5, 59))).toBe(true);
    expect(isNight(new Date(2026, 0, 1, 6, 0))).toBe(false);
    expect(isNight(new Date(2026, 0, 1, 14, 0))).toBe(false);
  });
});
