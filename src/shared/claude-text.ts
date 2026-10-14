import type { ToolCall } from '../core/claude/watcher';
import type { GitStatus } from '../core/session/git-status';

/** Pure text helpers about Claude's work, shared by the window and the menu bar item (main). */

/** `4m 12s`, `45s`, `1h 3m`. */
export function fmtDuration(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The calls of the current turn by category. A background-agent turn without a prompt inherits the last prompt's calls: only those since the turn began count. */
export function turnCounts(calls: ToolCall[] | undefined, turnStartedAt: number | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of turnCalls(calls, turnStartedAt)) out[c.category] = (out[c.category] ?? 0) + 1;
  return out;
}

/** The calls of the current turn, odd entries (not a call with a name, a category and a start) left out. */
export function turnCalls(calls: ToolCall[] | undefined, turnStartedAt: number | undefined): ToolCall[] {
  return (Array.isArray(calls) ? calls : []).filter(
    (c) => !!c && typeof c === 'object' && typeof c.name === 'string' && typeof c.category === 'string' && typeof c.startedAt === 'number' && (typeof turnStartedAt !== 'number' || c.startedAt >= turnStartedAt),
  );
}

const WORDS: [string, string, string][] = [
  ['read', 'read', 'reads'],
  ['write', 'edit', 'edits'],
  ['shell', 'shell', 'shells'],
  ['web', 'web', 'web'],
  ['agent', 'agent', 'agents'],
  ['other', 'other', 'other'],
];

/** "3 reads, 2 edits, 1 shell" (kinds with no call left out); '' for none. */
export function countsText(counts: Record<string, number>): string {
  return WORDS.filter(([k]) => counts[k]! > 0)
    .map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`)
    .join(', ');
}

/** `+2 ~3 ?1 ↑1 ↓0` with the zeros left out; '' for no repository. */
export function gitText(git: GitStatus | undefined): string {
  if (!git) return '';
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
  return (
    [
      ['+', git.staged],
      ['~', git.changed],
      ['?', git.untracked],
      ['↑', git.ahead],
      ['↓', git.behind],
    ] as const
  )
    .filter(([, v]) => n(v))
    .map(([s, v]) => s + v)
    .join(' ');
}
