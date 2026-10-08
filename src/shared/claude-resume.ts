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

/**
 * When a command line that runs `claude` (see `isClaudeCommand`) finishes, did a conversation end? Not for `claude --version` or
 * `claude mcp list`: after a reboot they must not drop the conversation that is waiting to be resumed.
 */
export function endsConversation(cmd: string): boolean {
  const m = /^\s*(?:\w+=\S*\s+)*(?:command\s+)?(?:\S*\/)?claude(?:\s+([\s\S]*))?$/.exec(cmd);
  const args = (m?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  if (args.some((a) => ASK_FLAGS.has(a))) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return first === undefined || !ASKS.has(first);
}

/** What the daemon tells the window: Claude Code was running here when Jaffer last stopped, and can be resumed. */
export interface ResumeOffer {
  id: string;
  cwd: string;
  /** When it was last seen working (ms since epoch). */
  at: number;
}
