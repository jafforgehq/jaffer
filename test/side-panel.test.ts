import { describe, expect, it } from 'vitest';
import { nowCardModel, panelWidth } from '../src/renderer/panel';
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
});
