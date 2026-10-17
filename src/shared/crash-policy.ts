/**
 * (1.4.1) What the app does when its window's page crashes or hangs. Pure, so it is tested. The terminals live in the daemon, so a
 * reloaded page attaches again and shows them from their snapshots: a reload loses nothing of the shells. A page that keeps crashing is
 * not reloaded for ever: the person is asked instead.
 */

/** At most this many reloads within `CRASH_WINDOW_MS`; the next crash asks. */
export const CRASH_RELOADS = 3;
export const CRASH_WINDOW_MS = 60_000;

/**
 * `reason`: Electron's `render-process-gone` reason, or `unresponsive` for a page still hanging after a while; `recent`: when the
 * page was last reloaded for a crash (times in ms); `now`: the time now. `clean-exit` is a page that ended on purpose: nothing to do.
 * (A page killed because the app quits is the caller's to leave alone.)
 */
export function crashAction(o: { reason: string; recent: readonly number[]; now: number }): 'ignore' | 'reload' | 'ask' {
  if (o.reason === 'clean-exit') return 'ignore';
  const within = o.recent.filter((t) => o.now - t <= CRASH_WINDOW_MS).length;
  return within < CRASH_RELOADS ? 'reload' : 'ask';
}

/** The one question after too many crashes. Reload is the default and Esc: a stray key must not end every terminal. */
export const CRASH_DIALOG = {
  message: 'The window stopped responding.',
  detail: 'Your terminals are still running. Reload the window, or quit Jaffer.',
  buttons: ['Reload', 'Quit'],
  defaultId: 0,
  cancelId: 0,
};
