import { describe, expect, it } from 'vitest';
import { childExitAction, childExitText, LEGACY_DIALOG, legacyDaemonAction, QUIT_BUTTONS, quitNeedsConfirm } from '../src/shared/quit-policy';

/** The app owns its terminal: quitting ends it, so the app asks when something would stop; an older Jaffer's background session is ended only on a click. */

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
});

describe('legacyDaemonAction: a session on the socket that is not this app\'s child is an older Jaffer\'s', () => {
  it('nothing answers: start the app\'s own terminal', () => {
    expect(legacyDaemonAction({ answers: false, pid: null, ownPid: null })).toBe('start');
    expect(legacyDaemonAction({ answers: false, pid: null, ownPid: 4242 })).toBe('start');
  });
  it('a daemon answers at the first start (the app has no child yet): ask before ending it', () => {
    expect(legacyDaemonAction({ answers: true, pid: 4242, ownPid: null })).toBe('ask');
  });
  it('a daemon answers that is not this app\'s child: ask', () => {
    expect(legacyDaemonAction({ answers: true, pid: 4242, ownPid: 5151 })).toBe('ask');
  });
  it('something accepts the connection but says nothing of itself (an old daemon that hangs): ask too, never take it for the app\'s own', () => {
    expect(legacyDaemonAction({ answers: true, pid: null, ownPid: null })).toBe('ask');
    expect(legacyDaemonAction({ answers: true, pid: null, ownPid: 5151 })).toBe('ask');
  });
  it('the app\'s own child: nothing to ask', () => {
    expect(legacyDaemonAction({ answers: true, pid: 5151, ownPid: 5151 })).toBe('ours');
  });
  it('the question says what it is and what ending it means, with End it and Quit', () => {
    expect(LEGACY_DIALOG.message).toMatch(/older Jaffer session is still running in the background/);
    expect(LEGACY_DIALOG.detail).toMatch(/no longer keeps sessions running/);
    expect(LEGACY_DIALOG.detail).toMatch(/End it and start a fresh terminal\?/);
    expect(LEGACY_DIALOG.buttons).toEqual(['End it', 'Quit']);
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
