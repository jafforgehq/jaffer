import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSession } from '../src/core/claude/watcher';
import { TrayIconPlayer, trayMenuLines, trayState, trayTitle, type TrayFrame } from '../src/shared/tray-state';

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime();
const TODAY = '2026-10-14';
let n = 0;
const sess = (p: Partial<ClaudeSession> = {}): ClaudeSession => ({ id: `s${n++}`, state: 'idle', since: NOW, startedAt: NOW - 3_600_000, turns: 1, calls: [], counts: {}, files: [], subagents: [], ...p });
const cost = (totalUsd: number) => ({ last: {} as never, totalUsd, answers: 3, partial: false, at: NOW });

describe('trayState: the menu bar icon', () => {
  it('needs-you wins, then working, else idle; ended sessions and odd entries count for nothing', () => {
    expect(trayState([])).toBe('idle');
    expect(trayState([sess()])).toBe('idle');
    expect(trayState([sess({ state: 'working' })])).toBe('working');
    expect(trayState([sess({ state: 'working' }), sess({ state: 'needs-you' })])).toBe('alert');
    expect(trayState([sess({ state: 'needs-you' }), sess({ state: 'working' })])).toBe('alert');
    expect(trayState([sess({ state: 'ended' }), sess({ state: 'idle' })])).toBe('idle');
    expect(trayState([null, 7, { state: 'working' }] as never)).toBe('working');
    expect(trayState(undefined as never)).toBe('idle');
  });
});

describe('trayTitle: the text beside the icon', () => {
  const sessions = [sess({ state: 'working', turnStartedAt: NOW - 4 * 60_000 - 10_000, cost: cost(1.2) })];
  const today = { usd: 3.456, date: TODAY };

  it('off is nothing; cost, time and today say theirs', () => {
    expect(trayTitle('off', { sessions, today, now: NOW, showCost: true })).toBe('');
    expect(trayTitle('cost', { sessions, today, now: NOW, showCost: true })).toBe('≈ $1.20');
    expect(trayTitle('time', { sessions, today, now: NOW, showCost: true })).toBe('4m');
    expect(trayTitle('today', { sessions, today, now: NOW, showCost: true })).toBe('≈ $3.46');
  });

  it('the running turn: seconds, minutes, hours; also while Claude waits for you; nothing when no turn runs', () => {
    const at = (ms: number, state: ClaudeSession['state'] = 'working') => trayTitle('time', { sessions: [sess({ state, turnStartedAt: NOW - ms })], now: NOW, showCost: false });
    expect(at(45_000)).toBe('45s');
    expect(at(3_723_000)).toBe('1h 2m');
    expect(at(90_000, 'needs-you')).toBe('1m');
    expect(at(90_000, 'idle')).toBe('');
    expect(trayTitle('time', { sessions: [sess({ state: 'working' })], now: NOW, showCost: false })).toBe('');
  });

  it('cost needs the cost switch and a figure: without either it is nothing', () => {
    expect(trayTitle('cost', { sessions, today, now: NOW, showCost: false })).toBe('');
    expect(trayTitle('today', { sessions, today, now: NOW, showCost: false })).toBe('');
    expect(trayTitle('cost', { sessions: [sess()], today, now: NOW, showCost: true })).toBe('');
    expect(trayTitle('cost', { sessions: [], now: NOW, showCost: true })).toBe('');
    expect(trayTitle('today', { sessions, now: NOW, showCost: true })).toBe('');
    expect(trayTitle('today', { sessions, today: { usd: 'x', date: TODAY } as never, now: NOW, showCost: true })).toBe('');
    expect(trayTitle('cost', { sessions: [sess({ cost: { totalUsd: Number.NaN } as never })], now: NOW, showCost: true })).toBe('');
  });

  it('yesterday’s total is not today’s; an unknown mode is nothing', () => {
    expect(trayTitle('today', { sessions, today: { usd: 9, date: '2026-10-13' }, now: NOW, showCost: true })).toBe('≈ $0.00');
    expect(trayTitle('loud' as never, { sessions, today, now: NOW, showCost: true })).toBe('');
  });
});

describe('trayMenuLines: the status lines at the top of the menu', () => {
  it('idle, working (the tool and how long), needs you (the tool and its notice, clipped to 60)', () => {
    expect(trayMenuLines([], NOW, { alt: false })).toEqual(['Idle']);
    expect(trayMenuLines([sess()], NOW, { alt: false })).toEqual(['Idle']);
    expect(trayMenuLines([sess({ state: 'working', tool: { name: 'Bash', id: 't1' }, turnStartedAt: NOW - 72_000 })], NOW, { alt: false })).toEqual(['Working · Bash · 1m 12s']);
    expect(trayMenuLines([sess({ state: 'working' })], NOW, { alt: false })).toEqual(['Working']);
    const notice = `Claude needs your permission to use Bash ${'x'.repeat(80)}`;
    const lines = trayMenuLines([sess({ state: 'working' }), sess({ state: 'needs-you', tool: { name: 'Bash', id: 't2' }, notice })], NOW, { alt: false });
    expect(lines[0]).toBe('Needs you: Bash');
    expect(lines[1]).toHaveLength(60);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect(trayMenuLines([sess({ state: 'needs-you' })], NOW, { alt: false })).toEqual(['Needs you']);
  });

  it('a label is one line: no line breaks or control characters from a tool name or notice', () => {
    const lines = trayMenuLines([sess({ state: 'needs-you', tool: { name: 'Ba\nsh', id: 't' }, notice: 'line one\nline\ttwo\u0007' })], NOW, { alt: false });
    expect(lines).toEqual(['Needs you: Ba sh', 'line one line two']);
  });

  it('with ⌥: the cost so far (only with the cost switch), this turn’s tool counts and the git counts', () => {
    const s = sess({
      state: 'working',
      tool: { name: 'Edit', id: 'e' },
      turnStartedAt: NOW - 30_000,
      live: { input: 10, output: 5, usd: 0.031, at: NOW },
      calls: [
        { name: 'Read', category: 'read', startedAt: NOW - 20_000 },
        { name: 'Read', category: 'read', startedAt: NOW - 19_000 },
        { name: 'Read', category: 'read', startedAt: NOW - 18_000 },
        { name: 'Edit', category: 'write', startedAt: NOW - 10_000 },
        { name: 'Edit', category: 'write', startedAt: NOW - 9_000 },
        { name: 'Old', category: 'read', startedAt: NOW - 60_000 },
        null as never,
      ],
    });
    const git = { staged: 2, changed: 3, untracked: 0, ahead: 1, behind: 0 };
    expect(trayMenuLines([s], NOW, { alt: false, showCost: true, git })).toEqual(['Working · Edit · 30s']);
    expect(trayMenuLines([s], NOW, { alt: true, showCost: true, git })).toEqual(['Working · Edit · 30s', 'so far ≈ $0.03', '3 reads, 2 edits', 'git +2 ~3 ↑1']);
    expect(trayMenuLines([s], NOW, { alt: true, showCost: false, git })).toEqual(['Working · Edit · 30s', '3 reads, 2 edits', 'git +2 ~3 ↑1']);
    // nothing to add: no extra lines (no repository, no calls, no live figure)
    expect(trayMenuLines([sess()], NOW, { alt: true, showCost: true })).toEqual(['Idle']);
    expect(trayMenuLines([], NOW, { alt: true, showCost: true, git: { staged: 0, changed: 0, untracked: 0, ahead: 0, behind: 0 } })).toEqual(['Idle']);
    expect(trayMenuLines([sess({ live: { usd: 'x' } as never, calls: 'nope' as never })], NOW, { alt: true, showCost: true })).toEqual(['Idle']);
  });
});

describe('TrayIconPlayer: frames, the working animation and the alert flash', () => {
  let shown: TrayFrame[];
  let player: TrayIconPlayer;
  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    player = new TrayIconPlayer({ show: (f) => shown.push(f), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout) });
  });
  afterEach(() => {
    player.destroy();
    vi.useRealTimers();
  });

  it('idle shows the idle frame and keeps no timer; the same state again changes nothing', () => {
    player.set('idle');
    player.set('idle');
    expect(shown).toEqual(['idle']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('working alternates two frames every 500 ms, with one timer, gone when the work stops', () => {
    player.set('working');
    vi.advanceTimersByTime(1_600);
    expect(shown).toEqual(['work-a', 'work-b', 'work-a', 'work-b']);
    expect(vi.getTimerCount()).toBe(1);
    player.set('working'); // a state push while working does not restart it
    expect(vi.getTimerCount()).toBe(1);
    player.set('idle');
    expect(shown.at(-1)).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new needs-you flashes the alert three times at 400 ms, then stays on the alert icon with no timer left', () => {
    player.set('working');
    shown.length = 0;
    player.set('alert');
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual(['alert', 'idle', 'alert', 'idle', 'alert', 'idle', 'alert']);
    expect(vi.getTimerCount()).toBe(0);
    player.set('alert'); // the same needs-you pushed again: no new flash
    expect(shown).toHaveLength(7);
  });

  it('a flash cut short by the next state leaves no timer; destroy stops everything', () => {
    player.set('alert');
    vi.advanceTimersByTime(500);
    player.set('working');
    expect(vi.getTimerCount()).toBe(1);
    player.destroy();
    expect(vi.getTimerCount()).toBe(0);
    const before = shown.length;
    vi.advanceTimersByTime(5_000);
    expect(shown).toHaveLength(before);
  });
});
