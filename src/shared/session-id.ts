/** A Claude Code conversation id (the name of its transcript, what `claude --resume` takes): a UUID, nothing else, since it ends up on a command line. */
export function isSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** A terminal's id as the hook CLI passes it on from the shell's `JAFFER_PANE` (`main`, `p2`..`p4`): short and plain, or nothing. */
export function isPaneId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9]{1,16}$/.test(id);
}
