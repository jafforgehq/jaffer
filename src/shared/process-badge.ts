import type { ClaudeState } from '../core/claude/watcher';

export interface ProcessBadge {
  kind: 'none' | 'claude' | 'command';
  /** The indicator may move: the thing is actually working. */
  spin: boolean;
}

/**
 * What the toolbar and the sidebar say about the program running in the terminal. An ordinary command is working until it
 * ends, so it spins. Claude Code is a program you sit in all day: it spins only while its hooks say it is working, never just
 * because the process is alive (a spinner that never stops says nothing).
 */
export function processBadge(running: string | null, claude: ClaudeState | undefined): ProcessBadge {
  if (!running) return { kind: 'none', spin: false };
  if (/\bclaude\b/.test(running)) return { kind: 'claude', spin: claude === 'working' };
  return { kind: 'command', spin: true };
}
