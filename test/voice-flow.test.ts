import { describe, expect, it } from 'vitest';
import { createFlow, ESC_ESC_MS, type Engine } from '../src/renderer/voice/flow';
import type { VoiceMode } from '../src/renderer/voice/session';

const defer = <T = void>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const p = new Promise<T>((a, b) => ((resolve = a), (reject = b))); return { p, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig(over: { start?: () => Promise<void>; reply?: () => Promise<string | null>; speakErr?: string; speakAfterCrash?: boolean } = {}) {
  const log: string[] = [];
  const spoken: string[] = [];
  const said: string[] = [];
  const modes: VoiceMode[] = [];
  let t = 1000;
  const holds: Array<() => void> = [];
  let crashCb: (() => void) | null = null;
  const engine: Engine = {
    onCrash: (cb) => (crashCb = cb),
    startEngine: over.start ?? (async () => { log.push('start'); }),
    stopEngine: () => void log.push('stop'),
    speak: (c) => (spoken.push(c), over.speakErr ? Promise.reject(over.speakErr) : new Promise<void>((r) => holds.push(r))),
    stopSpeaking: () => { log.push('stopSpeaking'); holds.splice(0).forEach((r) => r()); },
    transcribe: () => Promise.reject('unavailable'),
  };
  const flow = createFlow({
    engine, reply: over.reply ?? (async () => 'I fixed the build. Then I ran the tests.\n```\nrm -rf SECRET\n```'),
    speed: () => 1, say: (m) => said.push(m), onMode: (m) => modes.push(m), onPreparing: () => {}, now: () => t,
  });
  return { flow, log, spoken, said, modes, holds, crash: () => { crashCb?.(); holds.splice(0).forEach((x) => x()); /* (the engine then settles the speech) */ }, advance: (ms: number) => (t += ms) };
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

  it('an engine crash ends voice at once in ready, with one toast', async () => {
    const r = rig();
    await r.flow.toggle();
    r.crash();
    r.crash();
    expect(r.flow.mode()).toBe('off');
    expect(r.said.length).toBe(1);
    expect(r.said[0]).toMatch(/stopped working/);
  });

  it('a crash mid-chunk, or on the last chunk, ends voice as off (never spoke -> ready), one toast', async () => {
    for (const reply of ['First sentence here. Second one follows.', 'Only one short sentence.']) {
      const r = rig({ reply: async () => reply });
      await r.flow.toggle();
      await finishTurn(r);
      expect(r.flow.mode()).toBe('speaking');
      r.crash();
      await tick(); await tick();
      expect(r.flow.mode()).toBe('off');
      expect(r.modes.at(-1)).toBe('off');
      expect(r.said.length).toBe(1);
      expect(r.spoken.length).toBe(1);
    }
  });

  it('our own end (leaving) does not toast; the crash callback after it does nothing', async () => {
    const r = rig();
    await r.flow.toggle();
    r.flow.end('switch-off');
    r.crash();
    expect(r.said).toEqual([]);
  });

  it('a working -> idle across different session ids speaks nothing', async () => {
    const r = rig();
    await r.flow.toggle();
    r.flow.observe({ id: 'a', state: 'working' });
    r.flow.observe({ id: 'b', state: 'idle' });
    await tick(); await tick();
    expect(r.spoken).toEqual([]);
    r.flow.observe({ id: 'b', state: 'working' });
    r.flow.observe({ id: 'b', state: 'idle' });
    await tick(); await tick();
    expect(r.spoken.length).toBe(1);
  });
});

/** Dictation (Task 8): when the microphone opens (the exact auto-listen policy), and what happens to the text (typed, copied or dropped). */
function drig(o: { claude?: string; reply?: string; transcribe?: () => Promise<string>; mic?: 'granted' | 'denied'; recordErr?: string } = {}) {
  const typed: Array<{ pane: string; text: string }> = [];
  const copied: Array<{ text: string; why: string }> = [];
  const recs: Array<{ signal: AbortSignal; done(pcm: Float32Array | null): void }> = [];
  const said: string[] = [];
  const spoken: string[] = [];
  const holds: Array<() => void> = [];
  const env = { voiceOn: true, voicePane: 'main' as string | null, active: 'main', claude: { main: 'claude' in o ? o.claude : 'idle' } as Record<string, string | undefined> };
  let micAsks = 0;
  let pendingText: ((t: string) => void) | null = null;
  let t = 1000;
  const engine: Engine = {
    startEngine: async () => {},
    stopEngine: () => {},
    speak: (c) => (spoken.push(c), new Promise<void>((r) => holds.push(r))),
    stopSpeaking: () => holds.splice(0).forEach((r) => r()),
    transcribe: o.transcribe ?? (() => new Promise<string>((r) => (pendingText = r))),
  };
  const flow = createFlow({
    engine, reply: async () => o.reply ?? '```\ncode only\n```', speed: () => 1, say: (m) => said.push(m), onMode: () => {}, onPreparing: () => {}, now: () => t,
    dictation: {
      micAccess: async () => (micAsks++, o.mic ?? 'granted'),
      record: (signal) => (o.recordErr ? Promise.reject(o.recordErr) : new Promise((done) => recs.push({ signal, done }))),
      voiceOn: () => env.voiceOn,
      startPane: () => env.voicePane,
      activePane: () => env.active,
      claudeState: (p) => env.claude[p],
      type: (pane, text) => typed.push({ pane, text }),
      copy: (text, why) => copied.push({ text, why }),
    },
  });
  const observe = (state: string) => flow.observe({ id: 's', state });
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  return {
    flow, env, typed, copied, recs, said, spoken, holds, settle, observe, mics: () => micAsks, advance: (ms: number) => (t += ms),
    /** the recording ends with speech; Whisper answers `text` */
    hear: async (text: string) => { recs.at(-1)!.done(new Float32Array(1600)); await settle(); pendingText?.(text); await settle(); },
    /** starts voice mode with the start pane's Claude in `state` (observed first, as the controller's effect does) */
    on: async (state?: string) => { if (state) observe(state); await flow.toggle(); await settle(); },
    turn: async () => { observe('working'); env.claude.main = 'idle'; observe('idle'); await settle(); },
  };
}

describe('dictation: when the microphone opens', () => {
  it('opens at start only when Claude is idle in the start pane (after one macOS access check)', async () => {
    const r = drig();
    await r.on('idle');
    expect(r.flow.mode()).toBe('listening');
    expect(r.recs.length).toBe(1);
    expect(r.mics()).toBe(1);

    for (const state of ['working', 'needs-you', undefined]) {
      const n = drig({ claude: state });
      await n.on(state);
      expect(n.flow.mode()).toBe('ready');
      expect(n.recs.length).toBe(0);
      expect(n.said.length).toBe(1);
      expect(n.said[0]).toMatch(state ? /listens once Claude finishes this turn/ : /Start Claude Code in this terminal \(⇧⌘C\)/);
    }
  });

  it('opens once after a finished turn whose reply had nothing to speak; not again until the next turn', async () => {
    const r = drig({ claude: 'working' });
    await r.on('working');
    expect(r.recs.length).toBe(0);
    await r.turn();
    expect(r.flow.mode()).toBe('listening');
    expect(r.recs.length).toBe(1);
    await r.hear('run the tests');
    expect(r.flow.mode()).toBe('ready');
    await r.settle();
    expect(r.recs.length).toBe(1); // (not after a typed result)
    await r.turn();
    expect(r.recs.length).toBe(2);
    expect(r.mics()).toBe(1); // (the access check is once per voice session)
  });

  it('after a spoken reply it waits for the speech to end; never while speaking; not after Esc stopped the speech', async () => {
    const r = drig({ claude: 'working', reply: 'I fixed the build.' });
    await r.on('working');
    await r.turn();
    expect(r.flow.mode()).toBe('speaking');
    expect(r.recs.length).toBe(0);
    r.holds.splice(0).forEach((x) => x()); // the sentence ends
    await r.settle();
    expect(r.flow.mode()).toBe('listening');
    expect(r.recs.length).toBe(1);

    const e = drig({ claude: 'working', reply: 'I fixed the build.' });
    await e.on('working');
    await e.turn();
    e.flow.esc(); // stops the speech: a cancel, so no microphone
    await e.settle();
    expect(e.flow.mode()).toBe('ready');
    expect(e.recs.length).toBe(0);
  });

  it('never re-opens after no speech (none), a cancel (Esc), a copy or noise', async () => {
    const r = drig();
    await r.on('idle');
    r.recs[0]!.done(null); // 8 s without speech
    await r.settle();
    expect(r.flow.mode()).toBe('ready');
    expect(r.recs.length).toBe(1);

    const e = drig();
    await e.on('idle');
    e.flow.esc();
    expect(e.recs[0]!.signal.aborted).toBe(true); // (Esc closes the microphone)
    expect(e.flow.mode()).toBe('ready');
    await e.settle();
    expect(e.recs.length).toBe(1);

    const c = drig();
    await c.on('idle');
    c.env.claude.main = 'working';
    await c.hear('run the tests');
    expect(c.copied.length).toBe(1);
    await c.settle();
    expect(c.recs.length).toBe(1);

    const b = drig();
    await b.on('idle');
    await b.hear('[BLANK_AUDIO]');
    expect(b.recs.length).toBe(1);
    expect(b.flow.mode()).toBe('ready');
  });

  it('a refused microphone (macOS or the page) says so once and stays ready, with no retry', async () => {
    const r = drig({ mic: 'denied' });
    await r.on('idle');
    expect(r.flow.mode()).toBe('ready');
    expect(r.recs.length).toBe(0);
    expect(r.said).toEqual(['Microphone access is off for Jaffer. Allow it in System Settings → Privacy & Security → Microphone.']);

    const p = drig({ recordErr: 'mic-denied' });
    await p.on('idle');
    expect(p.flow.mode()).toBe('ready');
    expect(p.said).toEqual(['Microphone access is off for Jaffer. Allow it in System Settings → Privacy & Security → Microphone.']);
    const m = drig({ recordErr: 'mic-missing' });
    await m.on('idle');
    expect(m.flow.mode()).toBe('ready');
    expect(m.said[0]).toMatch(/microphone/i);
  });
});

describe('dictation: what is typed', () => {
  it('types exactly the cleaned text into the start pane: no Enter, no byte below 0x20', async () => {
    const r = drig();
    await r.on('idle');
    await r.hear(' Run the tests\r\n\x1b[201~ now.');
    expect(r.typed).toEqual([{ pane: 'main', text: 'Run the tests now.' }]);
    expect([...r.typed[0]!.text].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
    expect(r.copied).toEqual([]);
    expect(r.flow.mode()).toBe('ready');
  });

  it('copies (never types) when Claude started working during the transcription', async () => {
    const r = drig();
    await r.on('idle');
    r.recs[0]!.done(new Float32Array(10));
    await r.settle();
    expect(r.flow.mode()).toBe('transcribing');
    r.env.claude.main = 'working'; // (checked at the moment of typing, after Whisper)
    await r.hear('run the tests');
    expect(r.typed).toEqual([]);
    expect(r.copied).toEqual([{ text: 'run the tests', why: 'Claude is busy or waiting for you.' }]);
  });

  it('copies when the focused pane changed during the recording or the transcription (Review Focus 3)', async () => {
    const r = drig();
    await r.on('idle');
    r.env.active = 'p2';
    await r.hear('run the tests');
    expect(r.typed).toEqual([]);
    expect(r.copied[0]!.why).toMatch(/terminal changed/);

    // the focus came back to the start pane, but the recording began in another one: still copied
    const b = drig({ claude: 'working' });
    await b.on('working');
    b.env.active = 'p2';
    await b.turn();
    b.env.active = 'main';
    await b.hear('run the tests');
    expect(b.typed).toEqual([]);
    expect(b.copied.length).toBe(1);
  });

  it.each(['/clear everything', '!rm -rf x', '# remember this'])('copies %j (a command character first) with its own sentence', async (text) => {
    const r = drig();
    await r.on('idle');
    await r.hear(text);
    expect(r.typed).toEqual([]);
    expect(r.copied).toEqual([{ text, why: 'Starts with a command character, so Jaffer copied it instead of typing it.' }]);
  });

  it('Whisper noise types and copies nothing and says nothing', async () => {
    for (const noise of ['[BLANK_AUDIO]', ' (music) ', '', '...']) {
      const r = drig();
      await r.on('idle');
      await r.hear(noise);
      expect(r.typed).toEqual([]);
      expect(r.copied).toEqual([]);
      expect(r.said).toEqual([]);
      expect(r.flow.mode()).toBe('ready');
    }
  });

  it('the setting turned off during the transcription types nothing (voice ends)', async () => {
    const r = drig();
    await r.on('idle');
    r.recs[0]!.done(new Float32Array(10));
    await r.settle();
    r.env.voiceOn = false;
    r.flow.end('switch-off');
    await r.hear('run the tests');
    expect(r.typed).toEqual([]);
    expect(r.copied).toEqual([]);
    expect(r.flow.mode()).toBe('off');
  });

  it('with the setting already off at the moment of typing it copies', async () => {
    const r = drig();
    await r.on('idle');
    r.env.voiceOn = false;
    await r.hear('run the tests');
    expect(r.typed).toEqual([]);
    expect(r.copied[0]!.why).toBe('Voice is off.');
  });

  it('a second dictation within the one-shot lock is copied', async () => {
    const r = drig();
    await r.on('idle');
    await r.hear('first');
    await r.turn();
    await r.hear('second');
    expect(r.typed.map((x) => x.text)).toEqual(['first']);
    expect(r.copied[0]!.why).toMatch(/Another dictation/);
    r.advance(5000);
    await r.turn();
    await r.hear('third');
    expect(r.typed.map((x) => x.text)).toEqual(['first', 'third']);
  });

  it('every end closes the microphone: window hidden, switch off, pane lost, engine crash, leaving', async () => {
    for (const ev of ['window-hidden', 'switch-off', 'worker-crashed', 'start'] as const) {
      const r = drig();
      await r.on('idle');
      expect(r.flow.mode()).toBe('listening');
      r.flow.end(ev);
      expect(r.recs[0]!.signal.aborted).toBe(true);
      expect(r.flow.mode()).toBe('off');
      r.recs[0]!.done(null);
      await r.settle();
      expect(r.flow.mode()).toBe('off');
    }
    const t = drig();
    await t.on('idle');
    await t.flow.toggle(); // /voice again
    expect(t.recs[0]!.signal.aborted).toBe(true);
  });
});
