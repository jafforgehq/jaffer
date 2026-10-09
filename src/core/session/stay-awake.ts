import { COMMAND_HEAD } from '../../shared/claude-resume';
import { optionWords, WRAPPER_LONG_OPTIONS, WRAPPER_OPTIONS } from '../../shared/danger-zone';
import { STAY_AWAKE } from '../../shared/keep-running';

/**
 * Keeping the Mac from idle sleep while something works: Claude working or running a background agent, or a plain command that has
 * run for a while. This is only the decision: the work comes in through `update`, a hold goes on or off. The process that does the
 * holding (`caffeinate -i -w <daemon pid>`), the clock and the timers are injected, so it is tested without waiting or holding anything.
 */

/** Programs a person sits in: they run for hours without anything working, so they do not count as a command that works. `claude` is covered by its own state. */
const INTERACTIVE = new Set(['ssh', 'mosh', 'vim', 'nvim', 'vi', 'less', 'man', 'top', 'htop', 'tmux', 'screen', 'watch', 'claude']);
/**
 * Words that run another program (`sudo -u deploy vim`, `env -u FOO ssh`, `nice -n 10 top`): skipped, with their options and the
 * values those take, to find the program. The table `sshHost` uses (danger-zone), and `builtin`, which takes none.
 */
const wrapperOptions = (w: string): string | undefined => (Object.hasOwn(WRAPPER_OPTIONS, w) ? WRAPPER_OPTIONS[w] : w === 'builtin' ? '' : undefined);
const wrapperLongOptions = (w: string): ReadonlySet<string> | undefined => (Object.hasOwn(WRAPPER_LONG_OPTIONS, w) ? WRAPPER_LONG_OPTIONS[w] : undefined);

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
  // variables and wrappers (with their options, and the values of those) come before the program: `sudo -u vim make` runs make
  while (i < words.length && isEnvAssignment(words[i]!)) i++;
  for (let wrapper = words[i] ?? '', takes = wrapperOptions(wrapper); takes !== undefined; wrapper = words[i] ?? '', takes = wrapperOptions(wrapper)) {
    const long = wrapperLongOptions(wrapper);
    i++;
    while (i < words.length) {
      const w = words[i]!;
      if (isEnvAssignment(w)) i++; // env FOO=1 ssh …
      else if (w === '--') {
        i++;
        break;
      } else if (w.startsWith('-') && w.length > 1) i += optionWords(w, takes, long);
      else break;
    }
  }
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
  /**
   * Starts a hold with these arguments for `/usr/bin/caffeinate`; the result lets it go (harmless once it has ended), and may say when it
   * ends, also by itself (killed, crashed) or because it could not start (`error`). May throw.
   */
  hold(args: string[]): Hold;
  /** Where a hold that cannot start is told, once. */
  log?(msg: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/** A hold, as `StayAwakeDeps.hold` gives it. */
export interface Hold {
  release(): void;
  /** `cb` once the hold has ended (at once when it already has); `error` when it could not start. */
  onExit?(cb: (error?: unknown) => void): void;
}

/** What is going on now, as the daemon sees it. `claude`: a session works or a background agent runs (a Claude that waits for the person is not work). */
export interface Work {
  enabled: boolean;
  claude: boolean;
  /** The command running in the shell, and when it began (ms since epoch). */
  command: { cmd: string; since: number } | null;
}

export class StayAwake {
  /** The hold, and when it began. */
  private held: { hold: Hold; since: number } | null = null;
  private releaseTimer: unknown = null;
  /** A hold that ended by itself is taken up again after a wait (see `ended`). */
  private againTimer: unknown = null;
  private wait: number = STAY_AWAKE.holdAgainFirstMs;
  /** When a hold last ended by itself (never: -Infinity). */
  private lastEndAt = -Infinity;
  /** The last update asked for a hold. */
  private wanted = false;
  /** A hold that could not start has been told (once). */
  private told = false;
  private stopped = false;

  constructor(private d: StayAwakeDeps) {}

  get holding(): boolean {
    return this.held !== null;
  }

  /** The work now. Starts the hold, keeps it, or begins the delay of letting it go. Never throws. */
  update(w: Work): void {
    if (this.stopped) return;
    if (!w.enabled || this.d.platform !== 'darwin') {
      this.wanted = false;
      this.cancelAgain();
      this.release();
      return;
    }
    const ran = w.command && !isInteractiveCommand(w.command.cmd) ? this.d.now() - w.command.since : -1;
    const command = ran >= STAY_AWAKE.commandAfterMs && ran < STAY_AWAKE.commandCapMs;
    this.wanted = w.claude || command;
    if (this.wanted) {
      this.cancelRelease();
      // (while a hold that ended by itself waits to be taken up again, the wait decides: one that keeps ending must not be restarted
      // at every event)
      if (!this.held && this.againTimer === null) this.start();
    } else {
      this.cancelAgain();
      if (this.held) {
        // a command that has run its six hours is let go of now, not after the delay: that is a limit, not a pause between tool calls
        if (ran >= STAY_AWAKE.commandCapMs) this.release();
        else this.releaseLater();
      }
    }
  }

  /** The daemon is going away: nothing is held after this. */
  stop(): void {
    this.stopped = true;
    this.cancelAgain();
    this.release();
  }

  private start(): void {
    try {
      const held = { hold: this.d.hold(['-i', '-w', String(this.d.pid)]), since: this.d.now() };
      this.held = held;
      held.hold.onExit?.((error) => this.ended(held, error));
    } catch (e) {
      this.held = null; // no hold is no harm: the next update tries again
      this.tell(e);
    }
  }

  /**
   * A hold ended. Let go of on purpose (it is not the one held any more): nothing. By itself (`caffeinate` was killed or crashed, or it
   * could not start) while the work goes on: held again after a wait of 1 s, doubling at each end up to 30 s, and from 1 s again after a
   * clean minute (the hold that ended lasted that long, or that long passed since the last one that ended by itself).
   */
  private ended(held: { since: number }, error: unknown): void {
    if (error !== undefined) this.tell(error);
    if (this.held !== held) return;
    this.held = null;
    this.cancelRelease(); // nothing is left to let go of
    const now = this.d.now();
    const clean = now - held.since >= STAY_AWAKE.holdCleanMs || held.since - this.lastEndAt >= STAY_AWAKE.holdCleanMs;
    this.lastEndAt = now;
    if (clean) this.wait = STAY_AWAKE.holdAgainFirstMs;
    if (this.stopped || !this.wanted) return;
    const wait = this.wait;
    this.wait = Math.min(this.wait * 2, STAY_AWAKE.holdAgainMaxMs);
    this.cancelAgain();
    this.againTimer = this.d.setTimer(() => {
      this.againTimer = null;
      if (!this.stopped && this.wanted && !this.held) this.start();
    }, wait);
  }

  /** A hold that could not start, said once: it is tried again all the same. */
  private tell(e: unknown): void {
    if (this.told) return;
    this.told = true;
    try {
      this.d.log?.(`could not hold the Mac awake: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      /* a log that fails is no reason to stop */
    }
  }

  private cancelAgain(): void {
    if (this.againTimer === null) return;
    this.d.clearTimer(this.againTimer);
    this.againTimer = null;
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
    this.held = null; // (its end, which letting go of it brings, is then not "by itself")
    try {
      held?.hold.release();
    } catch {
      /* already gone */
    }
  }
}
