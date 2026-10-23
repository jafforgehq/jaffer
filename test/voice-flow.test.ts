import { describe, expect, it } from 'vitest';
import { createFlow, ESC_ESC_MS, type Engine } from '../src/renderer/voice/flow';
import type { VoiceMode } from '../src/renderer/voice/session';

const defer = <T = void>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const p = new Promise<T>((a, b) => ((resolve = a), (reject = b))); return { p, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig(over: { start?: () => Promise<void>; reply?: () => Promise<string | null>; speakErr?: string } = {}) {
  const log: string[] = [];
  const spoken: string[] = [];
  const said: string[] = [];
  const modes: VoiceMode[] = [];
  let t = 1000;
  const holds: Array<() => void> = [];
  const engine: Engine = {
    startEngine: over.start ?? (async () => { log.push('start'); }),
    stopEngine: () => void log.push('stop'),
    speak: (c) => (spoken.push(c), over.speakErr ? Promise.reject(over.speakErr) : new Promise<void>((r) => holds.push(r))),
    stopSpeaking: () => { log.push('stopSpeaking'); holds.splice(0).forEach((r) => r()); },
  };
  const flow = createFlow({
    engine, reply: over.reply ?? (async () => 'I fixed the build. Then I ran the tests.\n```\nrm -rf SECRET\n```'),
    speed: () => 1, say: (m) => said.push(m), onMode: (m) => modes.push(m), onPreparing: () => {}, now: () => t,
  });
  return { flow, log, spoken, said, modes, holds, advance: (ms: number) => (t += ms) };
}
const finishTurn = async (r: ReturnType<typeof rig>) => { r.flow.observe({ id: 's', state: 'working' }); r.flow.observe({ id: 's', state: 'idle' }); await tick(); await tick(); };

describe('voice flow', () => {
  it('toggle: off -> ready (engine started), again -> off (engine stopped)', async () => {
    const r = rig();
    await r.flow.toggle();
    expect(r.flow.mode()).toBe('ready');
    await r.flow.toggle();
    expect(r.flow.mode()).toBe('off');
    expect(r.log).toEqual(['start', 'stop']);
  });

  it('a failed start says so and goes off', async () => {
    const r = rig({ start: () => Promise.reject('unavailable') });
    await r.flow.toggle();
    expect(r.flow.mode()).toBe('off');
    expect(r.said[0]).toMatch(/could not start/);
  });

  it('quick off/on: the second start waits for the first run to settle and does not join it', async () => {
    const first = defer();
    let calls = 0;
    const order: string[] = [];
    const r = rig({ start: () => { const n = ++calls; order.push(`begin${n}`); if (n === 1) return first.p.finally(() => order.push('settle1')); return Promise.resolve(); } });
    const a = r.flow.toggle(); // start 1 under way (reading files)
    await tick();
    await r.flow.toggle(); // off: stopEngine
    first.reject('unavailable'); // the engine fails the old run
    const b = r.flow.toggle(); // on again
    await Promise.all([a, b]);
    expect(order).toEqual(['begin1', 'settle1', 'begin2']);
    expect(r.flow.mode()).toBe('ready');
    expect(r.said).toEqual([]); // (the stale failure is not reported)
  });

  it('a finished turn speaks the prose only, in chunks; code-only speaks nothing and says nothing', async () => {
    const r = rig();
    await r.flow.toggle();
    await finishTurn(r);
    expect(r.flow.mode()).toBe('speaking');
    expect(r.spoken.join(' ')).toBe('I fixed the build. Then I ran the tests.');
    expect(r.spoken.join(' ')).not.toMatch(/SECRET|rm/);
    r.holds.splice(0).forEach((x) => x());
    await tick(); await tick();
    expect(r.flow.mode()).toBe('ready');

    const c = rig({ reply: async () => '```\nonly code\n```' });
    await c.flow.toggle();
    await finishTurn(c);
    expect(c.spoken).toEqual([]);
    expect(c.flow.mode()).toBe('ready');
    expect(c.said).toEqual([]);
  });

  it('no speech when off, for a cut-short turn, or when the reply is not allowed (null)', async () => {
    const off = rig();
    await finishTurn(off);
    expect(off.spoken).toEqual([]);
    const cut = rig();
    await cut.flow.toggle();
    cut.flow.observe({ id: 's', state: 'working' });
    cut.flow.observe({ id: 's', state: 'idle', cutShort: true });
    await tick();
    expect(cut.spoken).toEqual([]);
    const nul = rig({ reply: async () => null });
    await nul.flow.toggle();
    await finishTurn(nul);
    expect(nul.spoken).toEqual([]);
    expect(nul.said).toEqual([]);
  });

  it('a new turn while speaking stops the speech; Esc while speaking stops it too', async () => {
    const r = rig();
    await r.flow.toggle();
    await finishTurn(r);
    r.flow.observe({ id: 's', state: 'working' });
    expect(r.flow.mode()).toBe('ready');
    expect(r.log).toContain('stopSpeaking');
    await tick();
    expect(r.spoken.length).toBe(1); // (the first chunk only: the rest was dropped)

    const e = rig();
    await e.flow.toggle();
    await finishTurn(e);
    e.flow.esc();
    expect(e.flow.mode()).toBe('ready');
    await tick();
    expect(e.spoken.length).toBe(1);
  });

  it('Esc once in ready keeps it; a second within the window leaves; a late second does not', async () => {
    const r = rig();
    await r.flow.toggle();
    r.flow.esc();
    expect(r.flow.mode()).toBe('ready');
    r.advance(ESC_ESC_MS + 1);
    r.flow.esc();
    expect(r.flow.mode()).toBe('ready');
    r.advance(200);
    r.flow.esc();
    expect(r.flow.mode()).toBe('off');
    expect(r.log.at(-1)).toBe('stop');
  });

  it('Esc that only stopped a speech does not count as the first of two', async () => {
    const r = rig();
    await r.flow.toggle();
    await finishTurn(r);
    r.flow.esc();
    r.flow.esc();
    expect(r.flow.mode()).toBe('ready');
  });

  it('end events (switch-off, window-hidden, worker-crashed) leave from any mode and stop the engine; Stop button speaks then leaves', async () => {
    for (const ev of ['switch-off', 'window-hidden', 'worker-crashed'] as const) {
      const r = rig();
      await r.flow.toggle();
      await finishTurn(r);
      r.flow.end(ev);
      expect(r.flow.mode()).toBe('off');
      expect(r.log.at(-1)).toBe('stop');
    }
    const r = rig();
    await r.flow.toggle();
    await finishTurn(r);
    r.flow.stopButton();
    expect(r.flow.mode()).toBe('ready');
    r.flow.stopButton();
    expect(r.flow.mode()).toBe('off');
  });

  it('the engine dying mid-speech ends voice with a sentence', async () => {
    const r = rig({ speakErr: 'unavailable' });
    await r.flow.toggle();
    await finishTurn(r);
    expect(r.flow.mode()).toBe('off');
    expect(r.said[0]).toMatch(/stopped working/);
  });
});
