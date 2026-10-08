import { beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeSession } from '../src/core/claude/watcher';
import type { TurnCost } from '../src/shared/claude-cost';
import { COST_WAIT_MS, FINISHED_MIN_MS, FinishedNotifier } from '../src/shared/finished-notifier';
import { took } from '../src/shared/notify-policy';

let now = 1_000_000;
let focused = false;
let enabled = true;
let showCost = true;
let lastTerminalNotifyAt = 0;
let sent: { title: string; body: string }[] = [];
let timers: { fn: () => void; at: number; id: number; live: boolean }[] = [];
let notifier: FinishedNotifier;

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

beforeEach(() => {
  now = 1_000_000;
  focused = false;
  enabled = true;
  showCost = true;
  lastTerminalNotifyAt = 0;
  sent = [];
  timers = [];
  notifier = new FinishedNotifier({
    enabled: () => enabled,
    showCost: () => showCost,
    windowFocused: () => focused,
    lastTerminalNotifyAt: () => lastTerminalNotifyAt,
    now: () => now,
    notify: (n) => sent.push(n),
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, id: timers.length, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const t = timers[id as number];
      if (t) t.live = false;
    },
  });
});

const turn = (usd: number | undefined): TurnCost => ({ usd, input: 1, output: 2, cacheRead: 0, cacheWrite: 0, messages: 1 });
const session = (state: ClaudeSession['state'], over: Partial<ClaudeSession> = {}): ClaudeSession => ({ id: 's1', state, since: now, subagents: [], ...over });
const withCost = (usd: number | undefined, answers: number): ClaudeSession['cost'] => ({ last: turn(usd), totalUsd: usd ?? 0, answers, partial: usd === undefined, at: now });

/** A turn that began `ms` ago, working now. */
const working = (ms: number, over: Partial<ClaudeSession> = {}) => session('working', { turnStartedAt: now - ms, ...over });

describe('FinishedNotifier', () => {
  it('says a long turn finished, how long it took, and what it cost when the cost arrives in time', () => {
    notifier.update([working(4 * 60_000)]);
    notifier.update([session('idle', { turnStartedAt: now - 4 * 60_000 })]); // the Stop hook
    expect(sent).toEqual([]); // waits a moment for the cost
    advance(900);
    notifier.update([session('idle', { cost: withCost(0.314, 1) })]); // read from the transcript
    expect(sent).toEqual([{ title: 'Claude finished', body: '4 min · ≈ $0.31' }]);
    advance(10_000);
    expect(sent).toHaveLength(1); // and not again when the timer would have fired
  });

  it('says nothing for a turn that was cut short (Esc, a declined prompt, an API error that went quiet): it did not finish', () => {
    notifier.update([working(7 * 60_000)]);
    notifier.update([session('idle', { turnStartedAt: now - 7 * 60_000, cutShort: true })]);
    advance(COST_WAIT_MS + 5_000);
    expect(sent).toEqual([]);
  });

  it('says it without the cost when the cost never arrives', () => {
    notifier.update([working(90_000)]);
    notifier.update([session('idle')]);
    advance(COST_WAIT_MS - 1);
    expect(sent).toEqual([]);
    advance(2);
    expect(sent).toEqual([{ title: 'Claude finished', body: '2 min' }]);
  });

  it('leaves the cost out when it cannot be priced, or when the cost figure is switched off', () => {
    notifier.update([working(60_000)]);
    notifier.update([session('idle')]);
    notifier.update([session('idle', { cost: withCost(undefined, 1) })]);
    expect(sent).toEqual([{ title: 'Claude finished', body: '60s' }]);
    sent = [];
    showCost = false;
    notifier.update([working(60_000, { cost: withCost(0.2, 1) })]);
    notifier.update([session('idle', { cost: withCost(0.2, 1) })]);
    notifier.update([session('idle', { cost: withCost(0.5, 2) })]);
    expect(sent).toEqual([{ title: 'Claude finished', body: '60s' }]);
  });

  it('is quiet for a quick turn', () => {
    notifier.update([working(FINISHED_MIN_MS - 1000)]);
    notifier.update([session('idle')]);
    advance(10_000);
    expect(sent).toEqual([]);
    notifier.update([working(FINISHED_MIN_MS)]);
    notifier.update([session('idle')]);
    advance(10_000);
    expect(sent).toHaveLength(1);
  });

  it('is quiet when you are looking at Jaffer, also when you came back during the moment it waited', () => {
    focused = true;
    notifier.update([working(120_000)]);
    notifier.update([session('idle')]);
    advance(10_000);
    expect(sent).toEqual([]);
    focused = false;
    notifier.update([working(120_000)]);
    notifier.update([session('idle')]);
    advance(1000);
    focused = true; // back at the window
    advance(5000);
    expect(sent).toEqual([]);
  });

  it('is quiet when Claude Code already told you through the terminal, and when it is switched off', () => {
    lastTerminalNotifyAt = now - 2000;
    notifier.update([working(120_000)]);
    notifier.update([session('idle')]);
    advance(5000);
    expect(sent).toEqual([]);
    lastTerminalNotifyAt = 0;
    enabled = false;
    notifier.update([working(120_000)]);
    notifier.update([session('idle')]);
    advance(5000);
    expect(sent).toEqual([]);
  });

  it('does not say a turn finished when the next one has already begun, or Claude Code was closed', () => {
    notifier.update([working(120_000)]);
    notifier.update([session('idle')]);
    advance(500);
    notifier.update([session('working', { turnStartedAt: now })]); // the next prompt
    advance(10_000);
    expect(sent).toEqual([]);
    notifier.update([session('idle', { turnStartedAt: now - 1000 })]);
    notifier.update([working(120_000)]);
    notifier.update([session('idle')]);
    notifier.update([session('ended')]);
    advance(10_000);
    expect(sent).toEqual([]);
  });

  it('only a turn that ended in idle counts: waiting for you, or going from idle to idle, is not a finish', () => {
    notifier.update([working(120_000)]);
    notifier.update([session('needs-you')]);
    advance(10_000);
    notifier.update([session('idle')]);
    advance(10_000);
    expect(sent).toEqual([]);
    notifier.update([session('idle')]);
    notifier.update([session('idle')]);
    advance(10_000);
    expect(sent).toEqual([]);
  });

  it('a turn that is not known to have begun (no start time) is not announced', () => {
    notifier.update([session('working')]);
    notifier.update([session('idle')]);
    advance(10_000);
    expect(sent).toEqual([]);
  });

  it('keeps sessions apart, and says nothing for one that disappears while waiting', () => {
    notifier.update([working(120_000, { id: 'a' }), working(120_000, { id: 'b' })]);
    notifier.update([session('idle', { id: 'a' }), working(120_000, { id: 'b' })]);
    advance(3000);
    expect(sent).toHaveLength(1);
    notifier.update([session('idle', { id: 'a' }), session('idle', { id: 'b' })]);
    notifier.update([session('idle', { id: 'a' })]); // b is gone
    advance(5000);
    expect(sent).toHaveLength(1);
  });
});

describe('took', () => {
  it('says seconds up to a minute and a half, minutes after', () => {
    expect(took(45_000)).toBe('45s');
    expect(took(89_000)).toBe('89s');
    expect(took(90_000)).toBe('2 min');
    expect(took(4 * 60_000)).toBe('4 min');
    expect(took(0)).toBe('0s');
  });
});
