import { describe, expect, it } from 'vitest';
import { keepRunningOffText } from '../src/shared/keep-running';

describe('keepRunningOffText (the question the app asks before the switch is turned off while macOS runs the session)', () => {
  it('says the session ends now, what stops, that a Claude Code conversation can be resumed, and why it ends', () => {
    const t = keepRunningOffText();
    expect(t.message).toBe('Turn off keeping your session running?');
    expect(t.detail.startsWith('This ends your terminal session now: your shell and anything running in it stop (a Claude Code conversation can be resumed afterwards).')).toBe(true);
    expect(t.detail).toMatch(/macOS/); // why it ends: macOS (launchd) is what runs the session right now
    expect(t.detail).not.toMatch(/launchctl|bootout|SIGTERM/); // in the person's words
  });

  it('offers Cancel first (the default, and what Escape does) and says on the other button what it does', () => {
    expect(keepRunningOffText().buttons).toEqual(['Cancel', 'Turn off and end the session']);
  });
});
