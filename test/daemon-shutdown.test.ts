import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { makeShutdown, SHUTDOWN_DEADLINE_MS, watchParent } from '../src/daemon/shutdown';

/**
 * How the daemon ends (src/daemon/main.ts): the first reason to stop wins, the shell is let go before the process exits, and a stop that
 * hangs still ends at a deadline. The exit code is 0 for a deliberate end (`app.shutdown`, the end of the app's pipe) and 143/130 for a
 * signal. The app reads it: 0 is a session that was ended (it quits with it), anything else a crash (it offers a fresh terminal).
 */

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(stop: () => Promise<void>) {
  const exits: number[] = [];
  const logs: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let stops = 0;
  const shutdown = makeShutdown({
    stop: () => {
      stops++;
      return stop();
    },
    exit: (code) => void exits.push(code),
    log: (m) => void logs.push(m),
    deadlineMs: 8_000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { cleared: boolean }).cleared = true),
  });
  return { shutdown, exits, logs, timers, stops: () => stops };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the daemon's shutdown: the first reason wins, the shell is let go before the exit, a hung stop still ends", () => {
  it('a second signal while stopping does not exit before the first stop() has let go of the shell, and keeps the first code', async () => {
    const d = deferred();
    const t = setup(() => d.promise);
    t.shutdown('SIGTERM', 143);
    t.shutdown('SIGINT', 130);
    t.shutdown('SIGTERM', 143);
    await tick();
    expect(t.exits).toEqual([]); // still stopping
    expect(t.stops()).toBe(1);
    d.resolve();
    await tick();
    expect(t.exits).toEqual([143]);
  });

  it('a SIGTERM during app.shutdown keeps the deliberate exit 0 (the app quits with a session that was ended, and does not take it for a crash)', async () => {
    const d = deferred();
    const t = setup(() => d.promise);
    t.shutdown('rpc', 0);
    t.shutdown('SIGTERM', 143);
    d.resolve();
    await tick();
    expect(t.exits).toEqual([0]);
  });

  it('app.shutdown claims the end at once, though its stop begins a moment later (after the reply went out): a SIGTERM in that moment keeps 0 too', async () => {
    const d = deferred();
    const t = setup(() => d.promise);
    t.shutdown('rpc', 0, 50);
    t.shutdown('SIGTERM', 143); // before the stop began
    expect(t.stops()).toBe(0);
    t.timers.find((x) => x.ms === 50)!.fn();
    expect(t.stops()).toBe(1);
    t.shutdown('SIGINT', 130); // and while it runs
    d.resolve();
    await tick();
    expect(t.exits).toEqual([0]);
    expect(t.stops()).toBe(1);
  });

  it('a stop() that hangs ends at the deadline with the code of the first reason, and only once', async () => {
    const d = deferred();
    const t = setup(() => d.promise);
    t.shutdown('SIGTERM', 143);
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(8_000);
    await tick();
    expect(t.exits).toEqual([]);
    expect(t.logs.join('\n')).toMatch(/SIGTERM/);
    t.timers[0]!.fn(); // the deadline
    expect(t.exits).toEqual([143]);
    d.resolve(); // a stop that finishes after all does not exit a second time
    await tick();
    expect(t.exits).toEqual([143]);
  });

  it('a stop() that fails still exits with its code, says why in the log, and clears the deadline', async () => {
    const t = setup(() => Promise.reject(new Error('disk full')));
    t.shutdown('rpc', 0);
    await tick();
    await tick();
    expect(t.exits).toEqual([0]);
    expect(t.logs.join('\n')).toMatch(/disk full/);
    expect(t.timers[0]!.cleared).toBe(true);
  });

  it('the deadline is about eight seconds: past what a stop takes (it ends the shell and closes the socket: nothing slow)', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("the app's pipe (JAFFER_OWNED=1): its end, however it comes, is the cue to stop", () => {
  it('the end of the pipe (the app quit, crashed or was killed) stops the daemon once', () => {
    const pipe = new PassThrough();
    let gone = 0;
    watchParent(pipe, () => gone++);
    expect(gone).toBe(0);
    pipe.end();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(gone).toBe(1); // 'end' and then 'close': once
        resolve();
      }, 20);
    });
  });

  it('a pipe that closes or fails without an end stops it too, once', async () => {
    for (const how of ['close', 'error'] as const) {
      const pipe = new PassThrough();
      let gone = 0;
      watchParent(pipe, () => gone++);
      if (how === 'close') pipe.destroy();
      else pipe.destroy(new Error('EPIPE'));
      await new Promise((r) => setTimeout(r, 20));
      expect(gone, how).toBe(1);
    }
  });

  it('what the app writes on the pipe (it writes nothing) does not stop it: only the end does', async () => {
    const pipe = new PassThrough();
    let gone = 0;
    watchParent(pipe, () => gone++);
    pipe.write('anything\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(gone).toBe(0);
    pipe.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(gone).toBe(1);
  });
});
