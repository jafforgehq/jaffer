/**
 * How the daemon ends. The exit code is 0 for a deliberate end (`app.shutdown`, or the end of the app's pipe); a signal ends it with the
 * shell's own 128 + number (SIGTERM 143, SIGINT 130). The app reads it: 0 is a session that was ended (the app quits with it), anything
 * else a crash (the app offers a fresh terminal).
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

/** What the daemon reads of the app's pipe (its stdin). */
export interface ParentPipe {
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown;
  resume(): unknown;
}

/**
 * The daemon the app starts (`JAFFER_OWNED=1`) has a pipe from the app on its stdin, which the app never writes. Its end, however it comes
 * (the app quits, crashes or is killed: the system closes the app's end), calls `onGone` once. Whatever arrives on it is read and ignored.
 */
export function watchParent(pipe: ParentPipe, onGone: () => void): void {
  let gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    onGone();
  };
  pipe.on('end', go);
  pipe.on('close', go);
  pipe.on('error', go);
  pipe.resume();
}
