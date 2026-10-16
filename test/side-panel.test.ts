import { describe, expect, it } from 'vitest';
import { fmtMinutes, nowCardModel, panelWidth, todayTimeline } from '../src/renderer/panel';
import { costFigure } from '../src/renderer/claude-ui';
import type { ClaudeSession } from '../src/core/claude/watcher';

const NOW = 1_000_000_000;
/** A session as the daemon pushes it; `calls` start in `turnStartedAt`'s turn unless they say otherwise. */
const session = (over: Partial<ClaudeSession> = {}): ClaudeSession => ({ id: 's1', state: 'idle', since: NOW, startedAt: NOW - 600_000, turns: 1, calls: [], counts: {}, files: [], subagents: [], ...over });
const call = (name: string, category: string, ago: number) => ({ name, category, startedAt: NOW - ago, endedAt: NOW - ago + 500 }) as ClaudeSession['calls'][number];
const opts = (over: Record<string, unknown> = {}) => ({ now: NOW, cfg: { showCost: true, liveCost: true, dailyBudgetUsd: 0 }, today: null, typicalTurnMs: 0, ...over });

describe('the side panel (pure)', () => {
  it('panelWidth: 300 by default, kept to 220..480, whole pixels, nothing odd from odd input', () => {
    expect(panelWidth(undefined)).toBe(300);
    expect(panelWidth('400')).toBe(300);
    expect(panelWidth(Number.NaN)).toBe(300);
    expect(panelWidth(Infinity)).toBe(300);
    expect(panelWidth(null)).toBe(300);
    expect(panelWidth(320)).toBe(320);
    expect(panelWidth(100)).toBe(220);
    expect(panelWidth(-5)).toBe(220);
    expect(panelWidth(900)).toBe(480);
    expect(panelWidth(301.6)).toBe(302);
  });

  it('panelWidth with the window width: the terminal keeps at least 360 px of the window, never below 220, the kept width untouched otherwise', () => {
    expect(panelWidth(480, 640)).toBe(280);
    expect(panelWidth(300, 640)).toBe(280);
    expect(panelWidth(300, 1360)).toBe(300);
    expect(panelWidth(480, 500)).toBe(220);
    expect(panelWidth(undefined, 600)).toBe(240);
    expect(panelWidth(300, Number.NaN)).toBe(300);
  });

  it('no Claude session: "Claude is not running" with the hint that ⇧⌘C starts it, and nothing else about a turn', () => {
    const m = nowCardModel(null, opts());
    expect(m.state).toBe('off');
    expect(m.label).toBe('Claude is not running');
    expect(m.hint).toContain('⇧⌘C');
    expect([m.tool, m.elapsed, m.cost, m.summary, m.today]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect([m.progress, m.agents, m.counts, m.files, m.moreFiles]).toEqual([null, [], '', [], 0]);
  });

  it('working: the tool in use, the turn’s time, the progress against the typical turn (as the ring), this turn’s counts joined with dots', () => {
    const s = session({
      state: 'working',
      turnStartedAt: NOW - 30_000,
      tool: { name: 'Bash', id: 't1' },
      calls: [call('Read', 'read', 120_000), call('Read', 'read', 20_000), call('Read', 'read', 15_000), call('Edit', 'write', 10_000), call('Bash', 'shell', 2_000)],
    });
    const m = nowCardModel(s, opts({ typicalTurnMs: 60_000 }));
    expect(m.state).toBe('working');
    expect(m.label).toBe('Claude is working');
    expect(m.tool).toBe('Bash');
    expect(m.elapsed).toBe('30s');
    expect(m.progress).toBe(0.5);
    expect(m.counts).toBe('2 reads · 1 edit · 1 shell'); // the call from before the turn began does not count (the stale-turn rule)
    expect(m.summary).toBeUndefined();
    expect(nowCardModel(s, opts({ typicalTurnMs: 0 })).progress).toBeNull(); // no typical turn known yet
    expect(nowCardModel(s, opts({ typicalTurnMs: 10_000 })).progress).toBe(1);
  });

  it('needs you: the tool it asks about and the turn’s time, no progress bar', () => {
    const m = nowCardModel(session({ state: 'needs-you', turnStartedAt: NOW - 75_000, tool: { name: 'Bash', id: 't1' } }), opts({ typicalTurnMs: 60_000 }));
    expect([m.state, m.label, m.tool, m.elapsed, m.progress]).toEqual(['needs-you', 'Claude needs you', 'Bash', '1m 15s', null]);
    expect(m.hint).toMatch(/terminal/);
  });

  it('the cost: the live figure while it works, the last answer’s otherwise; none with showCost off, the last one with liveCost off', () => {
    const live = { input: 1000, output: 500, usd: 0.03, at: NOW };
    const cost = { last: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, messages: 1, usd: 0.42 }, totalUsd: 1, answers: 2, partial: false, at: NOW };
    const working = session({ state: 'working', turnStartedAt: NOW - 1000, live, cost });
    expect(nowCardModel(working, opts()).cost).toEqual({ text: '≈ $0.03 so far', live: true });
    expect(nowCardModel(working, opts({ cfg: { showCost: true, liveCost: false } })).cost).toEqual({ text: '≈ $0.42', live: false });
    expect(nowCardModel(working, opts({ cfg: { showCost: false, liveCost: true } })).cost).toBeUndefined();
    expect(nowCardModel(session({ cost }), opts()).cost).toEqual({ text: '≈ $0.42', live: false });
    expect(nowCardModel(session({ state: 'working', live: { input: 1500, output: 500, at: NOW } }), opts()).cost).toEqual({ text: '2k tokens so far', live: true }); // no price known
    expect(nowCardModel(session(), opts()).cost).toBeUndefined();
  });

  it('costFigure is the title bar chip’s figure too (one rule for both)', () => {
    const cost = { last: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 0, messages: 1 }, totalUsd: 0, answers: 1, partial: true, at: NOW };
    expect(costFigure(session({ cost }), true)).toEqual({ text: '1.5k tokens', live: false });
    expect(costFigure(session({ cost: { last: null } as never }), true)).toBeNull();
  });

  it('today against the daily budget: the chip’s levels and a bar, only with showCost', () => {
    expect(nowCardModel(null, opts({ today: { usd: 4, date: 'x' }, cfg: { showCost: true, dailyBudgetUsd: 5 } })).today).toEqual({ text: 'Today ≈ $4.00 of $5.00', level: 'warn', fraction: 0.8 });
    expect(nowCardModel(null, opts({ today: { usd: 7, date: 'x' }, cfg: { showCost: true, dailyBudgetUsd: 5 } })).today).toEqual({ text: 'Today ≈ $7.00 of $5.00', level: 'danger', fraction: 1 });
    expect(nowCardModel(null, opts({ today: { usd: 1.2, date: 'x' }, cfg: { showCost: true, dailyBudgetUsd: 0 } })).today).toEqual({ text: 'Today ≈ $1.20', level: 'off', fraction: null });
    expect(nowCardModel(null, opts({ today: { usd: 1.2, date: 'x' }, cfg: { showCost: false, dailyBudgetUsd: 5 } })).today).toBeUndefined();
  });

  it('the running agents: numbered, their tool and time, never their ids; finished and odd ones left out', () => {
    const s = session({
      state: 'working',
      turnStartedAt: NOW - 200_000,
      subagents: [
        { id: 'agent-secret-id-1', status: 'running', startedAt: NOW - 130_000, tool: 'Read' },
        { id: 'agent-secret-id-2', status: 'done', startedAt: NOW - 90_000 },
        { id: 'agent-secret-id-3', status: 'running', startedAt: NOW - 5_000 },
        null as never,
      ],
    });
    const m = nowCardModel(s, opts());
    expect(m.agents).toEqual(['Agent 1 · Read · 2m 10s', 'Agent 2 · 5s']);
    expect(JSON.stringify(m)).not.toContain('secret-id');
  });

  it('the files this turn edited: basenames (with the path to reveal), up to 8 and how many more; none for a turn that wrote nothing', () => {
    const files = Array.from({ length: 10 }, (_, i) => `/work/app/src/file${i}.ts`);
    const wrote = session({ state: 'working', turnStartedAt: NOW - 5_000, files, calls: [call('Edit', 'write', 1_000)] });
    const m = nowCardModel(wrote, opts());
    expect(m.files).toHaveLength(8);
    expect(m.files[0]).toEqual({ name: 'file0.ts', path: '/work/app/src/file0.ts' });
    expect(m.moreFiles).toBe(2);
    // a turn without a prompt keeps the last prompt's files: only a turn that wrote lists them
    const stale = session({ state: 'working', turnStartedAt: NOW - 5_000, files, calls: [call('Edit', 'write', 60_000)] });
    expect([nowCardModel(stale, opts()).files, nowCardModel(stale, opts()).moreFiles]).toEqual([[], 0]);
  });

  it('after a turn: the last turn’s summary line (its time, what Claude did, its cost with showCost); none for a cut-short turn', () => {
    const cost = { last: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, messages: 1, usd: 0.04 }, totalUsd: 1, answers: 2, partial: false, at: NOW };
    const done = session({ state: 'idle', since: NOW - 1000, turnStartedAt: NOW - 73_000, cost, calls: [call('Read', 'read', 60_000), call('Edit', 'write', 30_000)] });
    const m = nowCardModel(done, opts());
    expect([m.state, m.label]).toEqual(['idle', 'Claude is idle']);
    expect(m.summary).toBe('Claude finished in 1m 12s · 1 read, 1 edit · ≈ $0.04');
    expect(m.counts).toBe(''); // (the summary says it)
    expect(nowCardModel(done, opts({ cfg: { showCost: false } })).summary).toBe('Claude finished in 1m 12s · 1 read, 1 edit');
    expect(nowCardModel({ ...done, cutShort: true }, opts()).summary).toBeUndefined();
    expect(nowCardModel(session(), opts()).summary).toBeUndefined(); // no turn yet
  });

  it('odd sessions (calls, files and agents that are not lists) show what they can and throw nothing', () => {
    const odd = session({ state: 'working', calls: null as never, files: 'x' as never, subagents: {} as never, turnStartedAt: undefined });
    const m = nowCardModel(odd, opts({ typicalTurnMs: 60_000 }));
    expect([m.state, m.elapsed, m.progress, m.counts, m.files, m.agents]).toEqual(['working', undefined, null, '', [], []]);
  });

  it('turn bars: only with two turns (the last 20), with the cost in their titles only with showCost', () => {
    const turns = [{ id: 's1', durMs: 60_000, usd: 0.04 }, { id: 's1', durMs: 30_000, usd: 0.01 }];
    expect(nowCardModel(session(), opts({ turns: [turns[0]] })).bars).toBeUndefined();
    expect(nowCardModel(session(), opts()).bars).toBeUndefined();
    expect(nowCardModel(session(), opts({ turns })).bars?.bars.map((b) => b.title)).toEqual(['1m 0s · ≈ $0.04', '30s · ≈ $0.01']);
    expect(nowCardModel(session(), opts({ turns, cfg: { showCost: false } })).bars?.bars.map((b) => b.title)).toEqual(['1m 0s', '30s']);
    expect(nowCardModel(null, opts({ turns })).bars?.bars.length).toBe(2); // (the history belongs to the window, not to a session)
  });

  it('time worked today: from the day’s total, plus the running turn while Claude works; nothing for none; not tied to the cost switch', () => {
    const today = { usd: 1, workMs: 4_320_000 };
    expect(nowCardModel(session(), opts({ today })).worked).toBe('Claude worked 1h 12m today');
    expect(nowCardModel(session({ state: 'working', turnStartedAt: NOW - 30_000 }), opts({ today: { usd: 0, workMs: 60_000 } })).worked).toBe('Claude worked 1m 30s today');
    expect(nowCardModel(session({ state: 'needs-you', turnStartedAt: NOW - 30_000 }), opts({ today: { usd: 0, workMs: 60_000 } })).worked).toBe('Claude worked 1m 30s today');
    expect(nowCardModel(session(), opts({ today, cfg: { showCost: false } })).worked).toBe('Claude worked 1h 12m today');
    expect(nowCardModel(null, opts({ today })).worked).toBe('Claude worked 1h 12m today');
    expect(nowCardModel(session(), opts({ today: { usd: 1, workMs: 0 } })).worked).toBeUndefined();
    expect(nowCardModel(session(), opts({ today: { usd: 1 } })).worked).toBeUndefined();
    expect(nowCardModel(session(), opts({ today: null })).worked).toBeUndefined();
    expect(nowCardModel(session({ state: 'working', turnStartedAt: NOW - 400 }), opts({ today: { usd: 0, workMs: 0 } })).worked).toBeUndefined(); // under a second in all
    expect(nowCardModel(session(), opts({ today: { usd: 1, workMs: Number.NaN } })).worked).toBeUndefined();
  });

  it('the context meter (1.4.0): how full the latest response left the window, warn from 80 %, danger from 92 %; the tokens alone for an unknown window; nothing without numbers', () => {
    const ctx = (tokens: number, window?: number) => nowCardModel(session({ context: { tokens, ...(window ? { window } : {}), at: NOW } }), opts()).context;
    expect(ctx(620_000, 1_000_000)).toEqual({ text: 'Context 62% of 1M', level: 'ok', fraction: 0.62 });
    expect(ctx(160_000, 200_000)).toEqual({ text: 'Context 80% of 200k', level: 'warn', fraction: 0.8 });
    expect(ctx(184_000, 200_000)?.level).toBe('danger');
    expect(ctx(250_000, 200_000)).toEqual({ text: 'Context 100% of 200k', level: 'danger', fraction: 1 });
    expect(ctx(124_000)).toEqual({ text: 'Context 124k tokens', level: 'ok', fraction: null });
    expect(ctx(0, 200_000)).toBeUndefined();
    expect(ctx(Number.NaN, 200_000)).toBeUndefined();
    expect(nowCardModel(session(), opts()).context).toBeUndefined();
    expect(nowCardModel(session({ context: 'x' as never }), opts()).context).toBeUndefined();
    expect(nowCardModel(null, opts()).context).toBeUndefined();
  });

  it('the last 5 hours (1.4.0): tokens always, the money only with showCost, and what it is not; nothing for none', () => {
    expect(nowCardModel(null, opts({ usage5h: { tokens: 3_200_000, usd: 4.5 } })).last5h).toBe("Last 5 h ≈ $4.50 · 3.2M tokens (estimate, not your plan's limit)");
    expect(nowCardModel(session(), opts({ usage5h: { tokens: 3_200_000, usd: 4.5 }, cfg: { showCost: false } })).last5h).toBe("Last 5 h · 3.2M tokens (estimate, not your plan's limit)");
    expect(nowCardModel(session(), opts({ usage5h: { tokens: 1200 } })).last5h).toBe("Last 5 h · 1.2k tokens (estimate, not your plan's limit)");
    expect(nowCardModel(session(), opts({ usage5h: { tokens: 0, usd: 0 } })).last5h).toBeUndefined();
    expect(nowCardModel(session(), opts({ usage5h: null })).last5h).toBeUndefined();
    expect(nowCardModel(session(), opts()).last5h).toBeUndefined();
  });

  it('the daily work-time budget (1.4.0): the worked line gets the budget levels (warn from 80 %, danger past it); off for 0', () => {
    const lvl = (workMs: number, min: number) => nowCardModel(session(), opts({ today: { usd: 0, workMs }, cfg: { dailyWorkBudgetMin: min } })).workedLevel;
    expect(lvl(60 * 60_000, 0)).toBe('off');
    expect(lvl(60 * 60_000, 120)).toBe('ok');
    expect(lvl(96 * 60_000, 120)).toBe('warn');
    expect(lvl(120 * 60_000, 120)).toBe('danger');
    expect(fmtMinutes(180)).toBe('3 h');
    expect(fmtMinutes(90)).toBe('1 h 30 min');
    expect(fmtMinutes(45)).toBe('45 min');
  });

  it('today\'s timeline (1.4.0): the turns that ended today, newest first, at most 20: time of day, length, counts, files, cost (with showCost)', () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    const at = (h: number, m: number, day = 16) => new Date(2026, 9, day, h, m).getTime();
    const turns = [
      { id: 's1', durMs: 30_000, usd: 0.5, at: at(23, 50, 15), counts: '1 read', files: 0 }, // yesterday
      { id: 's1', durMs: 72_000, usd: 0.04, at: at(9, 5), counts: '3 reads, 2 edits', files: 2 },
      { id: 's1', durMs: 5_000, at: at(14, 30), counts: '', files: 1 },
      { id: 's1', durMs: 1_000 }, // (no time: not placed)
    ];
    expect(todayTimeline(turns, now, true)).toEqual(['14:30 · 5s · 1 file', '09:05 · 1m 12s · 3 reads, 2 edits · 2 files · ≈ $0.04']);
    expect(todayTimeline(turns, now, false)).toEqual(['14:30 · 5s · 1 file', '09:05 · 1m 12s · 3 reads, 2 edits · 2 files']);
    expect(todayTimeline(Array.from({ length: 30 }, (_, i) => ({ id: 's', durMs: 1000, at: at(10, i) })), now, true)).toHaveLength(20);
    expect(todayTimeline([], now, true)).toEqual([]);
  });
});
