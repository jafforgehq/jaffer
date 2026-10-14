import type { ClaudeState } from '../core/claude/watcher';

/**
 * How much of a command line is read. The line comes from the terminal (the shell's marks, which any output can forge), so it can be
 * any length; the options that matter are at its start. Every helper that reads a command line (`isClaudeCommand`,
 * `isInteractiveCommand`) cuts its input to this head itself, whoever calls it.
 */
export const COMMAND_HEAD = 4096;

export interface ProcessBadge {
  kind: 'none' | 'claude' | 'command';
  /** The indicator may move: the thing is actually working. */
  spin: boolean;
}

/** The `cd '<folder>' && ` a click on a past conversation types before `claude --resume` (1.1.1): single quotes, a quote written `'\''`, no backslash otherwise. */
const RESUME_CD = /^cd '(?:[^'\\]|'\\'')*' && /;

/**
 * Is this command line Claude Code itself (`claude`, `FOO=1 claude -c`, `command claude`, `/usr/local/bin/claude`, and after exactly the
 * `cd '<folder>' && ` a resume types), and not just a line that mentions claude? The line can come from the terminal's forgeable marks at
 * any length (the window reads it too), so only its head is read: `COMMAND_HEAD` characters after that cd, and the cd itself within
 * `5 * COMMAND_HEAD` (a folder of 4096 characters, each a quote written in four).
 */
export function isClaudeCommand(cmd: string): boolean {
  const cd = RESUME_CD.exec(cmd.slice(0, 5 * COMMAND_HEAD));
  return /^\s*(?:\w+=\S*\s+)*(?:command\s+)?(?:\S*\/)?claude(?:\s|$)/.test(cmd.slice(cd ? cd[0].length : 0).slice(0, COMMAND_HEAD));
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
