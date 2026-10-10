import { describe, expect, it } from 'vitest';
import { childExitAction, childExitText, LEGACY_DIALOG, LEGACY_NOT_ENDED, legacyDaemonAction, QUIT_BUTTONS, QUIT_CANCEL_ID, QUIT_DEFAULT_ID, quitNeedsConfirm, shouldAskOnQuit } from '../src/shared/quit-policy';

/** The app owns its terminal: quitting ends it, so the app asks when something would stop; another Jaffer's background session is ended only on a click. */

describe('quitNeedsConfirm: ⌘Q asks only when something would stop', () => {
  it('nothing runs: no question, the app quits', () => {
    expect(quitNeedsConfirm({ claudeWorking: false, commandRunning: false })).toBeNull();
  });
  it('Claude Code works or waits: it says that Claude Code will stop', () => {
    expect(quitNeedsConfirm({ claudeWorking: true, commandRunning: false })).toEqual({ message: 'Quit Jaffer?', detail: 'Claude Code is running and will stop.' });
  });
  it('a command runs: it says that the command will stop', () => {
    expect(quitNeedsConfirm({ claudeWorking: false, commandRunning: true })).toEqual({ message: 'Quit Jaffer?', detail: 'A command is running and will stop.' });
  });
  it('both: the Claude Code text (the command is Claude Code, or the bigger loss)', () => {
    expect(quitNeedsConfirm({ claudeWorking: true, commandRunning: true })).toEqual({ message: 'Quit Jaffer?', detail: 'Claude Code is running and will stop.' });
  });
  it('the buttons are Quit and Cancel', () => {
    expect(QUIT_BUTTONS).toEqual(['Quit', 'Cancel']);
  });
  it('Return and Esc both mean Cancel: a stray Return (typing into Claude as the question appears) never ends it', () => {
    expect(QUIT_BUTTONS[QUIT_DEFAULT_ID]).toBe('Cancel');
    expect(QUIT_BUTTONS[QUIT_CANCEL_ID]).toBe('Cancel');
  });
});

describe('legacyDaemonAction: a session on the socket that is not this app\'s child is an older Jaffer\'s', () => {
  it('nothing answers: start the app\'s own terminal', () => {
    expect(legacyDaemonAction({ answers: false, pid: null, ownPid: null, firstInstance: true })).toBe('start');
    expect(legacyDaemonAction({ answers: false, pid: null, ownPid: 4242, firstInstance: true })).toBe('start');
  });
  it('a daemon answers at the first start (the app has no child yet): ask before ending it', () => {
    expect(legacyDaemonAction({ answers: true, pid: 4242, ownPid: null, firstInstance: true })).toBe('ask');
  });
  it('a daemon answers that is not this app\'s child: ask', () => {
    expect(legacyDaemonAction({ answers: true, pid: 4242, ownPid: 5151, firstInstance: true })).toBe('ask');
  });
  it('something accepts the connection but says nothing of itself (an old daemon that hangs): ask too, never take it for the app\'s own', () => {
    expect(legacyDaemonAction({ answers: true, pid: null, ownPid: null, firstInstance: true })).toBe('ask');
    expect(legacyDaemonAction({ answers: true, pid: null, ownPid: 5151, firstInstance: true })).toBe('ask');
  });
  it('the app\'s own child: nothing to ask', () => {
    expect(legacyDaemonAction({ answers: true, pid: 5151, ownPid: 5151, firstInstance: true })).toBe('ours');
  });
  it('the question says what it is and what ending it means, with End it and Quit', () => {
    expect(LEGACY_DIALOG.message).toBe('Another Jaffer session is running in the background.'); // (neutral: it need not be an older version)
    expect(LEGACY_DIALOG.detail).toMatch(/no longer keeps sessions running/);
    expect(LEGACY_DIALOG.detail).toMatch(/End it and start a fresh terminal\?/);
    expect(LEGACY_DIALOG.buttons).toEqual(['End it', 'Quit']);
  });
  it('Return and Esc both mean Quit, the choice that ends nothing: only a click on End it ends that session', () => {
    expect(LEGACY_DIALOG.buttons[LEGACY_DIALOG.defaultId]).toBe('Quit');
    expect(LEGACY_DIALOG.buttons[LEGACY_DIALOG.cancelId]).toBe('Quit');
  });
  it('a second instance of the app (opened from the disk image, `open -n`) never asks and never ends anything: what answers is the first instance\'s own terminal', () => {
    for (const pid of [4242, null]) expect(legacyDaemonAction({ answers: true, pid, ownPid: null, firstInstance: false })).toBe('leave');
    expect(legacyDaemonAction({ answers: false, pid: null, ownPid: null, firstInstance: false })).toBe('leave');
  });
  it('when that session does not end, the advice is one that works: Activity Monitor or a restart, not the request that just failed', () => {
    expect(LEGACY_NOT_ENDED.message).toMatch(/did not end/);
    expect(LEGACY_NOT_ENDED.detail).toMatch(/Activity Monitor/);
    expect(LEGACY_NOT_ENDED.detail).toMatch(/the other Jaffer process/); // (the name Activity Monitor shows: the daemon is the app's own binary)
    expect(LEGACY_NOT_ENDED.detail).not.toMatch(/jafferd/);
    expect(LEGACY_NOT_ENDED.detail).toMatch(/restart the Mac/);
    expect(LEGACY_NOT_ENDED.detail).not.toMatch(/jaffer daemon stop|app\.shutdown/);
  });
});

describe('childExitAction: what the app does when its terminal host ends', () => {
  it('the app ended it itself (quit, update, Reset): nothing more', () => {
    expect(childExitAction({ code: 0, signal: null, quitting: true })).toBe('ignore');
    expect(childExitAction({ code: null, signal: 'SIGKILL', quitting: true })).toBe('ignore');
  });
  it('it ended with 0 on its own: a client ended the session (`jaffer reset`, `jaffer daemon stop`), and the app quits with it', () => {
    expect(childExitAction({ code: 0, signal: null, quitting: false })).toBe('quit');
  });
  it('a crash or a signal: offer a fresh terminal or Quit', () => {
    expect(childExitAction({ code: 1, signal: null, quitting: false })).toBe('offer-restart');
    expect(childExitAction({ code: 143, signal: null, quitting: false })).toBe('offer-restart');
    expect(childExitAction({ code: null, signal: 'SIGKILL', quitting: false })).toBe('offer-restart');
  });
  it('the offer says how it ended, with Restart terminal and Quit', () => {
    const crash = childExitText({ code: 1, signal: null, log: '/x/jafferd.log' });
    expect(crash.message).toMatch(/terminal stopped/i);
    expect(crash.detail).toMatch(/code 1/);
    expect(crash.detail).toContain('/x/jafferd.log');
    expect(crash.buttons).toEqual(['Restart terminal', 'Quit']);
    expect(childExitText({ code: null, signal: 'SIGKILL', log: '/x/jafferd.log' }).detail).toMatch(/SIGKILL/);
  });
});

describe('shouldAskOnQuit: only ⌘Q asks; a quit the system starts (logout, restart, shut down, the Dock\'s Quit) never does', () => {
  const base = { askRequested: true, confirmed: false, installing: false, childEnded: false, needsConfirm: true };
  it('⌘Q while Claude Code or a command runs: ask', () => {
    expect(shouldAskOnQuit(base)).toBe(true);
  });
  it('a quit that did not come from ⌘Q (logout, restart, shut down, AppleScript, the Dock\'s Quit): never ask, or macOS takes it as the app refusing and cancels the logout', () => {
    expect(shouldAskOnQuit({ ...base, askRequested: false })).toBe(false);
  });
  it('already confirmed, an update being installed (its prompt said so), or a terminal that has ended: no question', () => {
    expect(shouldAskOnQuit({ ...base, confirmed: true })).toBe(false);
    expect(shouldAskOnQuit({ ...base, installing: true })).toBe(false);
    expect(shouldAskOnQuit({ ...base, childEnded: true })).toBe(false);
  });
  it('nothing would stop: no question', () => {
    expect(shouldAskOnQuit({ ...base, needsConfirm: false })).toBe(false);
  });
  it('the whole truth table: it asks in exactly one case of the 32', () => {
    const keys = ['askRequested', 'confirmed', 'installing', 'childEnded', 'needsConfirm'] as const;
    const asked: string[] = [];
    for (let n = 0; n < 32; n++) {
      const o = Object.fromEntries(keys.map((k, i) => [k, !!(n & (1 << i))])) as Record<(typeof keys)[number], boolean>;
      if (shouldAskOnQuit(o)) asked.push(keys.filter((k) => o[k]).join('+'));
    }
    expect(asked).toEqual(['askRequested+needsConfirm']);
  });
});
