import { COMMAND_HEAD } from './process-badge';
import { isSensitiveCommand, redactText } from './redact';
import { clipLabel } from './tray-state';
import { tildeOf } from './history-label';

/** A command for the menu bar's Recent Commands: `label` is what the menu shows, `raw` what a click copies. */
export interface RecentCommand {
  label: string;
  raw: string;
}

const MAX = 5;

/**
 * The last five commands that finished in the terminal, newest first, for the menu bar item. Memory only, in the main process. The
 * rules are the window's (⌘R): an empty or sensitive command is never kept, nor one longer than a command's head, and the label is
 * redacted, on one line, at most 60 characters.
 */
export class RecentCommands {
  private items: RecentCommand[] = [];

  add(cmd: string): void {
    if (typeof cmd !== 'string' || cmd.length > 4 * COMMAND_HEAD || !cmd.trim() || isSensitiveCommand(cmd)) return;
    this.items = [{ label: clipLabel(redactText(cmd)), raw: cmd }, ...this.items.filter((c) => c.raw !== cmd)].slice(0, MAX);
  }

  list(): RecentCommand[] {
    return this.items;
  }
}

/** ⌘R by folder (1.2.0): `items` (newest first) under their folder's tilde label, the group of the newest first; no folder is "Unknown folder". */
export function groupByFolder<T extends { cwd?: string }>(items: T[], home: string): { label: string; items: T[] }[] {
  const groups = new Map<string, { label: string; items: T[] }>();
  for (const it of items) {
    const key = it.cwd || '';
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { label: key ? tildeOf(key, home) : 'Unknown folder', items: [] }));
    g.items.push(it);
  }
  return [...groups.values()];
}

export type RecentMode = 'all' | 'failed' | 'slow';

/** ⌘R's filters (1.7.0): *Failed* keeps the commands that exited with a number other than 0; *Slowest* the ones that took a second or more, longest first (at most 20). */
export function filterRecent<T extends { exit: number | null; durMs: number }>(items: T[], mode: RecentMode): T[] {
  if (mode === 'failed') return items.filter((c) => typeof c.exit === 'number' && c.exit !== 0);
  if (mode === 'slow') return items.filter((c) => c.durMs >= 1000).sort((a, b) => b.durMs - a.durMs).slice(0, 20);
  return items;
}
