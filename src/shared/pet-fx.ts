import type { ClaudeState } from '../core/claude/watcher';
import type { ToolCategory } from './tool-category';

/**
 * (1.7.0) A one-off pose on top of the companion's mood: it thinks before Claude's first tool call, winces at a failed command,
 * packs boxes while Claude compacts and waves harder when Claude has waited for the person a while. Pure decoration, memory only.
 */
export type PetFx = 'think' | 'wince' | 'compact' | 'impatient';

/** A failed command's wince lasts this long. */
export const WINCE_MS = 1600;
/** "Claude needs you" turns insistent after this long. */
export const IMPATIENT_AFTER_MS = 60_000;
/** From this share of the context window the companion strains. */
export const CONTEXT_FULL = 0.85;

/** An exit that is the person's own Ctrl-C (130) or a killed program (143) is not a failure worth a wince. */
export function winceExit(exit: unknown): boolean {
  return typeof exit === 'number' && Number.isFinite(exit) && exit !== 0 && exit !== 130 && exit !== 143;
}

export interface FxInput {
  claude: ClaudeState | undefined;
  compacting?: boolean;
  /** The tool category of the running call: null while Claude has none open. */
  tool: ToolCategory | null;
  /** Running background agents. */
  agents: number;
  /** A command runs in the terminal. */
  busy: boolean;
  /** When the session last changed state (the start of a "needs you" wait). */
  since?: number;
  failedAt?: number;
  now: number;
}

/** Which pose, if any, the companion strikes now. The most urgent one wins. */
export function petFx(o: FxInput): PetFx | null {
  if (o.claude === 'needs-you') return typeof o.since === 'number' && o.now - o.since >= IMPATIENT_AFTER_MS ? 'impatient' : null;
  if (typeof o.failedAt === 'number' && o.now - o.failedAt >= 0 && o.now - o.failedAt < WINCE_MS) return 'wince';
  if (o.compacting) return 'compact';
  if (o.claude === 'working' && !o.tool && o.agents === 0 && !o.busy) return 'think';
  return null;
}

/** The share of the context window in use, 0 to 1, or null when it is not known (no window, more tokens than the window). */
export function contextShare(c: { tokens: number; window?: number } | undefined | null): number | null {
  if (!c || !Number.isFinite(c.tokens) || c.tokens <= 0) return null;
  if (typeof c.window !== 'number' || !(c.window > 0) || c.tokens > c.window) return null;
  return c.tokens / c.window;
}

/** Night is 23:00 to 05:59 local: a nightcap and a dimmer scene. */
export function isNight(d: Date): boolean {
  const h = d.getHours();
  return h >= 23 || h < 6;
}
