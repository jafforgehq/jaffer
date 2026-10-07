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
let asked: { message: string; detail: string; version: string; manual: boolean }[];
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
    ask: async (text, version, manual) => {
      const t = text(); // built when the dialog is about to show, like the real one
      asked.push({ message: t.message, detail: t.detail, version, manual });
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
    up.script = (u) => {
      u.emit('update-available', { version: '0.2.0' });
      // the cached file is "downloaded" again a moment after the check itself has finished
      up.downloadPromise = new Promise((res) => setTimeout(() => (up.emit('update-downloaded', { version: '0.2.0' }), res(null)), 500));
    };
    const c = make();
    const p = c.checkNow();
    await vi.advanceTimersByTimeAsync(600);
    expect((await p).status).toBe('ready');
  });

  it('a real download takes longer than the grace period: the answer is "downloading", and the prompt follows when it is ready', async () => {
    up.script = (u) => {
      u.emit('update-available', { version: '0.2.0' });
      up.downloadPromise = new Promise((res) => setTimeout(() => (up.emit('update-downloaded', { version: '0.2.0' }), res(null)), 60_000));
    };
    const c = make();
    const p = c.checkNow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await p).status).toBe('downloading');
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(asked).toHaveLength(1);
  });

  it('the prompt text is built when the dialog shows, so the Claude warning is current', async () => {
    busy = false;
    let build: () => { detail: string } = () => ({ detail: '' });
    up.script = found('0.2.0');
    const c = make({
      ask: async (text) => {
        build = text;
        return false;
      },
    });
    await c.checkNow();
    await settle();
    busy = true; // Claude started working while the prompt waited for the window
    expect(build().detail).toMatch(/claude is working/i);
  });

  it('tells the dialog whether the user asked (a manual check brings the window forward)', async () => {
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    expect(asked[0]!.manual).toBe(true);
    up.script = found('0.2.1');
    c.start();
    await vi.advanceTimersByTimeAsync(16_000);
    await settle();
    expect(asked.find((a) => a.version === '0.2.1')!.manual).toBe(false);
  });

  it('a manual check that joins a background check still counts as asked for', async () => {
    let release: () => void = () => undefined;
    up.script = async (u) => {
      await new Promise<void>((r) => (release = r));
      found('0.2.0')(u);
    };
    const c = make();
    c.start();
    await vi.advanceTimersByTimeAsync(16_000); // the background check is now waiting
    const manual = c.checkNow();
    release();
    await manual;
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.manual).toBe(true);
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

  it('a check that never answers times out, says so, and the next tick tries again', async () => {
    up.script = () => new Promise(() => undefined);
    const c = make();
    c.start();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(c.state().status).toBe('checking');
    await vi.advanceTimersByTimeAsync(91_000);
    expect(c.state()).toMatchObject({ status: 'error', error: expect.stringMatching(/timed out/i) });
    up.script = (u) => void u.emit('update-not-available', { version: '0.1.1' });
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(c.state().status).toBe('uptodate');
    expect(up.checks).toBe(2);
  });

  it('a download that stops making progress does not block checking for good', async () => {
    up.script = (u) => void u.emit('update-available', { version: '0.2.0' }); // never finishes
    const c = make();
    await c.checkNow();
    expect(c.state().status).toBe('downloading');
    await c.checkNow(); // still downloading, nothing stalled yet: no second check
    expect(up.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    up.script = (u) => void u.emit('update-not-available', { version: '0.1.1' });
    await c.checkNow();
    expect(up.checks).toBe(2);
    expect(c.state().status).toBe('uptodate');
  });

  it('progress keeps a slow download alive', async () => {
    up.script = (u) => void u.emit('update-available', { version: '0.2.0' });
    const c = make();
    await c.checkNow();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      up.emit('download-progress', { percent: 10 * i });
    }
    await c.checkNow();
    expect(up.checks).toBe(1);
  });

  it('a background download that fails is not an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => void seen.push(e);
    process.on('unhandledRejection', on);
    up.script = (u) => {
      u.emit('update-available', { version: '0.2.0' });
      const failing = Promise.reject(new Error('download broke'));
      up.downloadPromise = failing;
    };
    const c = make();
    c.start();
    await vi.advanceTimersByTimeAsync(16_000);
    await settle();
    await vi.advanceTimersByTimeAsync(10);
    process.off('unhandledRejection', on);
    expect(seen).toEqual([]);
  });

  it('a build that cannot update says why', async () => {
    const c = make({ enabled: false, unavailableReason: 'Move Jaffer to your Applications folder.' });
    expect(c.state()).toMatchObject({ status: 'unavailable', error: 'Move Jaffer to your Applications folder.' });
  });

  it('reports each step to the UI', async () => {
    up.script = found('0.2.0');
    const c = make();
    await c.checkNow();
    await settle();
    expect(states.map((s) => s.status)).toEqual(['checking', 'downloading', 'ready']);
  });
});
