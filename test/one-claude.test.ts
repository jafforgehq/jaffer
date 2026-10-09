import { describe, expect, it } from 'vitest';
import { TWO_RUNNING_DELAY_MS, TwoRunningNotice, twoRunning } from '../src/shared/one-claude';

const s = (id: string, state = 'idle') => ({ id, state });

describe('twoRunning: tell the person once when a second Claude conversation runs, never end anything', () => {
  it('says nothing for none, or for one conversation', () => {
    expect(twoRunning([], new Set())).toBeNull();
    expect(twoRunning([s('a')], new Set())).toBeNull();
    expect(twoRunning([s('a', 'working')], new Set())).toBeNull();
  });

  it('gives a key for two that are active: the ids, sorted and joined by +', () => {
    expect(twoRunning([s('a'), s('b')], new Set())).toBe('a+b');
  });

  it('counts idle, working and needs-you alike', () => {
    expect(twoRunning([s('a', 'idle'), s('b', 'working')], new Set())).toBe('a+b');
    expect(twoRunning([s('a', 'needs-you'), s('b', 'idle')], new Set())).toBe('a+b');
    expect(twoRunning([s('a', 'working'), s('b', 'needs-you')], new Set())).toBe('a+b');
  });

  it('says nothing the second time for the same two: a key already told is not given again', () => {
    expect(twoRunning([s('a'), s('b')], new Set(['a+b']))).toBeNull();
    // and it does not remember by itself: the caller keeps the set
    const told = new Set<string>();
    expect(twoRunning([s('a'), s('b')], told)).toBe('a+b');
    expect(told.size).toBe(0);
  });

  it('does not count a conversation that has ended', () => {
    expect(twoRunning([s('a'), s('b', 'ended')], new Set())).toBeNull();
    expect(twoRunning([s('a', 'ended'), s('b', 'ended')], new Set())).toBeNull();
    // the ended one is not in the key either
    expect(twoRunning([s('a'), s('b', 'ended'), s('c', 'working')], new Set())).toBe('a+c');
  });

  it('gives one key for three, with all three in it', () => {
    expect(twoRunning([s('a'), s('b'), s('c')], new Set())).toBe('a+b+c');
    // two of them told earlier is a different set, so it is told
    expect(twoRunning([s('a'), s('b'), s('c')], new Set(['a+b']))).toBe('a+b+c');
  });

  it('sorts the ids, so the order they arrive in does not matter', () => {
    expect(twoRunning([s('b'), s('a')], new Set())).toBe('a+b');
    expect(twoRunning([s('c'), s('a'), s('b')], new Set())).toBe('a+b+c');
    expect(twoRunning([s('b'), s('a')], new Set(['a+b']))).toBeNull();
  });

  it('a pair that changes (one leaves, another comes) is a new set; the pair seen before is not told again', () => {
    const told = new Set(['a+b']);
    expect(twoRunning([s('a'), s('c')], told)).toBe('a+c');
    expect(twoRunning([s('a'), s('b')], told)).toBeNull();
  });

  it('one conversation listed twice is still one', () => {
    expect(twoRunning([s('a'), s('a', 'working')], new Set())).toBeNull();
  });

  it('only reads the sessions: nothing is changed in them', () => {
    const sessions = [s('b'), s('a'), s('c', 'ended')];
    const copy = JSON.parse(JSON.stringify(sessions));
    twoRunning(sessions, new Set());
    expect(sessions).toEqual(copy);
  });
});

describe('TwoRunningNotice: only a second conversation that is still there a moment later is told (/clear starts the new one before the old one has ended)', () => {
  function notice() {
    let now = 0;
    const timers: { fn: () => void; at: number; live: boolean }[] = [];
    const told: string[] = [];
    const n = new TwoRunningNotice({
      tell: (key) => void told.push(key),
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => void ((t as { live: boolean }).live = false),
    });
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
    return { n, told, advance, live: () => timers.filter((t) => t.live).length };
  }

  it('waits about a second and a half', () => {
    expect(TWO_RUNNING_DELAY_MS).toBe(1_500);
  });

  it('a pair that resolves within the delay says nothing: the new conversation started, then the old one ended (/clear)', () => {
    const t = notice();
    t.n.update([s('old', 'working')]);
    t.n.update([s('new'), s('old', 'working')]); // SessionStart of the new one came first
    t.advance(400);
    t.n.update([s('new'), s('old', 'ended')]); // then the old one's SessionEnd
    t.advance(5_000);
    expect(t.told).toEqual([]);
    expect(t.live()).toBe(0); // its timer went with it
  });

  it('a pair that is still there after the delay is told, once, and not again for the same two', () => {
    const t = notice();
    t.n.update([s('a', 'working'), s('b')]);
    t.advance(1_499);
    expect(t.told).toEqual([]);
    t.n.update([s('b', 'needs-you'), s('a', 'working')]); // the same two, another order and state: the same wait
    t.advance(1);
    expect(t.told).toEqual(['a+b']);
    t.n.update([s('a'), s('b', 'ended')]);
    t.n.update([s('a'), s('b')]);
    t.advance(5_000);
    expect(t.told).toEqual(['a+b']);
  });

  it('what is told is the set running when the delay is over: a third arriving meanwhile is one notice, for the three', () => {
    const t = notice();
    t.n.update([s('a'), s('b')]);
    t.advance(1_000);
    t.n.update([s('a'), s('b'), s('c')]);
    t.advance(1_000);
    expect(t.told).toEqual([]);
    t.advance(500);
    expect(t.told).toEqual(['a+b+c']);
    expect(t.live()).toBe(0);
  });
});
