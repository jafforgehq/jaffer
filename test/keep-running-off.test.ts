import { describe, expect, it } from 'vitest';
import { errorText, isOldDaemonError, keepRunningOffText, OLD_DAEMON_TEXT, turnKeepRunningOff, type AgentStatus } from '../src/shared/keep-running';

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

describe('turnKeepRunningOff (every switch-off in Settings goes through it: the main process, and the bridge of the UI tests)', () => {
  const off = (now: AgentStatus, answer: boolean) => {
    const calls: string[] = [];
    const result = turnKeepRunningOff({
      status: async () => (calls.push('status'), now),
      ask: async () => (calls.push('ask'), answer),
      remove: async () => (calls.push('remove'), { state: 'not-installed' }),
    });
    return { result, calls };
  };

  it('asks the daemon how it stands now (not what the window saw), and the person only when launchd runs the session: No changes nothing, Yes removes', async () => {
    const no = off({ state: 'running', pid: 4242 }, false);
    expect(await no.result).toEqual({ cancelled: true });
    expect(no.calls).toEqual(['status', 'ask']);
    const yes = off({ state: 'running', pid: 4242 }, true);
    expect(await yes.result).toEqual({ cancelled: false, status: { state: 'not-installed' } });
    expect(yes.calls).toEqual(['status', 'ask', 'remove']);
  });

  it('when launchd does not run the session (installed, not loaded, nothing, refused) nothing ends, so nothing is asked', async () => {
    for (const now of [{ state: 'installed' }, { state: 'not-loaded' }, { state: 'not-installed' }, { state: 'refused', reason: 'another home' }] as AgentStatus[]) {
      const t = off(now, false);
      expect(await t.result, now.state).toEqual({ cancelled: false, status: { state: 'not-installed' } });
      expect(t.calls, now.state).toEqual(['status', 'remove']);
    }
  });
});

// A session daemon from before 0.5 (an app updated by dragging it in keeps the old daemon until the session restarts) answers what 0.5
// added with "unknown method": the CLI and the window say what Settings already says, with one helper.
describe('what is said to a person whose session daemon is older than the app (errorText, the CLI and the window)', () => {
  it('an unknown method among claude.restart*, service.* and claude.autoresume.* reads "Restart your session to use this", also as the app hands it to the window', () => {
    expect(OLD_DAEMON_TEXT).toBe('Restart your session to use this');
    for (const m of ['claude.restart.plan', 'claude.restart', 'service.status', 'service.install', 'service.remove', 'claude.autoresume.cancel', 'claude.autoresume.state']) {
      expect(errorText(new Error(`unknown method: ${m}`)), m).toBe(OLD_DAEMON_TEXT);
      expect(errorText(new Error(`Error invoking remote method 'jaffer:restart-claude': Error: unknown method: ${m}`)), m).toBe(OLD_DAEMON_TEXT);
      expect(isOldDaemonError(`unknown method: ${m}`), m).toBe(true);
    }
  });

  it('anything else is said as it is', () => {
    expect(errorText(new Error('The session daemon is not connected.'))).toBe('The session daemon is not connected.');
    expect(errorText(new Error('unknown method: pane.split'))).toBe('unknown method: pane.split'); // not something 0.5 added
    expect(errorText('plain words')).toBe('plain words');
    expect(isOldDaemonError(new Error('timeout: service.status'))).toBe(false);
    expect(isOldDaemonError(undefined)).toBe(false);
  });
});
