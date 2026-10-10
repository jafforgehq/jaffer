/**
 * How the daemon ends. The exit code is 0 for a deliberate end (`app.shutdown`); a signal ends it with the shell's own 128 + number
 * (SIGTERM 143, SIGINT 130).
 *
 * - The first reason wins: a second signal, or a signal during `app.shutdown`, neither exits before the first stop has let go of the
 *   shell nor changes the code (a SIGTERM must not turn a deliberate 0 into 143).
 * - A stop that hangs still ends: at the deadline the process exits with the first reason's code.
 */

/** Well past what a stop takes (it ends the shell and closes the socket: nothing slow). */
export const SHUTDOWN_DEADLINE_MS = 8_000;

export interface ShutdownDeps {
  /** Lets go of everything: the shell, the socket (`JafferService.stop`). */
  stop: () => Promise<void>;
  exit: (code: number) => void;
  log: (msg: string) => void;
  deadlineMs: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * `shutdown(why, code, startAfterMs?)`: the end for this reason. `startAfterMs` lets the stop begin a moment later (after an RPC's reply
 * has gone out) while the reason is claimed at once.
 */
export function makeShutdown(d: ShutdownDeps): (why: string, code: number, startAfterMs?: number) => void {
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)); // (not unref'd: a stop that hangs on nothing must still reach the deadline)
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  let first: { why: string; code: number } | null = null;
  let exited = false;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    d.exit(code);
  };
  return (why, code, startAfterMs = 0) => {
    if (first) {
      d.log(`${why} while shutting down (${first.why}); still stopping, the exit code stays ${first.code}`);
      return;
    }
    first = { why, code };
    d.log(`shutting down (${why})`);
    const deadline = setTimer(() => {
      d.log(`stop did not finish in ${d.deadlineMs} ms; exiting`);
      exit(code);
    }, d.deadlineMs);
    const run = () =>
      void d
        .stop()
        .catch((e: unknown) => d.log(`stop error: ${e instanceof Error ? e.message : String(e)}`))
        .then(() => {
          clearTimer(deadline);
          exit(code);
        });
    if (startAfterMs > 0) setTimer(run, startAfterMs);
    else run();
  };
}
