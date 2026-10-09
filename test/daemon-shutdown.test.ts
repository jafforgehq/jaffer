import { describe, expect, it } from 'vitest';
import { makeShutdown, SHUTDOWN_DEADLINE_MS } from '../src/daemon/shutdown';

/**
 * How the daemon ends (src/daemon/main.ts): the first reason to stop wins, the state is saved before the process exits, and a stop that
 * hangs still ends at a deadline. The exit code is what launchd reads (0: a deliberate end it leaves alone; 143/130: a signal it restarts).
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

describe("the daemon's shutdown: the first reason wins, the state is saved first, a hung stop still ends", () => {
  it('a second signal while stopping does not exit before the first stop() has finished saving, and keeps the first code', async () => {
    const d = deferred();
    const t = setup(() => d.promise);
    t.shutdown('SIGTERM', 143);
    t.shutdown('SIGINT', 130);
    t.shutdown('SIGTERM', 143);
    await tick();
    expect(t.exits).toEqual([]); // still saving
    expect(t.stops()).toBe(1);
    d.resolve();
    await tick();
    expect(t.exits).toEqual([143]);
  });

  it('a SIGTERM during app.shutdown keeps the deliberate exit 0 (launchd must not bring back a session the person ended)', async () => {
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

  it('the deadline is about eight seconds: past what a stop takes (the reflection waits 3 s at most), well inside launchd\'s own 20 s', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });
});
