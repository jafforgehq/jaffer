/** What a notification was about: Claude needs you, Claude finished, a long command finished or failed, the terminal's own notification. */
export type HoldKind = 'needs-you' | 'finished' | 'command' | 'failed' | 'terminal';

const SAYING: Record<HoldKind, (n: number) => string> = {
  finished: (n) => `Claude finished ${times(n)}`,
  'needs-you': (n) => `Claude needed you ${times(n)}`,
  command: (n) => `${n} command${n === 1 ? '' : 's'} finished`,
  failed: (n) => `${n} command${n === 1 ? '' : 's'} failed`,
  terminal: (n) => `${n} terminal notification${n === 1 ? '' : 's'}`,
};
const times = (n: number): string => (n === 1 ? 'once' : `${n} times`);

/**
 * Focus mode (⌥⌘F): while it is on, notifications are held instead of shown, only counted by kind (never what they said), and ending it
 * gives one sentence about what was held, or none. Memory only; the app's main process keeps one.
 */
export class FocusHold {
  private on = false;
  private counts = new Map<string, number>();

  get active(): boolean {
    return this.on;
  }

  /** Focus mode begins; what was held before it ended stays counted (a second start changes nothing). */
  start(): void {
    this.on = true;
  }

  /** True when the notification of this kind is held (focus mode is on: the caller shows nothing). */
  hold(kind: HoldKind): boolean {
    if (!this.on) return false;
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    return true;
  }

  /** Focus mode ends: the sentence about what was held (and the count starts over), or null when nothing was. */
  release(): string | null {
    this.on = false;
    const parts = (Object.keys(SAYING) as HoldKind[]).filter((k) => this.counts.get(k)).map((k) => SAYING[k](this.counts.get(k)!));
    this.counts.clear();
    return parts.length ? `While you were focused: ${parts.join(', ')}` : null;
  }
}
