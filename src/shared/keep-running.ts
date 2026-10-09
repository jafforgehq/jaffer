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
