import type { ClaudeState } from '../core/claude/watcher';

export interface ProcessBadge {
  kind: 'none' | 'claude' | 'command';
  /** The indicator may move: the thing is actually working. */
  spin: boolean;
}

/** Is this command line Claude Code itself (`claude`, `FOO=1 claude -c`, `command claude`, `/usr/local/bin/claude`), and not just a line that mentions claude? */
export function isClaudeCommand(cmd: string): boolean {
  return /^\s*(?:\w+=\S*\s+)*(?:command\s+)?(?:\S*\/)?claude(?:\s|$)/.test(cmd);
}

/**
 * What the title bar says about the program running in the terminal. An ordinary command is working until it
 * ends, so it spins. Claude Code is a program you sit in all day: it spins only while its hooks say it is working, never just
 * because the process is alive (a spinner that never stops says nothing).
 */
export function processBadge(running: string | null, claude: ClaudeState | undefined): ProcessBadge {
  if (!running) return { kind: 'none', spin: false };
  if (isClaudeCommand(running)) return { kind: 'claude', spin: claude === 'working' };
  return { kind: 'command', spin: true };
}
