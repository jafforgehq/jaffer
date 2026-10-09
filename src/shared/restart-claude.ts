/**
 * What the app asks before "Restart Claude Code" (the palette, Settings → Claude Code): it ends whatever runs in the shell, so it
 * always asks. Plain text for a native dialog: `resumable` is whether a Claude Code conversation would come back in the new shell,
 * `busy` whether Claude is working or waiting for the person right now.
 */
export function restartClaudeText(o: { resumable: boolean; busy: boolean }): { message: string; detail: string } {
  const working = 'Claude is working right now: that work stops.';
  if (o.resumable) {
    const base = 'This restarts your shell in the same folder. Claude Code comes back in the same conversation; anything else running in the shell stops.';
    return { message: 'Restart Claude Code?', detail: o.busy ? `${base}\n\n${working}` : base };
  }
  // nothing to bring back: a plain shell restart, said so. (A Claude that works but cannot be brought back is not "no conversation".)
  if (o.busy) return { message: 'Restart the shell?', detail: `Claude Code is running, but its conversation cannot be brought back; this only restarts the shell.\n\n${working}` };
  return { message: 'Restart the shell?', detail: 'No Claude Code conversation is running; this only restarts the shell.' };
}
