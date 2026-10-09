import { isSessionId, resumeCommand } from '../../shared/claude-resume';
import { AUTO_RESUME } from '../../shared/keep-running';

/**
 * The numbers of `AUTO_RESUME`, as plain numbers: `typeof AUTO_RESUME` is a type of literal values, and the daemon's test mode passes a
 * copy scaled down to milliseconds. Everything below reads them from here, never from `AUTO_RESUME` directly.
 */
export interface AutoResumeTiming {
  readonly noticeMs: number;
  readonly quietMs: number;
}

/** Everything the decision about the person's request depends on, at one moment. */
export interface AutoResumeInput {
  now: number;
  /** The conversation the daemon would offer back (`ResumeStore.offer`), or null. */
  offer: { id: string } | null;
  /** The shell is at its prompt (OSC 133) and its line is empty: nothing typed since the shell began or its last command, so what is typed here is not added to anything. */
  promptReady: boolean;
  /** Something runs in the shell. */
  busy: boolean;
  /** When the person last typed into the terminal. */
  lastInputAt: number;
  stopping: boolean;
  /** When the notice was given, if it was. */
  pendingSince?: number;
}

export type AutoResumeStep = { kind: 'idle' } | { kind: 'announce'; typesAt: number } | { kind: 'wait'; until: number } | { kind: 'type'; id: string };

export type AutoResumeEvent = { state: 'pending'; id: string; typesAt: number } | { state: 'typed' | 'cancelled'; id: string };

export interface AutoResumeDeps {
  now(): number;
  offer(): { id: string } | null;
  promptReady(): boolean;
  busy(): boolean;
  lastInputAt(): number;
  stopping(): boolean;
  /**
   * The shell itself has the terminal right now, not a program it runs (whatever the marks say: a program can print them). Asked once
   * more the moment it would type; a no there types nothing.
   */
  mayType(): boolean;
  /** Writes to the terminal. Only ever `claude --resume <id>` and Enter. */
  type(text: string): void;
  emit(e: AutoResumeEvent): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/**
 * For a request the person made: whether to type `claude --resume <id>` now, later, or not at all. Never without an offer of a valid
 * id or while the daemon is stopping; otherwise only at a prompt with nothing running, after the person has been quiet for a moment,
 * and after the notice.
 */
export function nextStep(i: AutoResumeInput, t: AutoResumeTiming = AUTO_RESUME): AutoResumeStep {
  if (!i.offer || !isSessionId(i.offer.id) || i.stopping) return { kind: 'idle' };
  if (i.busy || !i.promptReady) return { kind: 'idle' };
  const quietAt = i.lastInputAt + t.quietMs;
  if (i.pendingSince === undefined) return i.now < quietAt ? { kind: 'wait', until: quietAt } : { kind: 'announce', typesAt: i.now + t.noticeMs };
  const at = Math.max(i.pendingSince + t.noticeMs, quietAt);
  return i.now < at ? { kind: 'wait', until: at } : { kind: 'type', id: i.offer.id };
}

/**
 * Types `claude --resume <id>` for Restart Claude Code, which the person confirmed in a native dialog: announced first (`pending` with
 * the time it will type), cancellable until then, once. Nothing is ever resumed by itself: only `check({ explicit: true })` starts
 * anything, and the daemon makes it only for that request (at each prompt of the new shell, until it is typed or cancelled). The waits
 * run on the injected timers.
 */
export class AutoResumer {
  /** One timer at most: the end of a wait for quiet, or of the notice. */
  private timer: { handle: unknown } | undefined;
  /** The notice given: for which conversation, when, and the time it said it would type. */
  private pending: { id: string; since: number; typesAt: number } | undefined;
  /** The conversation the person asked for (Restart Claude Code), until it is typed, cancelled or over. */
  private explicitId: string | undefined;

  constructor(
    private d: AutoResumeDeps,
    private t: AutoResumeTiming = AUTO_RESUME,
  ) {}

  /**
   * The person asked for it (Restart Claude Code): the conversation offered now is typed after the notice, if the rules allow. A
   * repeat while it waits is the same request (announced once). It lasts only until its first idle (a shell not at a prompt yet), so
   * the caller repeats it until it is typed or cancelled. There is no other way to start anything.
   */
  check(_request: { explicit: true }): void {
    this.step(true);
  }

  /** The person said no (Cancel on the notice): nothing is typed, and the request is over (the button is left). */
  cancel(): void {
    this.endNotice();
  }

  /**
   * The request is over without typing, as the daemon says: it stops, the shell died, or the conversation offered is not the one
   * announced any more. A notice that runs ends (`cancelled`), and a wait before it is dropped. Never starts anything.
   */
  endNotice(): void {
    this.explicitId = undefined;
    this.drop();
  }

  private step(asked: boolean): void {
    this.unschedule();
    const id = this.d.offer()?.id;
    // a request is for the conversation offered when it was made: with none offered any more, or another one, it is over
    if (asked) this.explicitId = id;
    else if (this.explicitId !== id) this.explicitId = undefined;
    if (this.pending && this.pending.id !== id) this.drop();
    if (id === undefined || this.explicitId === undefined) return this.endNotice();
    const now = this.d.now();
    // (only with a conversation to resume: the daemon asks the system to know whether the shell is at its prompt)
    const s = nextStep({ now, offer: { id }, promptReady: this.d.promptReady(), busy: this.d.busy(), lastInputAt: this.d.lastInputAt(), stopping: this.d.stopping(), pendingSince: this.pending?.since }, this.t);
    if (s.kind === 'idle') return this.endNotice();
    if (s.kind === 'wait') this.schedule(s.until - now);
    else if (s.kind === 'announce') {
      this.pending = { id, since: now, typesAt: s.typesAt };
      this.d.emit({ state: 'pending', id, typesAt: s.typesAt });
      this.schedule(s.typesAt - now);
    } else this.typeNow(s.id);
  }

  private typeNow(id: string): void {
    this.explicitId = undefined;
    // checked where it is kept, by the decision, and here again where it is typed
    if (!isSessionId(id)) return this.drop();
    // and the shell is looked at again: a program it runs is never typed into
    if (!this.d.mayType()) return this.drop();
    this.pending = undefined;
    this.d.type(`${resumeCommand(id)}\r`);
    this.d.emit({ state: 'typed', id });
  }

  /** The notice, if there was one, is over without typing. */
  private drop(): void {
    this.unschedule();
    const p = this.pending;
    this.pending = undefined;
    if (p) this.d.emit({ state: 'cancelled', id: p.id });
  }

  private schedule(ms: number): void {
    const slot: { handle: unknown } = { handle: undefined };
    slot.handle = this.d.setTimer(
      () => {
        if (this.timer !== slot) return; // replaced or cleared meanwhile
        this.timer = undefined;
        this.step(false);
      },
      Math.max(0, ms),
    );
    this.timer = slot;
  }

  private unschedule(): void {
    if (this.timer) this.d.clearTimer(this.timer.handle);
    this.timer = undefined;
  }
}
