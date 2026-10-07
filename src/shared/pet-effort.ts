/** How long something has been working before its mole works harder: half a minute, two minutes, five minutes. */
export const EFFORT_STEPS_MS = [30_000, 120_000, 300_000] as const;

export type Effort = 0 | 1 | 2 | 3;

/** 0 fresh · 1 getting on with it (faster) · 2 sweating · 3 a marathon (hard hat, the pile grows). */
export function effortLevel(runningMs: number | undefined): Effort {
  if (runningMs === undefined || !Number.isFinite(runningMs) || runningMs < 0) return 0;
  return EFFORT_STEPS_MS.filter((step) => runningMs >= step).length as Effort;
}

/** The longest-running duration among start times (ms since epoch); undefined when none of them has a start. */
export function longestRunning(starts: (number | undefined)[], now: number): number | undefined {
  const known = starts.filter((s): s is number => typeof s === 'number');
  return known.length ? now - Math.min(...known) : undefined;
}
