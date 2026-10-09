/** What Jaffer may type to take a Claude Code conversation back up. The id is typed into a shell, so it is checked before it is kept and again before it is typed. */
export function isSessionId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(s);
}

export function resumeCommand(id: string): string {
  return `claude --resume ${id}`;
}

/** `claude` subcommands (and flags) that only ask or manage: running one is not a conversation, and its ending is not the end of one. */
const ASKS = new Set(['mcp', 'update', 'upgrade', 'doctor', 'config', 'install', 'setup-token', 'auth', 'plugin', 'plugins', 'agents', 'migrate-installer']);
const ASK_FLAGS = new Set(['--version', '-v', '--help', '-h']);

/** A command line that runs `claude` (after variables, `command` or a path), and what follows it. */
const CLAUDE_LINE = /^\s*(?:\w+=\S*\s+)*(?:command\s+)?(?:\S*\/)?claude(?:\s+([\s\S]*))?$/;

/**
 * When a command line that runs `claude` (see `isClaudeCommand`) finishes, did a conversation end? Not for `claude --version` or
 * `claude mcp list`: after a reboot they must not drop the conversation that is waiting to be resumed.
 */
export function endsConversation(cmd: string): boolean {
  const m = CLAUDE_LINE.exec(cmd);
  const args = (m?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  if (args.some((a) => ASK_FLAGS.has(a))) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return first === undefined || !ASKS.has(first);
}

/**
 * How much of a command line is read. The line comes from the terminal (the shell's marks, which any output can forge), so it can be
 * any length; the options that matter are at its start.
 */
export const COMMAND_HEAD = 4096;

/**
 * The words of a command line as the shell splits them: single quotes, double quotes (with backslash escapes inside) and a backslash
 * outside quotes, all removed from the words. One pass over the text, so a crafted line cannot make it slow.
 */
function shellWords(line: string): string[] {
  const out: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < line.length) word += line[++i];
      else word += ch;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inWord) out.push(word);
      word = '';
      inWord = false;
    } else {
      inWord = true;
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '\\' && i + 1 < line.length) word += line[++i];
      else word += ch;
    }
  }
  if (inWord) out.push(word);
  return out;
}

/**
 * `claude -p` (`--print`, or `-p` clustered with `-c`, the other switch, as in `-cp`) answers once and exits: it is never a conversation
 * to come back to, however it ended. A `-p` inside a quoted prompt is a word of the prompt, not an option. Reads at most `COMMAND_HEAD`.
 */
export function isPrintMode(cmd: string): boolean {
  const m = CLAUDE_LINE.exec(cmd.slice(0, COMMAND_HEAD));
  if (!m) return false;
  return shellWords(m[1] ?? '').some((w) => w === '--print' || (/^-[cp]+$/.test(w) && w.includes('p')));
}

/** What the daemon tells the window: Claude Code was running here when Jaffer last stopped, and can be resumed. */
export interface ResumeOffer {
  id: string;
  cwd: string;
  /** When it was last seen working (ms since epoch). */
  at: number;
}
