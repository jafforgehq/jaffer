import { isSensitiveCommand, redactText } from './redact';
import { COMMAND_HEAD, isClaudeCommand } from './process-badge';
import { resumeCommand } from './history-label';
import { clipLabel } from './tray-state';

/** `'…'` for the shell: nothing inside is expanded; a `'` is written `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

type Where = { cwd?: string; busy?: string | null };
type Past = { id: string; cwd?: string };

/** A folder that may go on a command line: absolute, at most 4096 characters, no control character (no newline can end the line early). */
const okFolder = (p: unknown): p is string => typeof p === 'string' && p.length <= 4096 && /^\/[^\u0000-\u001f\u007f-\u009f]*$/.test(p);

/** The command that resumes a conversation from the terminal's folder: `claude --resume <id>`, with `cd '<folder>' && ` first when the folder differs; null for a bad id. */
export function resumeLine(info: Where, c: Past): string | null {
  const cmd = resumeCommand(c.id);
  if (!cmd) return null;
  return okFolder(c.cwd) && c.cwd !== info.cwd ? `cd ${shellQuote(c.cwd)} && ${cmd}` : cmd;
}

/**
 * What a click on a past conversation does (1.1.1). At an idle prompt (the shell's marks say nothing runs) it types Ctrl-U (a
 * half-typed line goes), the resume line and Enter. While any command runs, Claude included, or when the folder is not known,
 * nothing is typed: the command is copied and `why` says so. A bad id gives nothing at all.
 */
export function resumeAction(info: Where, c: Past): { kind: 'type'; text: string } | { kind: 'copy'; text: string; why: string } | { kind: 'none'; why: string } {
  const line = resumeLine(info, c);
  if (!line) return { kind: 'none', why: 'That conversation has no valid id.' };
  const busy = typeof info.busy === 'string' ? info.busy.slice(0, 4 * COMMAND_HEAD) : ''; // (a command line is forgeable at any length)
  if (busy && isClaudeCommand(busy)) return { kind: 'copy', text: line, why: 'Claude is already running here: quit it first (/exit)' };
  if (busy) return { kind: 'copy', text: line, why: `${isSensitiveCommand(busy) ? 'A command' : clipLabel(redactText(busy), 40)} is running: command copied` };
  if (!okFolder(c.cwd)) return { kind: 'copy', text: line, why: 'Folder unknown: command copied' };
  return { kind: 'type', text: `\x15${line}\r` };
}
