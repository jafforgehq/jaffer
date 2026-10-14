import type { ClaudeSession, ClaudeState } from '../core/claude/watcher';
import type { ProcessBadge } from './process-badge';
import { toolCategory, type ToolCategory } from './tool-category';

export type PetMood = 'sleep' | 'rest' | 'dig' | 'alert' | 'cheer';

/**
 * What the little mole in the corner of the terminal is doing. It digs while anything is working (a command that runs, or Claude with a
 * turn in progress), sits up and waves when Claude needs the person, cheers for a moment when a turn ends, rests while Claude
 * Code is open and idle, and sleeps otherwise.
 */
export function petMood(o: { badge: ProcessBadge; claude: ClaudeState | undefined; cheering: boolean }): PetMood {
  if (o.claude === 'needs-you') return 'alert';
  if (o.cheering) return 'cheer';
  if (o.claude === 'working' || o.badge.spin) return 'dig';
  if (o.badge.kind === 'claude' || o.claude === 'idle') return 'rest';
  return 'sleep';
}

/** What kind of work Claude is doing right now (the companion's prop and a scene's colour): none unless it is working with a tool call open. */
export function petTool(session: Pick<ClaudeSession, 'state' | 'tool'> | null | undefined): ToolCategory | null {
  return session?.state === 'working' && session.tool ? toolCategory(session.tool.name) : null;
}

/** The companion dozes after this long without Claude working, a command or a prompt. */
export const DOZE_AFTER_MS = 600_000;

/** Whether the companion dozes: `lastActivityAt` is long enough ago. A clock that ran backwards, or nonsense, never dozes. */
export function isDozing(lastActivityAt: number, now: number, afterMs = DOZE_AFTER_MS): boolean {
  return now - lastActivityAt >= afterMs;
}
