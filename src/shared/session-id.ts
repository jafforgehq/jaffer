/** A Claude Code conversation id (the name of its transcript, what `claude --resume` takes): a UUID, nothing else, since it ends up on a command line. */
export function isSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
