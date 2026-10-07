export type CrewMood = 'dig' | 'cheer';

/** At most this many helper moles beside the main one: a corner of the terminal is only so wide. */
export const MAX_CREW = 3;

/** One helper mole per running background agent (Claude's subagents). */
export function crewSize(running: number): number {
  return Number.isFinite(running) ? Math.max(0, Math.min(MAX_CREW, Math.floor(running))) : 0;
}

/**
 * What each of the `shown` helpers is doing. The first `crewSize(running)` dig (their agent is still running); any beyond
 * that are leaving: their agent just finished, so they cheer for a moment before the corner drops them.
 */
export function crewMoods(running: number, shown: number): CrewMood[] {
  const digging = crewSize(running);
  return Array.from({ length: Math.max(0, shown) }, (_, i) => (i < digging ? 'dig' : 'cheer'));
}
