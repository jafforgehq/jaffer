import { COMMAND_HEAD } from '../../shared/claude-resume';
import { STAY_AWAKE } from '../../shared/keep-running';

/**
 * Keeping the Mac from idle sleep while something works: Claude working or running a background agent, or a plain command that has
 * run for a while. This is only the decision: the work comes in through `update`, a hold goes on or off. The process that does the
 * holding (`caffeinate -i -w <daemon pid>`), the clock and the timers are injected, so it is tested without waiting or holding anything.
 */

/** Programs a person sits in: they run for hours without anything working, so they do not count as a command that works. `claude` is covered by its own state. */
const INTERACTIVE = new Set(['ssh', 'mosh', 'vim', 'nvim', 'vi', 'less', 'man', 'top', 'htop', 'tmux', 'screen', 'watch', 'claude']);
/** Words that run another program (`sudo vim`, `env FOO=1 ssh`): skipped, with their options, to find the program. */
const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nice', 'nohup', 'exec', 'builtin']);

const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isEnvAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** The words of each simple command in the line: split at `|`, `&`, `;` and newlines (a doubled one only gives an empty command). */
function simpleCommands(head: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let start = -1;
  const endWord = (at: number) => {
    if (start >= 0) words.push(head.slice(start, at));
    start = -1;
  };
  const endCommand = () => {
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < head.length; i++) {
    const ch = head[i]!;
    if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
      endWord(i);
      endCommand();
    } else if (isSpace(ch)) endWord(i);
    else if (start < 0) start = i;
  }
  endWord(head.length);
  endCommand();
  return out;
}

/** `tail -f`, `-F`, `-fn 20`, `--follow`, `--follow=name`: it waits for more, so it is a person watching, not work. */
function followsTail(args: string[]): boolean {
  for (const a of args) {
    if (a === '--follow' || a.startsWith('--follow=')) return true;
    if (/^-[A-Za-z0-9]+$/.test(a) && (a.includes('f') || a.includes('F'))) return true;
  }
  return false;
}

function interactiveWords(words: string[]): boolean {
  let i = 0;
  // variables and wrappers (and the options of a wrapper) come before the program
  while (i < words.length && (isEnvAssignment(words[i]!) || WRAPPERS.has(words[i]!) || words[i]!.startsWith('-'))) i++;
  const first = words[i];
  if (first === undefined) return false;
  const name = first.slice(first.lastIndexOf('/') + 1);
  if (INTERACTIVE.has(name)) return true;
  return name === 'tail' && followsTail(words.slice(i + 1));
}

/**
 * Is this command line a program a person sits in (`ssh`, `vim`, `less`, `man`, `top`, `tmux`, `watch`, `tail -f`, ...), so that its running
 * a long time is no sign that anything works? Any command of the line counts (`cd src && vim x`, `git log | less`). The line comes from
 * the terminal, which can say anything at any length: only its first `COMMAND_HEAD` characters are read, in one pass, with no pattern
 * that can run away.
 */
export function isInteractiveCommand(cmd: string): boolean {
  for (const words of simpleCommands(cmd.slice(0, COMMAND_HEAD))) if (interactiveWords(words)) return true;
  return false;
}

export interface StayAwakeDeps {
  /** `darwin` is the only platform that holds. */
  platform: string;
  /** The daemon's pid: the hold ends by itself if the daemon dies (`caffeinate -w`). */
  pid: number;
  /** Starts a hold with these arguments for `/usr/bin/caffeinate`; the result lets it go. May throw. */
  hold(args: string[]): { release(): void };
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/** What is going on now, as the daemon sees it. `claude`: a session works or a background agent runs (a Claude that waits for the person is not work). */
export interface Work {
  enabled: boolean;
  claude: boolean;
  /** The command running in the shell, and when it began (ms since epoch). */
  command: { cmd: string; since: number } | null;
}

export class StayAwake {
  private held: { release(): void } | null = null;
  private releaseTimer: unknown = null;
  private stopped = false;

  constructor(private d: StayAwakeDeps) {}

  get holding(): boolean {
    return this.held !== null;
  }

  /** The work now. Starts the hold, keeps it, or begins the delay of letting it go. Never throws. */
  update(w: Work): void {
    if (this.stopped) return;
    if (!w.enabled || this.d.platform !== 'darwin') {
      this.release();
      return;
    }
    const ran = w.command && !isInteractiveCommand(w.command.cmd) ? this.d.now() - w.command.since : -1;
    const command = ran >= STAY_AWAKE.commandAfterMs && ran < STAY_AWAKE.commandCapMs;
    if (w.claude || command) {
      this.cancelRelease();
      if (!this.held) this.start();
    } else if (this.held) {
      // a command that has run its six hours is let go of now, not after the delay: that is a limit, not a pause between tool calls
      if (ran >= STAY_AWAKE.commandCapMs) this.release();
      else this.releaseLater();
    }
  }

  /** The daemon is going away: nothing is held after this. */
  stop(): void {
    this.stopped = true;
    this.release();
  }

  private start(): void {
    try {
      this.held = this.d.hold(['-i', '-w', String(this.d.pid)]);
    } catch {
      this.held = null; // no hold is no harm: the next update tries again
    }
  }

  private releaseLater(): void {
    if (this.releaseTimer !== null) return;
    this.releaseTimer = this.d.setTimer(() => {
      this.releaseTimer = null;
      this.release();
    }, STAY_AWAKE.releaseDelayMs);
  }

  private cancelRelease(): void {
    if (this.releaseTimer === null) return;
    this.d.clearTimer(this.releaseTimer);
    this.releaseTimer = null;
  }

  private release(): void {
    this.cancelRelease();
    const held = this.held;
    this.held = null;
    try {
      held?.release();
    } catch {
      /* already gone */
    }
  }
}
