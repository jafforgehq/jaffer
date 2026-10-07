import type { ClaudeState } from '../core/claude/watcher';
import type { ProcessBadge } from './process-badge';

export type PetMood = 'sleep' | 'rest' | 'dig' | 'alert' | 'cheer';

/**
 * What the little mole in the sidebar is doing. It digs while anything is working (a command that runs, or Claude with a
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
