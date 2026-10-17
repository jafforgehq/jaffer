import { describe, expect, it } from 'vitest';
import { CRASH_DIALOG, CRASH_RELOADS, CRASH_WINDOW_MS, crashAction } from '../src/shared/crash-policy';

/** (1.4.1) A window whose page crashed or hangs is reloaded (the terminals run on in the daemon); a page that keeps crashing asks instead. */

const NOW = 1_000_000;

describe('crashAction', () => {
  it('a page that ended cleanly is left alone', () => {
    expect(crashAction({ reason: 'clean-exit', recent: [], now: NOW })).toBe('ignore');
  });

  it('a crash, a kill, an OOM or a hang reloads the page while fewer than 3 reloads happened in the last 60 s', () => {
    for (const reason of ['crashed', 'killed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'unresponsive']) {
      expect(crashAction({ reason, recent: [], now: NOW }), reason).toBe('reload');
      expect(crashAction({ reason, recent: [NOW - 5_000, NOW - 1_000], now: NOW }), reason).toBe('reload');
    }
  });

  it('the 4th crash within 60 s asks instead of reloading again (no reload loop)', () => {
    expect(CRASH_RELOADS).toBe(3);
    expect(CRASH_WINDOW_MS).toBe(60_000);
    expect(crashAction({ reason: 'crashed', recent: [NOW - 30_000, NOW - 20_000, NOW - 10_000], now: NOW })).toBe('ask');
    expect(crashAction({ reason: 'unresponsive', recent: [NOW - 3, NOW - 2, NOW - 1], now: NOW })).toBe('ask');
  });

  it('reloads older than 60 s age out', () => {
    expect(crashAction({ reason: 'crashed', recent: [NOW - 60_001, NOW - 20_000, NOW - 10_000], now: NOW })).toBe('reload');
    expect(crashAction({ reason: 'crashed', recent: [NOW - 200_000, NOW - 120_000, NOW - 61_000], now: NOW })).toBe('reload');
    // exactly 60 s ago still counts
    expect(crashAction({ reason: 'crashed', recent: [NOW - 60_000, NOW - 20_000, NOW - 10_000], now: NOW })).toBe('ask');
  });

  it('the question: Reload is the default and what Esc does (a stray key must not end every terminal), Quit the other button', () => {
    expect(CRASH_DIALOG).toEqual({
      message: 'The window stopped responding.',
      detail: 'Your terminals are still running. Reload the window, or quit Jaffer (quitting ends them).',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    });
  });
});
