import { describe, expect, it } from 'vitest';
import { cleanDictation, mayType } from '../src/shared/voice-policy';

const ok = { voiceOn: true, startPane: 'main', activePane: 'main', claudeState: 'idle', typing: false };

describe('mayType', () => {
  it('allows when all hold', () => expect(mayType(ok)).toEqual({ ok: true }));
  it.each([
    ['voice off', { voiceOn: false }],
    ['pane changed', { activePane: 'p2' }],
    ['no claude', { claudeState: undefined }],
    ['ended', { claudeState: 'ended' }],
    ['working', { claudeState: 'working' }],
    ['needs you', { claudeState: 'needs-you' }],
    ['typing in flight', { typing: true }],
  ])('refuses: %s', (_n, o) => {
    const r = mayType({ ...ok, ...o });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why.length).toBeGreaterThan(0);
  });
});

describe('cleanDictation', () => {
  it('removes control characters, ESC and sequences', () => {
    const r = cleanDictation('hi\r\nthere\x1b[201~ \x07');
    expect(r).toBe('hi there');
    expect(cleanDictation('a\x1b[31mred\x1b[0m \x1b]0;t\x07b\x00\x7f\u0085 ‮​c')).toBe('a red b c');
    expect(cleanDictation('x\x1b')).toBe('x');
    expect(cleanDictation('\x1b[200~ls\x1b[201~')).not.toContain('\x1b');
  });
  it('cuts to 500 code points', () => {
    expect(cleanDictation('a'.repeat(600))).toHaveLength(500);
    expect(Array.from(cleanDictation('😀a'.repeat(300)))).toHaveLength(500);
  });
  it('returns empty for noise', () => {
    for (const n of ['[BLANK_AUDIO]', '(music)', '[Music]', '(silence)', '*sighs*', '♪♪', ' . ', '', '[Music] (silence)', '...']) expect(cleanDictation(n), n).toBe('');
    expect(cleanDictation('fix the bug (music)')).toBe('fix the bug (music)');
  });
  it('is linear on huge lines', () => {
    for (const unit of ['a', '[', '(', '*', '\x1b[', '\x1b]', ' ']) {
      for (const n of [1 << 20, 8 << 20]) {
        const t = Date.now();
        cleanDictation(unit.repeat(n));
        expect(Date.now() - t).toBeLessThan(1000);
      }
    }
  });
});
