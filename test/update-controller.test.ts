import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateController, type UpdateDeps } from '../src/main/updates';
import type { UpdateState } from '../src/shared/update-policy';

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

class FakeUpdater extends EventEmitter {
  checks = 0;
  installs: unknown[][] = [];
  /** What the fake feed does when asked. */
  script: (u: FakeUpdater) => Promise<unknown> | unknown = (u) => void u.emit('update-not-available', { version: '0.1.1' });
  downloadPromise: Promise<unknown> | null = null;
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    await this.script(this);
    return { downloadPromise: this.downloadPromise };
  }
  quitAndInstall(...a: unknown[]) {
    this.installs.push(a);
    order.push('quitAndInstall');
  }
}
const found = (v: string) => (u: FakeUpdater) => {
  u.emit('update-available', { version: v });
  u.emit('update-downloaded', { version: v });
};

let order: string[] = [];
let up: FakeUpdater;
let asked: { message: string; detail: string; version: string }[];
let answer: () => Promise<boolean>;
let auto = true;
let busy = false;
let states: UpdateState[];
let logs: string[];

function make(over: Partial<UpdateDeps> = {}) {
  return new UpdateController({
    updater: up,
    current: '0.1.1',
    enabled: true,
    auto: () => auto,
    ask: async (t, version) => {
      asked.push({ message: t.message, detail: t.detail, version });
      return answer();
    },
    claudeBusy: () => busy,
    prepareInstall: async () => {
      order.push('prepare:start');
      await Promise.resolve();
      order.push('prepare:end');
    },
    log: (m) => void logs.push(m),
    onState: (s) => void states.push(s),
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  order = [];
  up = new FakeUpdater();
  asked = [];
  answer = async () => false;
  auto = true;
  busy = false;
  states = [];
  logs = [];
});
afterEach(() => vi.useRealTimers());

describe('UpdateController: when it checks', () => {
  it('does nothing in a build that cannot update itself, and says so', async () => {
    const c = make({ enabled: false });
    c.start();
    await vi.advanceTimersByTimeAsync(7 * 3600_000);
    expect(up.checks).toBe(0);
    expect((await c.checkNow()).status).toBe('unavailable');
    expect(up.checks).toBe(0);
  });

  it('checks 15 seconds after start and then every 6 hours while automatic checks are on', async () => {
    const c = make();
    c.start();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(up.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(up.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(up.checks).toBe(2);
    c.stop();
    await vi.advanceTimersByTimeAsync(12 * 3600_000);
    expect(up.checks).toBe(2);
  });

  it('with automatic checks off nothing runs in the background, but a manual check still works', async () => {
    auto = false;
    const c = make();
    c.start();
    await vi.advanceTimersByTimeAsync(13 * 3600_000);
    expect(up.checks).toBe(0);
    const s = await c.checkNow();
    expect(up.checks).toBe(1);
    expect(s.status).toBe('uptodate');
    expect(s.auto).toBe(false);
  });

  it('two overlapping checks share one run', async () => {
    const c = make();
    const a = c.checkNow();
    const b = c.checkNow();
    await Promise.all([a, b]);
    expect(up.checks).toBe(1);
  });
});

describe('UpdateController: asking', () => {
  it('asks once when the update is ready, and says when Claude is busy', async () => {
    busy = true;
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.version).toBe('0.2.0');
    expect(asked[0]!.message).toContain('0.2.0');
    expect(asked[0]!.detail).toMatch(/claude is working/i);
    expect(c.state()).toMatchObject({ status: 'ready', version: '0.2.0', current: '0.1.1' });
  });

  it('does not ask twice when the ready event repeats while the dialog is open', async () => {
    let release: (v: boolean) => void = () => undefined;
    answer = () => new Promise<boolean>((r) => (release = r));
    up.script = (u) => {
      found('0.2.0')(u);
      u.emit('update-downloaded', { version: '0.2.0' });
    };
    const c = make();
    await c.checkNow();
    await settle();
    expect(asked).toHaveLength(1);
    release(false);
    await settle();
  });

  it('on yes: ends the session first, then installs and restarts', async () => {
    answer = async () => true;
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    expect(order).toEqual(['prepare:start', 'prepare:end', 'quitAndInstall']);
    expect(up.installs).toEqual([[false, true]]);
  });

  it('on Later: installs nothing, and does not ask about the same version again in the background', async () => {
    up.script = found('0.2.0');
    const c = make();
    c.start();
    await vi.advanceTimersByTimeAsync(16_000);
    await settle();
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    await settle();
    expect(up.checks).toBe(2);
    expect(asked).toHaveLength(1);
    expect(up.installs).toEqual([]);
    expect(c.state().status).toBe('ready');
  });

  it('a manual check asks again about a version that is already ready, without another download', async () => {
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    expect(asked).toHaveLength(1);
    const s = await c.checkNow();
    await settle();
    expect(asked).toHaveLength(2);
    expect(up.checks).toBe(1);
    expect(s.status).toBe('ready');
  });

  it('asks about a newer version even after Later on an older one', async () => {
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    up.script = found('0.2.1');
    await c.checkNow(); // short-circuits for 0.2.0 being ready; the background tick looks for newer ones
    c.start();
    await vi.advanceTimersByTimeAsync(16_000);
    await settle();
    expect(asked.map((a) => a.version)).toContain('0.2.1');
  });

  it('a dialog that fails or a install that throws never escapes, and the update stays ready', async () => {
    answer = async () => {
      throw new Error('dialog broke');
    };
    up.script = found('0.2.0');
    const c = make();
    await expect(c.checkNow()).resolves.toBeTruthy();
    await settle();
    expect(up.installs).toEqual([]);
    expect(c.state().status).toBe('ready');
    expect(logs.join('\n')).toMatch(/dialog broke/);
  });

  it('a manual check right after a cached download reports ready, not downloading', async () => {
    up.script = (u) => void u.emit('update-available', { version: '0.2.0' });
    up.downloadPromise = Promise.resolve().then(() => void up.emit('update-downloaded', { version: '0.2.0' }));
    const c = make();
    const s = await c.checkNow();
    expect(s.status).toBe('ready');
  });
});

describe('UpdateController: what it ignores and how it fails', () => {
  it('ignores a version that is garbage or not newer', async () => {
    const c = make();
    for (const v of ['0.2.0<script>', '0.1.1', '0.1.0', '']) {
      up.script = found(v);
      const s = await c.checkNow();
      expect(s.status).toBe('uptodate');
    }
    expect(asked).toEqual([]);
  });

  it('an updater error becomes a quiet error state, never a throw', async () => {
    up.script = (u) => void u.emit('error', new Error('x'.repeat(500)));
    const c = make();
    const s = await c.checkNow();
    expect(s.status).toBe('error');
    expect(s.error!.length).toBeLessThanOrEqual(200);
    expect(asked).toEqual([]);
  });

  it('a check that rejects is the same, and the next tick tries again', async () => {
    up.script = () => {
      throw new Error('offline');
    };
    const c = make();
    c.start();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(c.state()).toMatchObject({ status: 'error', error: 'offline' });
    up.script = (u) => void u.emit('update-not-available', { version: '0.1.1' });
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(c.state().status).toBe('uptodate');
  });

  it('a failing background check does not take away an update that is already ready', async () => {
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    up.script = () => {
      throw new Error('offline');
    };
    c.start();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(c.state().status).toBe('ready');
  });

  it('reports each step to the UI', async () => {
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    expect(states.map((s) => s.status)).toEqual(['checking', 'downloading', 'ready']);
  });
});
