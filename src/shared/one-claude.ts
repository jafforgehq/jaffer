/**
 * One Claude: the terminal has one shell, and Claude Code can still be started twice in it (a second `claude` in a subshell, one
 * left open while another begins). Jaffer ends neither; it says so once, so the person knows which one comes back after a restart.
 */

/** What the window tells the person when a second conversation is running. */
export const TWO_RUNNING_NOTICE = 'Two Claude conversations are running. After a restart Jaffer resumes the most recently active conversation.';

/**
 * When two or more Claude conversations are active (idle, working or waiting for the person; an ended one does not count, and
 * a background agent is not a conversation, so only the sessions are looked at), the key of that set of conversations: their
 * ids, sorted, joined by `+`. `null` when fewer than two run, or when that very set was told already (it is in `told`). Pure:
 * the caller adds the key to `told` once it has shown the notice, which is how a set is told once and never again.
 */
export function twoRunning(sessions: { id: string; state: string }[], told: Set<string>): string | null {
  const active = [...new Set(sessions.filter((s) => s.state !== 'ended').map((s) => s.id))];
  if (active.length < 2) return null;
  const key = active.sort().join('+');
  return told.has(key) ? null : key;
}

/** How long a second conversation must still be running before the window says so (see `TwoRunningNotice`). */
export const TWO_RUNNING_DELAY_MS = 1_500;

/**
 * Says it (`twoRunning`) only for a set of conversations that is still running a moment later. `/clear` ends one conversation and starts
 * another, and the new one's SessionStart (a hook process of its own) can reach the daemon before the old one's SessionEnd: for a moment
 * that looks like two. Each new list of sessions goes to `update`; a set that still holds when the delay is over is told (`tell`, once
 * per set while this lives), and the wait ends early when the set goes away or changes (a changed set waits again, as itself).
 */
export class TwoRunningNotice {
  private readonly told = new Set<string>();
  private sessions: { id: string; state: string }[] = [];
  private pending: { key: string; timer: unknown } | null = null;

  constructor(private readonly d: { tell(key: string): void; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }) {}

  update(sessions: { id: string; state: string }[]): void {
    this.sessions = sessions;
    const key = twoRunning(sessions, this.told);
    if (this.pending && this.pending.key !== key) {
      this.d.clearTimer(this.pending.timer);
      this.pending = null;
    }
    if (key === null || this.pending) return;
    const timer = this.d.setTimer(() => {
      if (this.pending?.timer !== timer) return;
      this.pending = null;
      if (twoRunning(this.sessions, this.told) !== key) return; // (looked at again: what runs now)
      this.told.add(key);
      this.d.tell(key);
    }, TWO_RUNNING_DELAY_MS);
    this.pending = { key, timer };
  }
}
