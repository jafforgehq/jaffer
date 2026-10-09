/**
 * The numbers behind keeping the one session and Claude Code running: the automatic resume of a conversation that died with the
 * shell, and the hold that keeps the Mac from idle sleep while Claude works. One place, so the daemon, the window and the tests agree.
 */

/** Resuming the Claude Code conversation by itself after the shell came back (a reboot, an update, a crash). */
export const AUTO_RESUME = {
  /** How long the window says "resuming" before `claude --resume` is typed, so the person can stop it. */
  noticeMs: 3_000,
  /** The terminal must have been quiet this long before anything is typed. */
  quietMs: 2_000,
  /** At most this many automatic attempts for one conversation within `windowMs`, then it is offered by hand. */
  maxAttempts: 3,
  windowMs: 600_000,
  /** How long to wait before the first, second and third attempt. */
  waitsMs: [3_000, 20_000, 120_000],
  /** Claude Code alive this long after an attempt means it worked: the attempts are forgotten. */
  healthyMs: 30_000,
} as const;

/**
 * The same rules on a scale of milliseconds, for the daemon tests only: the daemon uses them when it is started with
 * `JAFFER_TEST_AUTORESUME_FAST=1`, and never otherwise. The window is wide enough for three crashes of a real process to fit in it.
 */
export const AUTO_RESUME_TEST = {
  noticeMs: 600,
  quietMs: 500,
  maxAttempts: 3,
  windowMs: 120_000,
  waitsMs: [600, 800, 1_000],
  healthyMs: 1_500,
} as const;

/**
 * Restart Claude Code: how long the daemon holds the person's request for the new shell's first prompt (a shell with a heavy startup
 * file takes a while). Past it the request is stale and nothing is typed for it. The daemon uses the second only in its test mode
 * (`JAFFER_TEST_AUTORESUME_FAST=1`), like `AUTO_RESUME_TEST`.
 */
export const RESTART_HOLD_MS = 30_000;
export const RESTART_HOLD_TEST_MS = 5_000;

/** Keeping the Mac awake (an idle-sleep assertion, no admin rights) while Claude works. */
export const STAY_AWAKE = {
  /** A command running this long in the shell holds the Mac awake too. */
  commandAfterMs: 30_000,
  /** The hold is let go this long after the work stops, so a short pause does not flap it. */
  releaseDelayMs: 15_000,
  /** A command alone never holds the Mac awake longer than this (six hours). */
  commandCapMs: 21_600_000,
} as const;

/** The launchd label of the daemon's login agent. */
export const AGENT_LABEL = 'com.jafforge.jaffer.daemon';
