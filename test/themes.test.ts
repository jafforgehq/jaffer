import { describe, expect, it } from 'vitest';
import { resolveTheme, windowOpacity } from '../src/renderer/themes';

const base = { theme: 'nord', lightTheme: 'jaffer-light', systemDark: true, hour: 12 };

describe('resolveTheme: which theme is on, from the setting, macOS appearance and the hour (pure)', () => {
  it('off: always the chosen theme', () => {
    for (const hour of [0, 7, 12, 19]) for (const systemDark of [true, false]) expect(resolveTheme({ ...base, autoTheme: 'off', systemDark, hour }).id).toBe('nord');
  });

  it('system: the chosen theme in dark mode, the light theme in light mode', () => {
    expect(resolveTheme({ ...base, autoTheme: 'system', systemDark: true }).id).toBe('nord');
    expect(resolveTheme({ ...base, autoTheme: 'system', systemDark: false }).id).toBe('jaffer-light');
    expect(resolveTheme({ ...base, autoTheme: 'system', systemDark: false, hour: 2 }).id).toBe('jaffer-light'); // (the hour does not matter)
  });

  it('time: the light theme from 07:00 to 18:59, the chosen theme otherwise (the hour is 0..23)', () => {
    const at = (hour: number) => resolveTheme({ ...base, autoTheme: 'time', hour }).id;
    expect(at(0)).toBe('nord');
    expect(at(6)).toBe('nord'); // 06:59
    expect(at(7)).toBe('jaffer-light'); // 07:00
    expect(at(12)).toBe('jaffer-light');
    expect(at(18)).toBe('jaffer-light'); // 18:59
    expect(at(19)).toBe('nord'); // 19:00
    expect(at(23)).toBe('nord');
    expect(at(Number.NaN)).toBe('nord');
    expect(resolveTheme({ ...base, autoTheme: 'time', systemDark: false, hour: 3 }).id).toBe('nord'); // (macOS does not matter)
  });

  it('an unknown theme id falls back to the first theme, an unknown mode to off', () => {
    expect(resolveTheme({ ...base, autoTheme: 'system', systemDark: false, lightTheme: 'nope' }).id).toBe('jaffer-dark');
    expect(resolveTheme({ ...base, autoTheme: 'off', theme: 'nope' }).id).toBe('jaffer-dark');
    expect(resolveTheme({ ...base, autoTheme: 'sunset', systemDark: false, hour: 12 }).id).toBe('nord');
  });
});

describe('windowOpacity: the slider counts only while the window blurs what is behind it', () => {
  it('blur off (or anything but true) means opaque, blur on the slider', () => {
    expect(windowOpacity({ opacity: 0.8, blur: true })).toBe(0.8);
    expect(windowOpacity({ opacity: 0.8, blur: false })).toBe(1);
  });
});
