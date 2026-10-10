/**
 * Pure rules for the life of the app's terminal. The app starts the terminal host as its own child, so quitting the app ends the shell and
 * anything running in it: ⌘Q asks first when that would stop something. A session found on the socket at the start that is not the app's
 * own child is an older Jaffer's background session, ended only on a click. And when the child ends, the app quits with it, or offers a
 * fresh one after a crash.
 */

export interface QuitAsk {
  message: string;
  detail: string;
}

/** Return means Quit (the person just pressed ⌘Q); Esc means Cancel. */
export const QUIT_BUTTONS = ['Quit', 'Cancel'] as const;

/**
 * What ⌘Q asks, or null when nothing would stop. `claudeWorking`: Claude Code works or waits for the person (or is the command that runs);
 * `commandRunning`: the shell runs a command. Both: the Claude Code text.
 */
export function quitNeedsConfirm(o: { claudeWorking: boolean; commandRunning: boolean }): QuitAsk | null {
  if (o.claudeWorking) return { message: 'Quit Jaffer?', detail: 'Claude Code is running and will stop.' };
  if (o.commandRunning) return { message: 'Quit Jaffer?', detail: 'A command is running and will stop.' };
  return null;
}

/**
 * At the start (and before a fresh terminal), what answers on the socket: `answers` when anything accepts a connection, `pid` the one it
 * gave (null when it said nothing of itself), `ownPid` the app's own child, if it has one. Anything else than the app's own child is an
 * older Jaffer's session that outlived its app: the person is asked before it is ended.
 */
export function legacyDaemonAction(o: { answers: boolean; pid: number | null; ownPid: number | null }): 'start' | 'ours' | 'ask' {
  if (!o.answers) return 'start';
  if (o.pid !== null && o.ownPid !== null && o.pid === o.ownPid) return 'ours';
  return 'ask';
}

export const LEGACY_DIALOG = {
  message: 'An older Jaffer session is still running in the background.',
  detail: 'Jaffer no longer keeps sessions running. End it and start a fresh terminal? Its shell and anything running in it stop.',
  buttons: ['End it', 'Quit'] as const,
};

/**
 * The app's child ended. `quitting`: the app ended it itself (its quit, an update, Reset): nothing more. Exit 0 on its own: a client
 * ended the session (`jaffer reset`, `jaffer daemon stop`), and the app quits with it. Anything else is a crash: a fresh terminal or Quit.
 */
export function childExitAction(o: { code: number | null; signal: string | null; quitting: boolean }): 'ignore' | 'quit' | 'offer-restart' {
  if (o.quitting) return 'ignore';
  if (o.code === 0 && !o.signal) return 'quit';
  return 'offer-restart';
}

export function childExitText(o: { code: number | null; signal: string | null; log: string }): { message: string; detail: string; buttons: readonly ['Restart terminal', 'Quit'] } {
  const how = o.signal ? `it was stopped by ${o.signal}` : o.code === null ? 'it could not be started' : `exit code ${o.code}`;
  return {
    message: 'The terminal stopped',
    detail: `Jaffer's terminal ended unexpectedly (${how}), and the shell and anything running in it with it. Restart it for a fresh shell, or quit Jaffer.\n\nLog: ${o.log}`,
    buttons: ['Restart terminal', 'Quit'] as const,
  };
}
