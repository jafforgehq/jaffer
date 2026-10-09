/**
 * One Claude: the terminal has one shell, and Claude Code can still be started twice in it (a second `claude` in a subshell, one
 * left open while another begins). Jaffer ends neither; it says so once, so the person knows which one comes back after a restart.
 */

/** What the window tells the person when a second conversation is running. */
export const TWO_RUNNING_NOTICE = 'Two Claude conversations are running. After a restart Jaffer resumes the newest.';

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
