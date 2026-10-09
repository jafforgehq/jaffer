import { isSessionId, resumeCommand } from '../../shared/claude-resume';
import { AUTO_RESUME } from '../../shared/keep-running';

/**
 * The numbers of `AUTO_RESUME`, as plain numbers: `typeof AUTO_RESUME` is a type of literal values, and the daemon's test mode passes a
 * copy scaled down to milliseconds. Everything below reads them from here, never from `AUTO_RESUME` directly.
 */
export interface AutoResumeTiming {
  readonly noticeMs: number;
  readonly quietMs: number;
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly waitsMs: readonly number[];
  readonly healthyMs: number;
}

/** Everything the decision depends on, at one moment. */
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
  enabled: boolean;
  stopping: boolean;
  /** When the automatic attempts for this conversation were made. */
  attempts: number[];
  /** When the notice was given, if it was. */
  pendingSince?: number;
  /** When that notice said it would type: never earlier, even if an old attempt ages out meanwhile. */
  typesAt?: number;
  /** The person cancelled it for this offer. */
  cancelled: boolean;
}

export type AutoResumeStep = { kind: 'idle' } | { kind: 'announce'; typesAt: number } | { kind: 'wait'; until: number } | { kind: 'type'; id: string } | { kind: 'give-up' };

export type AutoResumeEvent = { state: 'pending'; id: string; typesAt: number } | { state: 'typed' | 'cancelled' | 'gave-up'; id: string };

export interface AutoResumeDeps {
  now(): number;
  offer(): { id: string } | null;
  promptReady(): boolean;
  busy(): boolean;
  lastInputAt(): number;
  enabled(): boolean;
  stopping(): boolean;
  attempts(id: string): number[];
  recordAttempt(id: string): void;
  clearAttempts(id: string): void;
  /** Writes to the terminal. Only ever `claude --resume <id>` and Enter. */
  type(text: string): void;
  emit(e: AutoResumeEvent): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/** How long to wait before the next attempt: the first wait, then longer ones, the last for any after it. */
export function waitBefore(attempts: number[], t: AutoResumeTiming = AUTO_RESUME): number {
  return t.waitsMs[Math.min(attempts.length, t.waitsMs.length - 1)] ?? t.noticeMs;
}

/**
 * Whether to type `claude --resume <id>` now, later, or not at all. Never without an offer of a valid id, while the daemon is
 * stopping, with the setting off, or after the person cancelled it; at the attempt limit it gives up. Otherwise only at a prompt with
 * nothing running, after the person has been quiet for a moment, and after a notice as long as the wait for this attempt.
 */
export function nextStep(i: AutoResumeInput, t: AutoResumeTiming = AUTO_RESUME): AutoResumeStep {
  if (!i.offer || !isSessionId(i.offer.id) || i.stopping || !i.enabled || i.cancelled) return { kind: 'idle' };
  const tries = i.attempts.filter((at) => i.now - at < t.windowMs);
  if (tries.length >= t.maxAttempts) return { kind: 'give-up' };
  if (i.busy || !i.promptReady) return { kind: 'idle' };
  const quietAt = i.lastInputAt + t.quietMs;
  // the notice says when it will type, and it is never shorter than the notice
  const wait = Math.max(t.noticeMs, waitBefore(tries, t));
  if (i.pendingSince === undefined) return i.now < quietAt ? { kind: 'wait', until: quietAt } : { kind: 'announce', typesAt: i.now + wait };
  const at = Math.max(i.typesAt ?? i.pendingSince + wait, quietAt);
  return i.now < at ? { kind: 'wait', until: at } : { kind: 'type', id: i.offer.id };
}

/** `claude` ended without the person meaning to: not 0, not Ctrl+C (130), and an unknown exit is not taken for a crash. */
const crashed = (exit: number | null): boolean => exit !== null && exit !== 0 && exit !== 130;
/** Ctrl+Z reports 128 + a stop signal: Claude is suspended, not ended, and comes back with `fg`. */
const stopped = (exit: number | null): boolean => exit !== null && exit >= 145 && exit <= 150;

/**
 * Types `claude --resume <id>` by itself when the conversation can be taken back up: announced first (`pending` with the time it will
 * type), cancellable until then, at most a few attempts per conversation. The daemon calls `check()` whenever something it depends on
 * may have changed, and `claudeEnded()` when a `claude` command finishes; the waits run on the injected timers.
 */
export class AutoResumer {
  /** One timer at most: the end of a wait for quiet, or of the notice. */
  private timer: { handle: unknown } | undefined;
  /** The notice given: for which conversation, when, and the time it said it would type. */
  private pending: { id: string; since: number; typesAt: number } | undefined;
  /** The offer the person asked for (Restart Claude): it goes ahead with the setting off, for this one try. */
  private explicitId: string | undefined;
  // The two marks below hold until another conversation is offered or a Claude run ends (or the daemon restarts). An offer that is
  // missing for a while (a command running, a `cd` elsewhere and back) does not clear them: the person was told once, and Cancel
  // leaves the button.
  /** The offer the person cancelled. */
  private cancelledId: string | undefined;
  /** The offer it gave up on, told once: no automatic try for it, even once old attempts age out. */
  private gaveUpId: string | undefined;
  /** The conversation typed last, until its `claude` ends. */
  private tried: string | undefined;

  constructor(
    private d: AutoResumeDeps,
    private t: AutoResumeTiming = AUTO_RESUME,
  ) {}

  /**
   * `explicit`: the person asked for it (Restart Claude). It does not need the setting on, and it overrides an earlier Cancel and an
   * earlier give-up. The limit on attempts is for crash loops nobody asked for: a request starts that conversation's attempts over, so
   * it announces the short notice (never the 20 s or 2 min waits of a retry) and then counts as one attempt. It lasts only until its
   * first idle (a shell not at a prompt yet), so the caller repeats it until it is typed, cancelled or given up on.
   */
  check(opts: { explicit?: boolean } = {}): void {
    this.step(opts.explicit === true);
  }

  /** The person said no to this attempt: nothing is typed, and this offer stays quiet (the button is left) until the marks clear. */
  cancel(): void {
    const id = this.pending?.id ?? this.d.offer()?.id;
    this.drop();
    this.explicitId = undefined;
    if (id !== undefined) this.cancelledId = id;
  }

  /**
   * A `claude` command finished: what was cancelled or given up on before is history. A crash is tried again; after an automatic try,
   * a run that lasted `healthyMs` worked, so its attempts start over, and a shorter one stays counted (the next try waits longer, or it
   * gives up). A deliberate end does nothing more.
   */
  claudeEnded(info: { exit: number | null; durMs: number }): void {
    if (stopped(info.exit)) return; // suspended, not ended
    this.cancelledId = undefined;
    this.gaveUpId = undefined;
    const tried = this.tried;
    this.tried = undefined;
    if (!crashed(info.exit)) return;
    if (tried !== undefined && info.durMs >= this.t.healthyMs) this.d.clearAttempts(tried);
    this.check();
  }

  /**
   * The shell died, and any Claude in it: a Cancel was said about the shell that is gone, so the new shell's prompt may bring the
   * conversation back. A give-up stays: a new shell is not a new try, and it was said once.
   */
  shellDied(): void {
    this.cancelledId = undefined;
    this.check();
  }

  private step(explicit: boolean): void {
    this.unschedule();
    const id = this.d.offer()?.id;
    // another conversation offered clears the marks; no offer for a moment does not
    if (id !== undefined && this.cancelledId !== id) this.cancelledId = undefined;
    if (id !== undefined && this.gaveUpId !== id) this.gaveUpId = undefined;
    if (this.explicitId !== id) this.explicitId = undefined;
    if (this.pending && this.pending.id !== id) this.drop();
    if (explicit && id !== undefined) {
      // a request begins here (a repeat of one that is waiting is not another): the earlier automatic attempts are forgotten
      if (this.explicitId !== id && isSessionId(id)) this.d.clearAttempts(id);
      this.explicitId = id;
      this.cancelledId = undefined;
      this.gaveUpId = undefined;
    }
    const asked = id !== undefined && id === this.explicitId;
    const now = this.d.now();
    const s = nextStep(
      {
        now,
        offer: id === undefined ? null : { id },
        promptReady: this.d.promptReady(),
        busy: this.d.busy(),
        lastInputAt: this.d.lastInputAt(),
        enabled: asked || this.d.enabled(),
        stopping: this.d.stopping(),
        attempts: id !== undefined && isSessionId(id) ? this.d.attempts(id) : [],
        pendingSince: this.pending?.since,
        typesAt: this.pending?.typesAt,
        cancelled: id !== undefined && (id === this.cancelledId || id === this.gaveUpId),
      },
      this.t,
    );
    if (s.kind === 'idle' || s.kind === 'give-up' || id === undefined) {
      this.drop();
      this.explicitId = undefined;
      if (s.kind === 'give-up' && id !== undefined && this.gaveUpId !== id) {
        this.gaveUpId = id;
        this.d.emit({ state: 'gave-up', id });
      }
      return;
    }
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
    this.pending = undefined;
    this.tried = id;
    this.d.recordAttempt(id);
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
