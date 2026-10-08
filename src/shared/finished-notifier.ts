import type { ClaudeSession } from '../core/claude/watcher';
import { formatUsd } from './claude-cost';
import { took } from './notify-policy';

/** A turn this long is worth a notification when it ends while Jaffer is in the background; a quick answer is not. */
export const FINISHED_MIN_MS = 30_000;
/** What an answer cost is read from the transcript a moment after the turn ends: wait that long for it, then notify anyway. */
export const COST_WAIT_MS = 2_500;
/** Claude Code's own terminal notification and ours must not both fire for one event. */
const TERMINAL_NOTIFY_WINDOW_MS = 10_000;

export interface FinishedDeps {
  enabled(): boolean;
  showCost(): boolean;
  windowFocused(): boolean;
  lastTerminalNotifyAt(): number;
  now(): number;
  notify(n: { title: string; body: string }): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

interface Pending {
  durMs: number;
  answersBefore: number;
  timer: unknown;
}

/**
 * "Claude finished": a session went from working to idle after a long turn. Fed every `claude.state` snapshot. It waits a moment for
 * the cost of the answer (so the notification can say it), and says nothing if you came back in the meantime, started the next
 * turn, or Claude Code already told you itself.
 */
export class FinishedNotifier {
  private prev: ClaudeSession[] = [];
  private pending = new Map<string, Pending>();

  constructor(private d: FinishedDeps) {}

  update(next: ClaudeSession[]): void {
    const now = this.d.now();
    const before = new Map(this.prev.map((s) => [s.id, s]));
    this.prev = next;
    for (const s of next) {
      const p = this.pending.get(s.id);
      if (p) {
        if (s.state !== 'idle') this.cancel(s.id); // the next turn began, or Claude was closed: that finish is history
        else if ((s.cost?.answers ?? 0) > p.answersBefore) this.fire(s.id); // the cost arrived: say it now
        continue;
      }
      const was = before.get(s.id);
      if (was?.state === 'working' && s.state === 'idle' && was.turnStartedAt !== undefined && now - was.turnStartedAt >= FINISHED_MIN_MS && this.d.enabled()) {
        this.pending.set(s.id, { durMs: now - was.turnStartedAt, answersBefore: was.cost?.answers ?? 0, timer: this.d.setTimer(() => this.fire(s.id), COST_WAIT_MS) });
      }
    }
    for (const id of [...this.pending.keys()]) if (!next.some((s) => s.id === id)) this.cancel(id);
  }

  private cancel(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.d.clearTimer(p.timer);
    this.pending.delete(id);
  }

  private fire(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.cancel(id);
    if (!this.d.enabled() || this.d.windowFocused() || this.d.now() - this.d.lastTerminalNotifyAt() < TERMINAL_NOTIFY_WINDOW_MS) return;
    const cost = this.prev.find((s) => s.id === id)?.cost;
    const usd = this.d.showCost() && cost && cost.answers > p.answersBefore ? cost.last.usd : undefined;
    this.d.notify({ title: 'Claude finished', body: `${took(p.durMs)}${usd !== undefined ? ` · ≈ ${formatUsd(usd)}` : ''}` });
  }
}
