/** A turn shorter than this (a quick answer) says nothing about how long a working turn takes. */
const MIN_TURN_MS = 3_000;
/** How many of the last turns the typical length is the median of. */
const SAMPLES = 15;

/**
 * How long a turn of Claude typically takes, after one more finished turn of `sampleMs`: the median of the last 15. `recent` is the daemon's
 * memory of them (this updates it); when it is empty (the app started again), `prev`, the stored value, counts as one of them.
 */
export function nextTypicalTurnMs(prev: number, sampleMs: number, recent: number[]): number {
  if (!(sampleMs >= MIN_TURN_MS)) return prev;
  if (!recent.length && prev > 0) recent.push(prev);
  recent.push(sampleMs);
  if (recent.length > SAMPLES) recent.splice(0, recent.length - SAMPLES);
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}
