import { beforeEach, describe, expect, it } from 'vitest';
import { AutoResumer, nextStep, type AutoResumeDeps, type AutoResumeEvent, type AutoResumeInput, type AutoResumeTiming } from '../src/core/claude/auto-resume';
import { AUTO_RESUME, AUTO_RESUME_TEST } from '../src/shared/keep-running';

const ID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';
const OTHER = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const RESUME = `claude --resume ${ID}\r`;
const T0 = 50_000_000;

/** The daemon's test mode: the same numbers, in milliseconds. */
const FAST: AutoResumeTiming = { noticeMs: 3, quietMs: 2 };

// Everything here is about Restart Claude Code, the one request the person makes (in a native dialog): nothing is resumed by itself.

describe('nextStep', () => {
  const ready: AutoResumeInput = { now: T0, offer: { id: ID }, promptReady: true, busy: false, lastInputAt: T0 - 60_000, stopping: false };
  const step = (over: Partial<AutoResumeInput> = {}) => nextStep({ ...ready, ...over });

  it.each<[string, Partial<AutoResumeInput>]>([
    ['there is no offer', { offer: null }],
    ['the daemon is stopping', { stopping: true }],
    ['the id is not a session id', { offer: { id: 'x; rm -rf ~' } }],
    ['the id is empty', { offer: { id: '' } }],
    ['the id is too short', { offer: { id: 'abc' } }],
    ['something runs in the shell', { busy: true }],
    ['the shell is not at a prompt', { promptReady: false }],
    ['something runs and the person typed 1 s ago (idle, not wait)', { busy: true, lastInputAt: T0 - 1_000 }],
    ['the shell is not at a prompt and the person typed 1 s ago (idle, not wait)', { promptReady: false, lastInputAt: T0 - 1_000 }],
    ['something starts running during the notice', { busy: true, pendingSince: T0 - 3_000 }],
  ])('is idle when %s', (_, over) => {
    expect(step(over)).toEqual({ kind: 'idle' });
  });

  it('announces when everything holds, typing after the notice', () => {
    expect(step()).toEqual({ kind: 'announce', typesAt: T0 + AUTO_RESUME.noticeMs });
    expect(step()).toEqual({ kind: 'announce', typesAt: T0 + 3_000 });
  });

  it('waits for 2 s of quiet after the person typed before announcing', () => {
    expect(step({ lastInputAt: T0 - 1_000 })).toEqual({ kind: 'wait', until: T0 + 1_000 });
    expect(step({ lastInputAt: T0 - 2_000 })).toEqual({ kind: 'announce', typesAt: T0 + 3_000 });
  });

  it('types once the wait since the notice has passed, and not a moment before', () => {
    expect(step({ pendingSince: T0 - 2_999 })).toEqual({ kind: 'wait', until: T0 + 1 });
    expect(step({ pendingSince: T0 - 3_000 })).toEqual({ kind: 'type', id: ID });
  });

  it('the person typing during the notice moves the typing to 2 s after their last key', () => {
    expect(step({ pendingSince: T0 - 3_000, lastInputAt: T0 - 500 })).toEqual({ kind: 'wait', until: T0 + 1_500 });
    expect(step({ pendingSince: T0 - 3_000, lastInputAt: T0 - 2_000 })).toEqual({ kind: 'type', id: ID });
  });

  it('reads every number from the timing it is given', () => {
    expect(nextStep(ready, FAST)).toEqual({ kind: 'announce', typesAt: T0 + 3 });
    expect(nextStep({ ...ready, lastInputAt: T0 - 1 }, FAST)).toEqual({ kind: 'wait', until: T0 + 1 });
    expect(nextStep({ ...ready, pendingSince: T0 - 2 }, FAST)).toEqual({ kind: 'wait', until: T0 + 1 });
    expect(nextStep({ ...ready, pendingSince: T0 - 3 }, FAST)).toEqual({ kind: 'type', id: ID });
    expect(nextStep({ ...ready, pendingSince: T0 - 3, lastInputAt: T0 - 1 }, FAST)).toEqual({ kind: 'wait', until: T0 + 1 });
  });
});

describe('AutoResumer', () => {
  let now: number;
  let timers: { fn: () => void; at: number; live: boolean }[];
  let offer: { id: string } | null;
  let promptReady: boolean;
  let busy: boolean;
  let lastInputAt: number;
  let stopping: boolean;
  /** The shell itself has the terminal (the daemon asks the system: no program it runs, whatever the marks say). */
  let shellInFront: boolean;
  let typed: string[];
  let events: AutoResumeEvent[];
  let r: AutoResumer;

  const advance = (ms: number) => {
    const to = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.fn();
    }
    now = to;
  };

  const deps = (): AutoResumeDeps => ({
    now: () => now,
    offer: () => offer,
    promptReady: () => promptReady,
    busy: () => busy,
    lastInputAt: () => lastInputAt,
    stopping: () => stopping,
    mayType: () => shellInFront,
    type: (text) => {
      typed.push(text);
      // the shell runs what was typed: no prompt, busy
      busy = true;
      promptReady = false;
    },
    emit: (e) => void events.push(e),
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { live: boolean }).live = false;
    },
  });

  beforeEach(() => {
    now = T0;
    timers = [];
    offer = { id: ID };
    promptReady = true;
    busy = false;
    lastInputAt = 0;
    stopping = false;
    shellInFront = true;
    typed = [];
    events = [];
    r = new AutoResumer(deps());
  });

  /** The person's request (Restart Claude Code); the daemon repeats it at each prompt of the new shell until it is typed or cancelled. */
  const ask = () => r.check({ explicit: true });
  const liveTimers = () => timers.filter((t) => t.live).length;

  it('says so, then types exactly `claude --resume <id>` and Enter 3 s later, once', () => {
    ask();
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 3_000 }]);
    advance(2_999);
    expect(typed).toEqual([]);
    advance(1);
    expect(typed).toEqual([RESUME]);
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'typed', id: ID },
    ]);
    advance(600_000);
    expect(typed).toEqual([RESUME]);
    expect(liveTimers()).toBe(0);
  });

  it('a second check() during the notice does not announce again, and one timer at most is pending', () => {
    ask();
    advance(1_000);
    ask();
    ask();
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 3_000 }]);
    expect(liveTimers()).toBe(1);
    advance(2_000);
    expect(typed).toEqual([RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']);
  });

  it('Cancel before the time types nothing, and the same offer stays quiet: only a new request announces it again', () => {
    ask();
    advance(1_000);
    r.cancel();
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'cancelled', id: ID },
    ]);
    expect(liveTimers()).toBe(0);
    advance(600_000);
    expect(typed).toEqual([]);
    expect(events).toHaveLength(2);

    offer = { id: OTHER }; // another conversation is offered: still nothing by itself
    advance(600_000);
    expect(events).toHaveLength(2);
    ask(); // the person asks again (Restart Claude Code once more)
    expect(events.at(-1)).toEqual({ state: 'pending', id: OTHER, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([`claude --resume ${OTHER}\r`]);
  });

  it('Cancel leaves the button: the offer going away and coming back (a command run, a cd away and back) does not bring it back', () => {
    ask();
    r.cancel();
    // a command runs: no offer while it does, then the prompt is back
    offer = null;
    busy = true;
    promptReady = false;
    advance(5_000);
    offer = { id: ID };
    busy = false;
    promptReady = true;
    // a cd elsewhere (no offer in another folder) and back
    offer = null;
    advance(5_000);
    offer = { id: ID };
    advance(600_000);
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    expect(liveTimers()).toBe(0);
  });

  it('the person typing at 2.5 s moves the typing to 2 s after their last key', () => {
    ask();
    advance(2_500);
    lastInputAt = now;
    advance(500);
    expect(typed).toEqual([]);
    advance(1_499);
    expect(typed).toEqual([]);
    advance(1);
    expect(now).toBe(T0 + 4_500);
    expect(typed).toEqual([RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']); // announced once
  });

  it('the person typing while it waits is never overridden', () => {
    ask();
    for (let i = 0; i < 30; i++) {
      advance(1_000);
      lastInputAt = now; // a key every second, for half a minute
      expect(typed).toEqual([]);
    }
    advance(1_999);
    expect(typed).toEqual([]);
    advance(1);
    expect(typed).toEqual([RESUME]);
  });

  it('waits for quiet before announcing when the person was typing at the start', () => {
    lastInputAt = T0 - 500;
    ask();
    expect(events).toEqual([]);
    advance(1_500);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 1_500 + 3_000 }]);
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('a command the person starts during the notice drops this try, and the request is over: nothing is typed after their command', () => {
    ask();
    advance(1_000);
    busy = true; // they pressed Enter on something
    promptReady = false;
    advance(5_000);
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    busy = false; // their command finished, the prompt is back
    promptReady = true;
    advance(600_000);
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    expect(liveTimers()).toBe(0);
  });

  it('repeating the same explicit request while it waits is one request: the notice is announced once', () => {
    lastInputAt = T0 - 500; // the person typed: it waits for quiet
    ask();
    ask();
    advance(1_500);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    ask(); // (the daemon repeats it at each prompt)
    expect(events).toHaveLength(1);
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('a request that finds the shell not at a prompt is the same request at the next one: it announces the short notice then', () => {
    promptReady = false;
    ask();
    expect(events).toEqual([]);
    expect(typed).toEqual([]);
    promptReady = true;
    ask(); // the same request again at the next prompt
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
  });

  it('explicit never ignores the other conditions', () => {
    for (const set of [
      () => (offer = null),
      () => (offer = { id: 'x; rm -rf ~' }),
      () => (promptReady = false),
      () => (busy = true),
      () => (stopping = true),
    ]) {
      offer = { id: ID };
      promptReady = true;
      busy = false;
      stopping = false;
      set();
      ask();
      advance(600_000);
    }
    expect(typed).toEqual([]);
    expect(events).toEqual([]);

    offer = { id: ID };
    promptReady = true;
    busy = false;
    stopping = false;
    lastInputAt = now - 500; // the quiet period
    ask();
    expect(events).toEqual([]);
    advance(1_500);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    r.cancel(); // Cancel during its notice
    advance(600_000);
    expect(typed).toEqual([]);
  });

  it('asking again (explicit) after an earlier Cancel resumes', () => {
    ask();
    r.cancel();
    advance(600_000);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    ask(); // the person chose Restart Claude again: that is asking again
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('the explicit request lasts through its own wait for quiet and its notice', () => {
    lastInputAt = T0 - 1_000;
    ask();
    advance(1_000);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    ask(); // the daemon repeats it at a prompt meanwhile: that does not drop it
    advance(3_000);
    expect(typed).toEqual([RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']);
  });

  it('nothing is typed when the daemon starts stopping during the wait', () => {
    ask();
    advance(1_000);
    stopping = true;
    advance(600_000);
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
  });

  it('another conversation offered during the notice drops the first, and nothing is announced for it without a request', () => {
    ask();
    advance(1_000);
    offer = { id: OTHER };
    advance(2_000);
    expect(typed).toEqual([]);
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'cancelled', id: ID },
    ]);
    advance(600_000);
    expect(typed).toEqual([]);
    expect(events).toHaveLength(2);
    expect(liveTimers()).toBe(0);
  });

  it('only a session id is ever typed', () => {
    for (const id of ['x; rm -rf ~', '', 'abc', '-rf-rf-rf-rf', 'a'.repeat(65), 'abcdefgh\rrm', '$(reboot)ab']) {
      offer = { id };
      ask();
      advance(600_000);
    }
    expect(typed).toEqual([]);
    expect(events).toEqual([]);
  });

  it('takes its numbers from the timing it is given (the daemon test mode)', () => {
    r = new AutoResumer(deps(), FAST);
    lastInputAt = T0 - 1;
    ask();
    expect(events).toEqual([]); // 2 ms of quiet first
    advance(1);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 1 + 3 }]);
    advance(3);
    expect(typed).toEqual([RESUME]);
  });

  it('looks again the moment it would type: with a program in front of the shell (one that printed a prompt) nothing is typed, the notice ends, and no attempt is counted or given up', () => {
    ask();
    advance(2_999);
    shellInFront = false; // the marks still say "a prompt, nothing running"
    advance(1);
    expect(typed).toEqual([]);
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'cancelled', id: ID },
    ]);
    expect(liveTimers()).toBe(0);
    // the request is over: nothing comes later by itself, and asked again at the shell's own prompt it goes ahead
    shellInFront = true;
    advance(600_000);
    expect(events).toHaveLength(2);
    ask();
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled', 'pending', 'typed']); // no other kind of event exists
  });

  it('asks whether the shell is at a prompt or busy only when there is a conversation to resume (the daemon asks the system for it)', () => {
    let asked = 0;
    r = new AutoResumer({ ...deps(), promptReady: () => (asked++, promptReady), busy: () => (asked++, busy) });
    offer = null;
    ask();
    ask();
    expect(asked).toBe(0);
    offer = { id: ID };
    ask();
    expect(asked).toBeGreaterThan(0);
  });

  /** The person types during the notice: the key sits in the shell's line, so the prompt is no longer clean (as the daemon sees it). */
  const typesDuringNotice = () => {
    lastInputAt = now;
    promptReady = false;
  };
  /** Their command runs and ends: a clean prompt again, the person quiet for a while. */
  const theirCommandRan = () => {
    busy = true;
    advance(5_000);
    busy = false;
    promptReady = true;
  };

  it('the person typing during the notice is a no, as Cancel is: nothing is typed, and the clean prompts after their commands stay quiet for that offer (the button is left)', () => {
    ask();
    advance(1_000);
    typesDuringNotice();
    advance(2_000);
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    for (let i = 0; i < 3; i++) {
      theirCommandRan();
      advance(600_000);
    }
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    expect(liveTimers()).toBe(0);
  });
});

// 0.5.1: nothing resumes by itself. What is left serves Restart Claude Code only: the person's request, the notice with Cancel, the
// quiet and line rules, and an end to a running notice when the daemon stops, the shell dies or the offer changes.
describe('AutoResumer in 0.5.1: only what Restart Claude Code needs', () => {
  let now: number;
  let timers: { fn: () => void; at: number; live: boolean }[];
  let offer: { id: string } | null;
  let promptReady: boolean;
  let lastInputAt: number;
  let typed: string[];
  let events: AutoResumeEvent[];

  const advance = (ms: number) => {
    const to = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.fn();
    }
    now = to;
  };
  /** Only what the reduced module asks for: no setting, no attempts. */
  const deps = (): AutoResumeDeps => ({
    now: () => now,
    offer: () => offer,
    promptReady: () => promptReady,
    busy: () => false,
    lastInputAt: () => lastInputAt,
    stopping: () => false,
    mayType: () => true,
    type: (text) => {
      typed.push(text);
      promptReady = false; // the shell runs it
    },
    emit: (e) => void events.push(e),
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { live: boolean }).live = false;
    },
  });
  const make = () => new AutoResumer(deps());
  const liveTimers = () => timers.filter((t) => t.live).length;

  beforeEach(() => {
    now = T0;
    timers = [];
    offer = { id: ID };
    promptReady = true;
    lastInputAt = 0;
    typed = [];
    events = [];
  });

  it('has no crash retry, no resume after a shell died, no attempts, no setting and no give-up, and nothing starts without the person asking (the types say so too)', async () => {
    const r = make();
    // @ts-expect-error a `claude` that ends is never tried again by itself
    expect(r.claudeEnded).toBeUndefined();
    // @ts-expect-error a shell that died brings nothing back by itself
    expect(r.shellDied).toBeUndefined();
    // @ts-expect-error a check needs the person's request: there is none of its own
    void (() => r.check());
    // @ts-expect-error there is no give-up any more, so no such event
    const gaveUp: AutoResumeEvent = { state: 'gave-up', id: ID };
    void gaveUp;
    const d = deps();
    // @ts-expect-error no setting: only a request the person made goes ahead
    void d.enabled;
    // @ts-expect-error no attempts are counted or kept
    void d.attempts;
    // @ts-expect-error (as above)
    void d.recordAttempt;
    // @ts-expect-error (as above)
    void d.clearAttempts;
    const t: AutoResumeTiming = AUTO_RESUME;
    // @ts-expect-error no waits before a retry
    void t.waitsMs;
    // @ts-expect-error no limit on attempts
    void t.maxAttempts;
    const mod: Record<string, unknown> = await import('../src/core/claude/auto-resume');
    expect('waitBefore' in mod).toBe(false); // the waits before a retry are gone with it
    expect({ ...AUTO_RESUME }).toEqual({ noticeMs: 3_000, quietMs: 2_000 }); // the 3 s notice and the 2 s quiet, nothing else
    expect(Object.keys(AUTO_RESUME_TEST).sort()).toEqual(['noticeMs', 'quietMs']);
  });

  it('ends a running notice when the daemon says so (it stops, the shell died, the offer changed): `cancelled`, nothing typed, and the request is over', () => {
    const r = make();
    r.check({ explicit: true });
    advance(1_000);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 3_000 }]);
    r.endNotice();
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'cancelled', id: ID },
    ]);
    expect(liveTimers()).toBe(0);
    advance(600_000);
    expect(typed).toEqual([]);
    expect(events).toHaveLength(2);
    r.endNotice(); // with nothing running it says nothing
    expect(events).toHaveLength(2);
  });

  it('ends a request that still waits for quiet too: no notice, no timer, nothing typed later', () => {
    const r = make();
    lastInputAt = T0 - 500;
    r.check({ explicit: true });
    expect(events).toEqual([]);
    expect(liveTimers()).toBe(1);
    r.endNotice();
    expect(liveTimers()).toBe(0);
    advance(600_000);
    expect(events).toEqual([]);
    expect(typed).toEqual([]);
  });

  it('Restart Claude three times in a row resumes three times: nothing is counted, and nothing gives up', () => {
    const r = make();
    for (let i = 1; i <= 3; i++) {
      promptReady = true; // the new shell's prompt
      r.check({ explicit: true });
      advance(3_000);
      expect(typed).toHaveLength(i);
    }
    expect(typed).toEqual([RESUME, RESUME, RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed', 'pending', 'typed', 'pending', 'typed']);
  });
});
