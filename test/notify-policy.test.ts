import { describe, expect, it } from 'vitest';
import { needsYouNotification } from '../src/shared/notify-policy';
import type { ClaudeSession, ClaudeState } from '../src/core/claude/watcher';

const s = (state: ClaudeState, notice?: string, id = 's1'): ClaudeSession => ({ id, cwd: '/work/app', state, since: 1, activity: [], subagents: [], notice });
const away = { windowFocused: false, lastTerminalNotifyAt: 0, now: 100_000 };

describe('needsYouNotification', () => {
  it('fires when a session newly enters needs-you, with the notice as the body', () => {
    expect(needsYouNotification([s('working')], [s('needs-you', 'Claude needs your permission to use Bash')], away)).toEqual({ title: 'Claude needs you', body: 'Claude needs your permission to use Bash' });
  });

  it('counts a session that first shows up already waiting, and falls back to a plain body without a notice', () => {
    expect(needsYouNotification([], [s('needs-you')], away)).toEqual({ title: 'Claude needs you', body: 'Claude is waiting for your permission.' });
  });

  it('does not fire again while the session stays in needs-you', () => {
    expect(needsYouNotification([s('needs-you', 'x')], [s('needs-you', 'x')], away)).toBeNull();
  });

  it('does not fire for other transitions', () => {
    for (const next of ['working', 'idle', 'ended'] as const) expect(needsYouNotification([s('idle')], [s(next)], away)).toBeNull();
  });

  it('does not fire while the window is focused: the panel is in front of the user', () => {
    expect(needsYouNotification([s('working')], [s('needs-you', 'x')], { ...away, windowFocused: true })).toBeNull();
  });

  it('does not fire if a terminal notification was shown in the previous 10 seconds (one alert per event)', () => {
    expect(needsYouNotification([s('working')], [s('needs-you', 'x')], { ...away, lastTerminalNotifyAt: 100_000 - 9_999 })).toBeNull();
    expect(needsYouNotification([s('working')], [s('needs-you', 'x')], { ...away, lastTerminalNotifyAt: 100_000 - 10_000 })).not.toBeNull();
  });
});
