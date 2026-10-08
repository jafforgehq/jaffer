/** What Jaffer may type to take a Claude Code conversation back up. The id is typed into a shell, so it is checked before it is kept and again before it is typed. */
export function isSessionId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(s);
}

export function resumeCommand(id: string): string {
  return `claude --resume ${id}`;
}

/** What the daemon tells the window: Claude Code was running here when Jaffer last stopped, and can be resumed. */
export interface ResumeOffer {
  id: string;
  cwd: string;
  /** When it was last seen working (ms since epoch). */
  at: number;
}
