/**
 * Withdrawn consent beats a read in flight: `take()` before the config read, `still(t)` after it. Anything that withdraws or stops
 * (Voice turned off, cancel, remove) calls `bump()`, so a download whose permission check straddled it does not start.
 */
export class VoiceEpoch {
  private n = 0;
  take(): number { return this.n; }
  bump(): void { this.n++; }
  still(t: number): boolean { return t === this.n; }
}
