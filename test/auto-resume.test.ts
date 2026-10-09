import { beforeEach, describe, expect, it } from 'vitest';
import { AutoResumer, nextStep, waitBefore, type AutoResumeDeps, type AutoResumeEvent, type AutoResumeInput, type AutoResumeTiming } from '../src/core/claude/auto-resume';
import { AUTO_RESUME } from '../src/shared/keep-running';

const ID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';
const OTHER = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const RESUME = `claude --resume ${ID}\r`;
const T0 = 50_000_000;

/** The daemon's test mode: the same numbers, in milliseconds. */
const FAST: AutoResumeTiming = { noticeMs: 3, quietMs: 2, maxAttempts: 3, windowMs: 600, waitsMs: [3, 20, 120], healthyMs: 30 };

describe('waitBefore', () => {
  it('waits 3 s before the first try, 20 s before the second, 2 min before the third and any later', () => {
    expect(waitBefore([])).toBe(3_000);
    expect(waitBefore([1])).toBe(20_000);
    expect(waitBefore([1, 2])).toBe(120_000);
    expect(waitBefore([1, 2, 3, 4])).toBe(120_000);
  });

  it('reads the waits from the timing it is given', () => {
    expect(waitBefore([], FAST)).toBe(3);
    expect(waitBefore([1], FAST)).toBe(20);
    expect(waitBefore([1, 2, 3], FAST)).toBe(120);
  });
});

describe('nextStep', () => {
  const ready: AutoResumeInput = { now: T0, offer: { id: ID }, promptReady: true, busy: false, lastInputAt: T0 - 60_000, enabled: true, stopping: false, attempts: [], cancelled: false };
  const step = (over: Partial<AutoResumeInput> = {}) => nextStep({ ...ready, ...over });
  const three = [T0 - 300_000, T0 - 200_000, T0 - 100_000];

  it.each<[string, Partial<AutoResumeInput>]>([
    ['there is no offer', { offer: null }],
    ['the setting is off', { enabled: false }],
    ['the daemon is stopping', { stopping: true }],
    ['the person cancelled it', { cancelled: true }],
    ['the id is not a session id', { offer: { id: 'x; rm -rf ~' } }],
    ['the id is empty', { offer: { id: '' } }],
    ['the id is too short', { offer: { id: 'abc' } }],
    ['something runs in the shell', { busy: true }],
    ['the shell is not at a prompt', { promptReady: false }],
    ['something runs and the person typed 1 s ago (idle, not wait)', { busy: true, lastInputAt: T0 - 1_000 }],
    ['the shell is not at a prompt and the person typed 1 s ago (idle, not wait)', { promptReady: false, lastInputAt: T0 - 1_000 }],
    ['something starts running during the notice', { busy: true, pendingSince: T0 - 3_000 }],
    ['the setting is off, even at the limit', { enabled: false, attempts: three }],
    ['the daemon is stopping, even at the limit', { stopping: true, attempts: three }],
    ['the person cancelled it, even at the limit', { cancelled: true, attempts: three }],
    ['there is no offer, even at the limit', { offer: null, attempts: three }],
  ])('is idle when %s', (_, over) => {
    expect(step(over)).toEqual({ kind: 'idle' });
  });

  it('announces when everything holds, typing after the notice', () => {
    expect(step()).toEqual({ kind: 'announce', typesAt: T0 + AUTO_RESUME.noticeMs });
    expect(step()).toEqual({ kind: 'announce', typesAt: T0 + 3_000 });
  });

  it('announces a retry with its own, longer wait, so the notice tells the truth', () => {
    expect(step({ attempts: [T0 - 30_000] })).toEqual({ kind: 'announce', typesAt: T0 + 20_000 });
    expect(step({ attempts: [T0 - 90_000, T0 - 30_000] })).toEqual({ kind: 'announce', typesAt: T0 + 120_000 });
  });

  it('waits for 2 s of quiet after the person typed before announcing', () => {
    expect(step({ lastInputAt: T0 - 1_000 })).toEqual({ kind: 'wait', until: T0 + 1_000 });
    expect(step({ lastInputAt: T0 - 2_000 })).toEqual({ kind: 'announce', typesAt: T0 + 3_000 });
  });

  it('types once the wait since the notice has passed, and not a moment before', () => {
    expect(step({ pendingSince: T0 - 2_999 })).toEqual({ kind: 'wait', until: T0 + 1 });
    expect(step({ pendingSince: T0 - 3_000 })).toEqual({ kind: 'type', id: ID });
    expect(step({ pendingSince: T0 - 19_999, attempts: [T0 - 60_000] })).toEqual({ kind: 'wait', until: T0 + 1 });
    expect(step({ pendingSince: T0 - 20_000, attempts: [T0 - 60_000] })).toEqual({ kind: 'type', id: ID });
    expect(step({ pendingSince: T0 - 120_000, attempts: [T0 - 200_000, T0 - 150_000] })).toEqual({ kind: 'type', id: ID });
  });

  it('types at the time it announced, even when an older attempt ages out during the notice', () => {
    // announced with two attempts (2 min); one has aged out since, which alone would make the wait 20 s
    expect(step({ pendingSince: T0 - 20_000, typesAt: T0 + 100_000, attempts: [T0 - 60_000] })).toEqual({ kind: 'wait', until: T0 + 100_000 });
    expect(step({ pendingSince: T0 - 120_000, typesAt: T0, attempts: [T0 - 60_000] })).toEqual({ kind: 'type', id: ID });
    expect(step({ pendingSince: T0 - 120_000, typesAt: T0, lastInputAt: T0 - 500 })).toEqual({ kind: 'wait', until: T0 + 1_500 });
  });

  it('the person typing during the notice moves the typing to 2 s after their last key', () => {
    expect(step({ pendingSince: T0 - 3_000, lastInputAt: T0 - 500 })).toEqual({ kind: 'wait', until: T0 + 1_500 });
    expect(step({ pendingSince: T0 - 3_000, lastInputAt: T0 - 2_000 })).toEqual({ kind: 'type', id: ID });
  });

  it('gives up at three attempts in ten minutes, whatever the shell is doing', () => {
    expect(step({ attempts: three })).toEqual({ kind: 'give-up' });
    expect(step({ attempts: [...three, T0 - 1] })).toEqual({ kind: 'give-up' });
    expect(step({ attempts: three, busy: true })).toEqual({ kind: 'give-up' });
    expect(step({ attempts: three, promptReady: false })).toEqual({ kind: 'give-up' });
    expect(step({ attempts: three, pendingSince: T0 - 200_000 })).toEqual({ kind: 'give-up' });
  });

  it('does not count attempts older than ten minutes', () => {
    expect(step({ attempts: [T0 - 700_000, T0 - 650_000, T0 - 100_000] })).toEqual({ kind: 'announce', typesAt: T0 + 20_000 });
    expect(step({ attempts: [T0 - 600_000, T0 - 599_999, T0 - 1] })).toEqual({ kind: 'announce', typesAt: T0 + 120_000 });
  });

  it('reads every number from the timing it is given', () => {
    expect(nextStep(ready, FAST)).toEqual({ kind: 'announce', typesAt: T0 + 3 });
    expect(nextStep({ ...ready, lastInputAt: T0 - 1 }, FAST)).toEqual({ kind: 'wait', until: T0 + 1 });
    expect(nextStep({ ...ready, attempts: [T0 - 30] }, FAST)).toEqual({ kind: 'announce', typesAt: T0 + 20 });
    expect(nextStep({ ...ready, pendingSince: T0 - 20, attempts: [T0 - 30] }, FAST)).toEqual({ kind: 'type', id: ID });
    expect(nextStep({ ...ready, attempts: [T0 - 30, T0 - 20, T0 - 10] }, FAST)).toEqual({ kind: 'give-up' });
    expect(nextStep({ ...ready, attempts: [T0 - 700, T0 - 20, T0 - 10] }, FAST)).toEqual({ kind: 'announce', typesAt: T0 + 120 });
    expect(nextStep({ ...ready, attempts: [T0 - 30, T0 - 20] }, { ...FAST, maxAttempts: 2 })).toEqual({ kind: 'give-up' });
  });
});

describe('AutoResumer', () => {
  let now: number;
  let timers: { fn: () => void; at: number; live: boolean }[];
  let offer: { id: string } | null;
  let promptReady: boolean;
  let busy: boolean;
  let lastInputAt: number;
  let enabled: boolean;
  let stopping: boolean;
  /** The shell itself has the terminal (the daemon asks the system: no program it runs, whatever the marks say). */
  let shellInFront: boolean;
  let tries: Map<string, number[]>;
  let cleared: string[];
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
    enabled: () => enabled,
    stopping: () => stopping,
    mayType: () => shellInFront,
    // like ResumeStore: the times that still count
    attempts: (id) => (tries.get(id) ?? []).filter((t) => now - t < AUTO_RESUME.windowMs),
    recordAttempt: (id) => void tries.set(id, [...(tries.get(id) ?? []), now]),
    clearAttempts: (id) => {
      cleared.push(id);
      tries.delete(id);
    },
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
    enabled = true;
    stopping = false;
    shellInFront = true;
    tries = new Map();
    cleared = [];
    typed = [];
    events = [];
    r = new AutoResumer(deps());
  });

  /** Claude Code ran for `durMs` and ended with `exit`; the shell is back at its prompt. */
  const ended = (exit: number | null, durMs: number) => {
    advance(durMs);
    busy = false;
    promptReady = true;
    r.claudeEnded({ exit, durMs });
  };
  const gaveUp = () => events.filter((e) => e.state === 'gave-up');
  const liveTimers = () => timers.filter((t) => t.live).length;

  it('says so, then types exactly `claude --resume <id>` and Enter 3 s later, once, and counts the attempt', () => {
    r.check();
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 3_000 }]);
    advance(2_999);
    expect(typed).toEqual([]);
    advance(1);
    expect(typed).toEqual([RESUME]);
    expect(tries.get(ID)).toEqual([T0 + 3_000]);
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'typed', id: ID },
    ]);
    advance(600_000);
    expect(typed).toEqual([RESUME]);
    expect(liveTimers()).toBe(0);
  });

  it('a second check() during the notice does not announce again, and one timer at most is pending', () => {
    r.check();
    advance(1_000);
    r.check();
    r.check();
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 3_000 }]);
    expect(liveTimers()).toBe(1);
    advance(2_000);
    expect(typed).toEqual([RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']);
  });

  it('Cancel before the time types nothing, and the same offer stays quiet until it changes', () => {
    r.check();
    advance(1_000);
    r.cancel();
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'cancelled', id: ID },
    ]);
    expect(liveTimers()).toBe(0);
    advance(10_000);
    r.check();
    r.check();
    advance(600_000);
    expect(typed).toEqual([]);
    expect(events).toHaveLength(2);
    expect(tries.get(ID)).toBeUndefined();

    offer = { id: OTHER }; // another conversation is offered
    r.check();
    expect(events.at(-1)).toEqual({ state: 'pending', id: OTHER, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([`claude --resume ${OTHER}\r`]);
  });

  it('Cancel leaves the button: the offer going away and coming back (a command run, a cd away and back) does not bring it back', () => {
    r.check();
    r.cancel();
    // a command runs: no offer while it does, then the prompt is back
    offer = null;
    busy = true;
    promptReady = false;
    r.check();
    offer = { id: ID };
    busy = false;
    promptReady = true;
    r.check();
    // a cd elsewhere (no offer in another folder) and back
    offer = null;
    r.check();
    offer = { id: ID };
    r.check();
    advance(600_000);
    r.check();
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
  });

  it('a long notice is not cut short when an older attempt ages out during it', () => {
    tries.set(ID, [T0 - 590_000, T0 - 60_000]);
    r.check();
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 120_000 }]);
    advance(15_000);
    r.check(); // the first attempt has aged out: alone that would make the wait 20 s
    advance(104_999);
    expect(typed).toEqual([]);
    advance(1);
    expect(now).toBe(T0 + 120_000);
    expect(typed).toEqual([RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']);
  });

  it('the person typing at 2.5 s moves the typing to 2 s after their last key', () => {
    r.check();
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
    r.check();
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
    r.check();
    expect(events).toEqual([]);
    advance(1_500);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 1_500 + 3_000 }]);
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('a command the person starts during the notice drops this try; the next prompt announces again', () => {
    r.check();
    advance(1_000);
    busy = true; // they pressed Enter on something
    promptReady = false;
    advance(5_000);
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    busy = false; // their command finished, the prompt is back
    promptReady = true;
    r.check();
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('a crash is tried again after 20 s, then after 2 min, and the fourth time it gives up once and types nothing', () => {
    r.check();
    advance(3_000);
    expect(typed).toHaveLength(1);

    ended(1, 5_000); // crashed within seconds
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 20_000 });
    advance(19_999);
    expect(typed).toHaveLength(1);
    advance(1);
    expect(typed).toEqual([RESUME, RESUME]);

    ended(1, 5_000);
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 120_000 });
    advance(119_999);
    expect(typed).toHaveLength(2);
    advance(1);
    expect(typed).toEqual([RESUME, RESUME, RESUME]);

    ended(1, 5_000);
    expect(gaveUp()).toEqual([{ state: 'gave-up', id: ID }]);
    expect(events.at(-1)).toEqual({ state: 'gave-up', id: ID });

    // later prompts, checks, and even the 10 minutes passing: no second notice, nothing typed
    r.check();
    advance(60_000);
    r.check();
    advance(600_000);
    r.check();
    advance(600_000);
    expect(gaveUp()).toHaveLength(1);
    expect(typed).toHaveLength(3);
    expect(tries.get(ID)).toHaveLength(3);
    expect(cleared).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed', 'pending', 'typed', 'pending', 'typed', 'gave-up']);
  });

  it('Restart Claude is not held to the crash-loop limit: at the limit it clears the attempts, announces the short notice and types, as one attempt', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    enabled = false; // (it does not need the setting)
    r.check({ explicit: true });
    expect(cleared).toEqual([ID]);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]); // 3 s, not the 2 min of a third retry
    advance(2_999);
    expect(typed).toEqual([]);
    advance(1);
    expect(typed).toEqual([RESUME]);
    expect(tries.get(ID)).toEqual([now]); // it counts as one attempt, the first
    expect(gaveUp()).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']);
  });

  it('Restart Claude announces the short notice after earlier crashes too, never the 20 s or 2 min waits', () => {
    for (const before of [[T0 - 30_000], [T0 - 90_000, T0 - 30_000]]) {
      tries.set(ID, before);
      events.length = 0;
      typed.length = 0;
      r = new AutoResumer(deps());
      r.check({ explicit: true });
      expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
      advance(3_000);
      expect(typed).toEqual([RESUME]);
      busy = false;
      promptReady = true;
    }
  });

  it('what follows an explicit request is one attempt: its crash is tried again after the second wait', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    r.check({ explicit: true });
    advance(3_000);
    ended(1, 5_000); // crashed within seconds
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 20_000 });
    advance(20_000);
    expect(typed).toEqual([RESUME, RESUME]);
  });

  it('repeating the same explicit request while it waits is one request: attempts are cleared once and the notice is announced once', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    lastInputAt = T0 - 500; // the person typed: it waits for quiet
    r.check({ explicit: true });
    r.check({ explicit: true });
    expect(cleared).toEqual([ID]);
    advance(1_500);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    r.check({ explicit: true }); // (the daemon repeats it at each prompt)
    expect(events).toHaveLength(1);
    advance(3_000);
    expect(typed).toEqual([RESUME]);
    expect(tries.get(ID)).toEqual([now]);
  });

  it('a request that finds the shell not at a prompt is the same request at the next one: it announces the short notice then', () => {
    tries.set(ID, [T0 - 3, T0 - 2]);
    promptReady = false;
    r.check({ explicit: true });
    expect(events).toEqual([]);
    expect(typed).toEqual([]);
    promptReady = true;
    r.check({ explicit: true }); // the same request again at the next prompt
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
  });

  it('a give-up mark does not block Restart Claude: the attempts are still at the limit, and it clears both; automatic checks keep their word until then', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    r.check();
    r.check();
    expect(gaveUp()).toHaveLength(1);
    expect(typed).toEqual([]);
    r.check({ explicit: true });
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
    expect(gaveUp()).toHaveLength(1); // told once, then never again for this
  });

  it('a give-up whose attempts have aged out no longer blocks Restart Claude; automatic checks still stay quiet', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    r.check();
    expect(gaveUp()).toHaveLength(1);
    advance(AUTO_RESUME.windowMs + 1); // ten minutes later the attempts no longer count
    r.check();
    advance(60_000);
    r.check();
    expect(typed).toEqual([]); // the person was told once: automatic keeps its word
    expect(events).toHaveLength(1);
    r.check({ explicit: true }); // but they asked now
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
    expect(gaveUp()).toHaveLength(1);
  });

  it('a new offer after giving up starts over', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    r.check();
    r.check();
    expect(gaveUp()).toHaveLength(1);
    offer = { id: OTHER };
    r.check();
    advance(3_000);
    expect(typed).toEqual([`claude --resume ${OTHER}\r`]);
    offer = { id: ID }; // the first one again: a new give-up is a new notice
    busy = false;
    promptReady = true;
    r.check();
    expect(gaveUp()).toHaveLength(2);
    expect(typed).toHaveLength(1);
  });

  it('gives up once: the offer going away and coming back (commands, a cd away and back) tells nothing more and types nothing', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    r.check();
    for (let i = 0; i < 3; i++) {
      offer = null;
      r.check();
      offer = { id: ID };
      r.check();
    }
    advance(700_000); // and once the attempts have aged out
    offer = null;
    r.check();
    offer = { id: ID };
    r.check();
    advance(600_000);
    expect(gaveUp()).toEqual([{ state: 'gave-up', id: ID }]);
    expect(events).toEqual([{ state: 'gave-up', id: ID }]);
    expect(typed).toEqual([]);
  });

  it('a different offer clears both marks', () => {
    r.check();
    r.cancel(); // ID cancelled
    tries.set(OTHER, [T0 - 3, T0 - 2, T0 - 1]);
    offer = { id: OTHER };
    r.check(); // OTHER at the limit
    expect(gaveUp()).toHaveLength(1);
    offer = { id: ID };
    r.check(); // the Cancel of ID is gone
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
    busy = false;
    promptReady = true;
    offer = { id: OTHER };
    r.check(); // and so is the give-up of OTHER: a new episode
    expect(gaveUp()).toHaveLength(2);
    expect(typed).toEqual([RESUME]);
  });

  it('a Claude run ending clears the Cancel mark, and the next check goes by the rules again', () => {
    r.check();
    r.cancel();
    r.check();
    expect(events).toHaveLength(2);
    busy = true; // the person resumed it from the button, and it crashed
    promptReady = false;
    ended(1, 5_000);
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('a deliberate end also clears the Cancel mark, without a check of its own', () => {
    r.check();
    r.cancel();
    ended(0, 5_000);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    r.check();
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
  });

  it('a Claude run ending clears the give-up mark: still at the limit, it gives up again exactly once', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    r.check();
    expect(gaveUp()).toHaveLength(1);
    ended(1, 5_000); // the person's own resume crashed
    expect(gaveUp()).toHaveLength(2);
    r.check();
    offer = null;
    r.check();
    offer = { id: ID };
    r.check();
    expect(gaveUp()).toHaveLength(2);
    expect(typed).toEqual([]);
  });

  it('a shell that died clears the Cancel mark and checks again: Claude comes back in the new shell', () => {
    r.check();
    r.cancel();
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    r.shellDied(); // (this stand-in shell is already at its prompt again)
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('a shell that died keeps the give-up: still at the limit, the new shell tells nothing more and types nothing', () => {
    tries.set(ID, [T0 - 3, T0 - 2, T0 - 1]);
    r.check();
    expect(gaveUp()).toHaveLength(1);
    promptReady = false; // the shell is gone
    r.shellDied();
    promptReady = true; // and the new one is at its prompt
    r.check();
    advance(10_000);
    r.shellDied(); // and again
    r.check();
    expect(gaveUp()).toHaveLength(1);
    expect(events).toEqual([{ state: 'gave-up', id: ID }]);
    expect(typed).toEqual([]);
  });

  it('a short crash after a try keeps the attempt; a healthy run (30 s or more) that crashes later starts over', () => {
    r.check();
    advance(3_000);
    ended(1, 5_000);
    expect(cleared).toEqual([]);
    expect(tries.get(ID)).toHaveLength(1);
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 20_000 }); // the second try waits longer
    advance(20_000);
    expect(typed).toHaveLength(2);

    ended(1, 60_000); // ran for a minute, then crashed: that attempt worked
    expect(cleared).toEqual([ID]);
    expect(tries.get(ID)).toBeUndefined();
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 }); // a fresh start: the first wait
    advance(3_000);
    expect(typed).toEqual([RESUME, RESUME, RESUME]);
    expect(tries.get(ID)).toEqual([now]);
  });

  it('a healthy run is judged by how long it lasted, also when the prompt comes back after the exit is reported', () => {
    r.check();
    advance(3_000);
    advance(30_000);
    busy = false; // the command ended; the prompt is not drawn yet
    r.claudeEnded({ exit: 2, durMs: 30_000 });
    expect(cleared).toEqual([ID]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']);
    promptReady = true; // the prompt event
    r.check();
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
  });

  it.each<[string, number | null]>([
    ['exit 0', 0],
    ['Ctrl+C (130)', 130],
    ['stopped with Ctrl+Z (146)', 146],
    ['stopped (145)', 145],
    ['stopped (150)', 150],
    ['an unknown exit', null],
  ])('a deliberate or unclear end (%s) is never resumed', (_, exit) => {
    r.check();
    advance(3_000);
    ended(exit, 5_000);
    advance(600_000);
    expect(typed).toEqual([RESUME]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'typed']);
    expect(cleared).toEqual([]);
    ended(exit, 60_000);
    expect(cleared).toEqual([]);
    expect(typed).toHaveLength(1);
  });

  it('a crash of a Claude the person started is tried again, without touching the attempts', () => {
    busy = true;
    promptReady = false;
    r.check(); // their `claude` is running
    expect(events).toEqual([]);
    ended(1, 3_600_000);
    expect(cleared).toEqual([]);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('explicit (Restart Claude) types even with the setting off', () => {
    enabled = false;
    r.check();
    advance(10_000);
    expect(events).toEqual([]);
    r.check({ explicit: true });
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    advance(3_000);
    expect(typed).toEqual([RESUME]);
    expect(tries.get(ID)).toEqual([now]); // it counts as an attempt
    // the request was for that once: a crash afterwards is not retried with the setting off
    ended(1, 5_000);
    advance(600_000);
    expect(typed).toHaveLength(1);
  });

  it('explicit never ignores the other conditions', () => {
    enabled = false;
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
      r.check({ explicit: true });
      advance(600_000);
    }
    expect(typed).toEqual([]);
    expect(events).toEqual([]);

    offer = { id: ID };
    promptReady = true;
    busy = false;
    stopping = false;
    lastInputAt = now - 500; // the quiet period
    r.check({ explicit: true });
    expect(events).toEqual([]);
    advance(1_500);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    r.cancel(); // Cancel during its notice
    advance(600_000);
    r.check();
    expect(typed).toEqual([]);
  });

  it('asking again (explicit) after an earlier Cancel resumes; a later automatic check stays cancelled', () => {
    r.check();
    r.cancel();
    r.check();
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    r.check({ explicit: true }); // the person chose Restart Claude: that is asking again
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('the explicit request lasts through its own wait for quiet and its notice, even with the setting off', () => {
    enabled = false;
    lastInputAt = T0 - 1_000;
    r.check({ explicit: true });
    advance(1_000);
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: now + 3_000 }]);
    r.check(); // an automatic check meanwhile (a prompt, a config change) does not drop it
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('nothing is typed when the daemon starts stopping during the wait', () => {
    r.check();
    advance(1_000);
    stopping = true;
    advance(600_000);
    expect(typed).toEqual([]);
    expect(tries.get(ID)).toBeUndefined();
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
  });

  it('turning the setting off during the notice drops it', () => {
    r.check();
    advance(1_000);
    enabled = false;
    r.check(); // the config change
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    advance(600_000);
    expect(typed).toEqual([]);
  });

  it('another conversation offered during the notice drops the first and announces the new one', () => {
    r.check();
    advance(1_000);
    offer = { id: OTHER };
    advance(2_000);
    expect(typed).toEqual([]);
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'cancelled', id: ID },
      { state: 'pending', id: OTHER, typesAt: T0 + 6_000 },
    ]);
    advance(3_000);
    expect(typed).toEqual([`claude --resume ${OTHER}\r`]);
  });

  it('only a session id is ever typed', () => {
    for (const id of ['x; rm -rf ~', '', 'abc', '-rf-rf-rf-rf', 'a'.repeat(65), 'abcdefgh\rrm', '$(reboot)ab']) {
      offer = { id };
      r.check();
      r.check({ explicit: true });
      advance(600_000);
    }
    expect(typed).toEqual([]);
    expect(events).toEqual([]);
  });

  it('takes its numbers from the timing it is given (the daemon test mode)', () => {
    r = new AutoResumer(deps(), FAST);
    r.check();
    expect(events).toEqual([{ state: 'pending', id: ID, typesAt: T0 + 3 }]);
    advance(3);
    expect(typed).toEqual([RESUME]);
    ended(1, 5);
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 20 });
    advance(20);
    ended(1, 30); // healthy at 30 ms
    expect(cleared).toEqual([ID]);
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3 });
  });

  it('looks again the moment it would type: with a program in front of the shell (one that printed a prompt) nothing is typed, the notice ends, and no attempt is counted or given up', () => {
    r.check();
    advance(2_999);
    shellInFront = false; // the marks still say "a prompt, nothing running"
    advance(1);
    expect(typed).toEqual([]);
    expect(events).toEqual([
      { state: 'pending', id: ID, typesAt: T0 + 3_000 },
      { state: 'cancelled', id: ID },
    ]);
    expect(tries.get(ID)).toBeUndefined();
    expect(gaveUp()).toEqual([]);
    expect(liveTimers()).toBe(0);
    // nobody said no: at the shell's own prompt later it goes ahead
    shellInFront = true;
    r.check();
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(3_000);
    expect(typed).toEqual([RESUME]);
  });

  it('asks whether the shell is at a prompt or busy only when there is a conversation to resume (the daemon asks the system for it)', () => {
    let asked = 0;
    r = new AutoResumer({ ...deps(), promptReady: () => (asked++, promptReady), busy: () => (asked++, busy) });
    offer = null;
    r.check();
    r.check();
    expect(asked).toBe(0);
    offer = { id: ID };
    r.check();
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
    r.check();
    advance(5_000);
    busy = false;
    promptReady = true;
    r.check();
  };

  it('the person typing during the notice is a no, as Cancel is: nothing is typed, and the clean prompts after their commands stay quiet for that offer (the button is left)', () => {
    r.check();
    advance(1_000);
    typesDuringNotice();
    advance(2_000);
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    for (let i = 0; i < 3; i++) {
      theirCommandRan();
      advance(600_000);
    }
    r.check();
    expect(typed).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    expect(tries.get(ID)).toBeUndefined();
    // another conversation is offered: it is announced
    offer = { id: OTHER };
    r.check();
    expect(events.at(-1)).toEqual({ state: 'pending', id: OTHER, typesAt: now + 3_000 });
  });

  it('that no clears as Cancel does: a Claude run that ends, or the shell dying, brings the same offer back', () => {
    r.check();
    advance(1_000);
    typesDuringNotice();
    advance(2_000);
    theirCommandRan();
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    ended(1, 5_000); // a Claude run crashed since: the history starts again
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    advance(1_000);
    typesDuringNotice();
    advance(2_000);
    theirCommandRan();
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled', 'pending', 'cancelled']);
    r.shellDied(); // the shell died: a new one's prompt may bring it back
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
  });

  it('a notice that ends without the person typing (their prompt went away by itself, the offer went) is not a no: the next clean prompt announces again', () => {
    r.check();
    advance(1_000);
    promptReady = false; // (no key: the shell was not at a prompt for a moment)
    advance(2_000);
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled']);
    promptReady = true;
    r.check();
    expect(events.at(-1)).toEqual({ state: 'pending', id: ID, typesAt: now + 3_000 });
    offer = null; // the offer goes for a moment, the person typed nothing
    r.check();
    offer = { id: ID };
    r.check();
    expect(events.map((e) => e.state)).toEqual(['pending', 'cancelled', 'pending', 'cancelled', 'pending']);
  });
});
