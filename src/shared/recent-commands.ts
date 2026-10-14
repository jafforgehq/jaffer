import { COMMAND_HEAD } from './process-badge';
import { isSensitiveCommand, redactText } from './redact';
import { clipLabel } from './tray-state';

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
