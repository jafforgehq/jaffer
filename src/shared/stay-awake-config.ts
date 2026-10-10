/**
 * The numbers behind keeping the Mac from idle sleep while Claude works, and the app's identity. One place, so the daemon, the window
 * and the tests agree.
 */

/** Keeping the Mac awake (an idle-sleep assertion, no admin rights) while Claude works. */
export const STAY_AWAKE = {
  /** A command running this long in the shell holds the Mac awake too. */
  commandAfterMs: 30_000,
  /** The hold is let go this long after the work stops, so a short pause does not flap it. */
  releaseDelayMs: 15_000,
  /** A command alone never holds the Mac awake longer than this (six hours). */
  commandCapMs: 21_600_000,
  /** A hold that ended by itself (`caffeinate` killed or crashed) while the work goes on is taken up again after this wait... */
  holdAgainFirstMs: 1_000,
  /** ...which doubles each time it ends again, up to this... */
  holdAgainMaxMs: 30_000,
  /** ...and starts over after a clean minute. */
  holdCleanMs: 60_000,
} as const;

/** The app's bundle identifier (`appId` in electron-builder.yml). */
export const APP_BUNDLE_ID = 'com.jafforge.jaffer';
