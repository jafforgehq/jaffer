import type { ClaudeSession } from '../core/claude/watcher';
import type { GitStatus } from '../core/session/git-status';
import { dayTotal, formatUsd, type DayTotal } from './claude-cost';
import { countsText, fmtDuration, gitText, turnCounts } from './claude-text';

/**
 * The menu bar item (main process): which icon it shows, the text beside it and the status lines at the top of its menu, all from the
 * daemon's `claude.state` (already redacted there). Pure, so it is tested; the Tray itself is in main.
 */

export type TrayState = 'idle' | 'working' | 'alert';
export type MenuBarTitle = 'off' | 'cost' | 'time' | 'today';

/** The sessions that have not ended (odd entries left out), in the daemon's order (newest change first). */
function live(sessions: ClaudeSession[]): ClaudeSession[] {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => !!s && typeof s === 'object' && s.state !== 'ended');
}

/** The session the menu bar speaks of: one that needs you, else one that works, else the most recent. */
function focusSession(sessions: ClaudeSession[]): ClaudeSession | undefined {
  const l = live(sessions);
  return l.find((s) => s.state === 'needs-you') ?? l.find((s) => s.state === 'working') ?? l[0];
}

/** The icon: a session that needs you wins, then one that works. */
export function trayState(sessions: ClaudeSession[]): TrayState {
  const s = focusSession(sessions);
  return s?.state === 'needs-you' ? 'alert' : s?.state === 'working' ? 'working' : 'idle';
}

/** `45s`, `4m`, `1h 2m`: short enough for the menu bar. */
function compactDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const usdText = (usd: unknown): string => (typeof usd === 'number' && Number.isFinite(usd) ? `≈ ${formatUsd(usd)}` : '');

/** The text beside the icon (`window.menuBarTitle`); '' for off, for nothing to say, and for a cost without `claude.showCost`. */
export function trayTitle(mode: MenuBarTitle, o: { sessions: ClaudeSession[]; today?: DayTotal | null; now: number; showCost: boolean }): string {
  const s = focusSession(o.sessions);
  if (mode === 'time') {
    const t = s?.turnStartedAt;
    return (s?.state === 'working' || s?.state === 'needs-you') && typeof t === 'number' ? compactDuration(o.now - t) : '';
  }
  if (!o.showCost) return '';
  if (mode === 'cost') return usdText(s?.cost?.totalUsd);
  if (mode === 'today') return typeof o.today?.usd === 'number' ? usdText(dayTotal(o.today, o.now).usd) : ''; // (yesterday's total is not today's)
  return '';
}

/** A menu label: one line (no line breaks or control characters), at most `max` characters. */
export function clipLabel(text: string, max = 60): string {
  const one = String(text).slice(0, 4 * max).replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The status lines at the top of the menu: "Idle", "Working · Bash · 1m 12s", or "Needs you: Bash" and Claude Code's notice. With ⌥
 * held when the menu opens, more: the cost so far (only with `showCost`), this turn's tool calls and the repository's counts.
 */
export function trayMenuLines(sessions: ClaudeSession[], now: number, opt: { alt: boolean; showCost?: boolean; git?: GitStatus }): string[] {
  const s = focusSession(sessions);
  const lines: string[] = [];
  const tool = typeof s?.tool?.name === 'string' ? s.tool.name : '';
  if (s?.state === 'needs-you') {
    lines.push(clipLabel(tool ? `Needs you: ${tool}` : 'Needs you'));
    if (typeof s.notice === 'string' && s.notice.trim()) lines.push(clipLabel(s.notice));
  } else if (s?.state === 'working') {
    const t = s.turnStartedAt;
    lines.push(clipLabel(['Working', tool, typeof t === 'number' ? fmtDuration(now - t) : ''].filter(Boolean).join(' · ')));
  } else lines.push('Idle');
  if (!opt.alt) return lines;
  if (opt.showCost && typeof s?.live?.usd === 'number') lines.push(`so far ${usdText(s.live.usd)}`);
  const did = s ? countsText(turnCounts(s.calls, s.turnStartedAt)) : '';
  if (did) lines.push(did);
  const git = gitText(opt.git);
  if (git) lines.push(`git ${git}`);
  return lines;
}

export type TrayFrame = 'idle' | 'work-a' | 'work-b' | 'alert';

/**
 * Plays the icon's frames: idle and alert stand still, working alternates two frames every 500 ms, and a new needs-you flashes the
 * alert icon three times (400 ms) before it stays. One timer at most, and none while nothing moves; `destroy` stops it.
 */
export class TrayIconPlayer {
  private state: TrayState | null = null;
  private timer: unknown = null;

  constructor(private o: { show: (f: TrayFrame) => void; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void }) {}

  set(state: TrayState): void {
    if (state === this.state) return; // (the same state pushed again: a working animation goes on, a flash is not repeated)
    this.state = state;
    this.stop();
    if (state === 'working') this.play(['work-a', 'work-b'], 500, true);
    else if (state === 'alert') this.play(['alert', 'idle', 'alert', 'idle', 'alert', 'idle', 'alert'], 400, false);
    else this.o.show('idle');
  }

  destroy(): void {
    this.stop();
    this.state = null;
  }

  private stop(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
  }

  private play(frames: TrayFrame[], ms: number, loop: boolean): void {
    let i = 0;
    const step = () => {
      this.o.show(frames[i]!);
      i = loop ? (i + 1) % frames.length : i + 1;
      this.timer = i < frames.length ? this.o.setTimer(step, ms) : null;
    };
    step();
  }
}
