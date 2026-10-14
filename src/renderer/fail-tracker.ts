import { COMMAND_HEAD } from '../shared/process-badge';
import { isSensitiveCommand } from '../shared/redact';

/** How many commands are followed at once; the oldest is dropped for a new one. */
const MAX_KEYS = 50;
/** A command that fails this many times in a row and then works is a "Fixed it!". */
const FAILS_NEEDED = 3;

/**
 * Follows what happens to each command text this session, in memory only: `record` says true when a command exits 0 right after
 * three or more failures of the same text. Other commands in between change nothing; a success of the same text ends its run.
 * A command that is empty, sensitive or longer than a command's head is not followed, and a command with no known exit is skipped.
 */
export class FailTracker {
  private fails = new Map<string, number>();

  get size(): number {
    return this.fails.size;
  }

  record(cmd: string, exit: number | null): boolean {
    const key = cmd.trim();
    if (!key || key.length > 4 * COMMAND_HEAD || typeof exit !== 'number' || isSensitiveCommand(key)) return false;
    const n = this.fails.get(key) ?? 0;
    this.fails.delete(key); // (re-added below, newest last)
    if (exit === 0) return n >= FAILS_NEEDED;
    this.fails.set(key, n + 1);
    if (this.fails.size > MAX_KEYS) this.fails.delete(this.fails.keys().next().value as string);
    return false;
  }
}
