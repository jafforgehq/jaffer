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

/**
 * How the login agent that keeps the session running stands, as the daemon tells it (`service.status`, `service.install`,
 * `service.remove`): from launchd and the plist on disk, not from the switch alone.
 * - `not-installed`: no plist.
 * - `installed`: the files are in place and launchd is not running this daemon: it takes over at the next login, or the next time the
 *   session starts (the app or `jaffer` then loads the job and starts the daemon through launchd). What a daemon that was started
 *   detached says after the switch was turned on: launchd's own instance would have found the socket taken and stopped.
 * - `running`: launchd runs the daemon, with this pid.
 * - `not-loaded`: the plist is there but launchd runs nothing for it (from `LaunchAgent.status`; the daemon says `installed` instead
 *   when it is not launchd's own).
 * - `refused`: it cannot be here, and why (not macOS, not the person's own `~/.jaffer`, an app run from a disk image).
 * `note`: something the person should know about what was just done (for example that turning it off ends the session now).
 */
export type AgentStatus = ({ state: 'not-installed' } | { state: 'installed' } | { state: 'running'; pid: number } | { state: 'not-loaded' } | { state: 'refused'; reason: string }) & { note?: string };

/** The state in words, as `jaffer service status` prints it and Settings shows it. */
export function agentStatusText(s: AgentStatus): string {
  switch (s.state) {
    case 'not-installed':
      return 'not installed';
    case 'installed':
      return 'installed, active from the next login or restart';
    case 'running':
      return `running (pid ${s.pid})`;
    case 'not-loaded':
      return 'installed but not loaded';
    case 'refused':
      return `refused: ${s.reason}`;
  }
}
