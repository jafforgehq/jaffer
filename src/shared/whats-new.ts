/** Which release notes the person has not seen yet. Pure: the window and the menu bar item both ask it. */
import { isNewer } from './update-policy';

export interface ReleaseNote {
  version: string;
  md: string;
}

/** The newest version that had no notes in the app: a Mac that ran Jaffer before sees the notes after this one. */
export const SEEN_BEFORE_NOTES = '1.1.1';
const MAX_SHOWN = 5;

/** The version whose notes count as seen: the one written when the card was dismissed, else (nothing written yet) 1.1.1 for a Mac that ran Jaffer before, else the running version (a first start sees nothing). */
export function effectiveSeen(cfg: { seenVersion?: string; onboarded?: boolean } | undefined, current: string): string {
  return cfg?.seenVersion || (cfg?.onboarded ? SEEN_BEFORE_NOTES : current);
}

/** The notes (newest first, as given) of versions after `seen` and not after `current`, at most the 5 newest. */
export function unseenNotes(notes: readonly ReleaseNote[], seen: string, current: string): ReleaseNote[] {
  return notes.filter((n) => isNewer(n.version, seen) && !isNewer(n.version, current)).slice(0, MAX_SHOWN);
}
