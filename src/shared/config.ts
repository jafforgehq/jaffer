import { DEFAULT_COMPANION, type Companion } from './companions';
import type { JafferPaths } from './paths';
import { Emitter, readJson, writeJson } from './util';

export interface JafferConfig {
  /** First-run flow completed. */
  onboarded: boolean;
  appearance: {
    theme: string;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    opacity: number;
    cursorStyle: 'block' | 'bar' | 'underline';
    cursorBlink: boolean;
    scrollback: number;
    optionAsMeta: boolean;
    /** webgl is fastest; dom is the safe fallback for unusual GPU setups. */
    renderer: 'webgl' | 'dom';
    /** Decorative motion (the mole, the spinning ring). Off here, or macOS Reduce motion, and everything stands still. */
    animations: boolean;
    /** A little animation in a corner of the terminal that shows when something runs (Settings → Appearance → Companion). */
    pet: boolean;
    /** Which one: the mole, or one of the scenes. Anything unknown is the mole. */
    companion: Companion;
  };
  shell: { path: string; args: string[] };
  /** The person chose a plain terminal at first run. Claude stays on offer (Settings → Claude Code), nothing about it nags; connecting it clears this. */
  claude: {
    skipped: boolean;
    /** After every answer, say what it cost (an estimate from the token counts at API list prices; a subscription is not billed per token). */
    showCost: boolean;
  };
  /** Jaffer asks before updating itself; this only controls whether it looks in the background. */
  updates: { auto: boolean };
  /** What Jaffer may tell you while it is in the background. */
  notifications: {
    /** "Claude finished" when a turn that took half a minute or more ends. */
    claudeFinished: boolean;
  };
  session: {
    /** After a restart (a reboot, an update, a crash), offer to resume the Claude Code conversation that was running in this folder. */
    resumeClaude: boolean;
    /** Keep the session and Claude Code running after the window is closed and across a login: the daemon starts at login (a user LaunchAgent). Off by default: it is installed only on a click. */
    keepRunning: boolean;
    /** Keep the Mac from idle sleep while Claude works (and while a long command runs). Takes no admin rights and lets go when the work stops. */
    stayAwake: boolean;
  };
  hotkey: string;
}

export const DEFAULT_CONFIG: JafferConfig = {
  onboarded: false,
  appearance: {
    theme: 'jaffer-dark',
    fontFamily: 'SF Mono, Menlo, Monaco, "JetBrains Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    opacity: 0.96,
    cursorStyle: 'block',
    cursorBlink: false,
    scrollback: 20000,
    optionAsMeta: true,
    renderer: 'webgl',
    animations: true,
    pet: true,
    companion: DEFAULT_COMPANION,
  },
  shell: { path: '', args: [] },
  claude: { skipped: false, showCost: true },
  updates: { auto: true },
  notifications: { claudeFinished: true },
  session: { resumeClaude: true, keepRunning: false, stayAwake: true },
  hotkey: 'Control+`',
};

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return (over === undefined ? base : (over as T)) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    if (b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(b, v);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * `value` with every key the reference knows brought to the reference's kind: a section stays an object, a switch a boolean, a
 * list a list of text. What does not fit becomes the reference's own value. Keys the reference does not know (a newer version
 * wrote them) pass through. A hand-edited file, or `jaffer config set shell.args -l,-i` (stored as the string
 * "-l,-i"), must not be able to crash the window or stop the daemon starting, nor quietly keep a privacy setting from working.
 */
function conform(value: unknown, ref: unknown): unknown {
  if (isRecord(ref)) {
    if (!isRecord(value)) return structuredClone(ref);
    const out: Record<string, unknown> = { ...value };
    for (const [k, r] of Object.entries(ref)) out[k] = k in value ? conform(value[k], r) : structuredClone(r);
    return out;
  }
  if (Array.isArray(ref)) return isTextList(value) ? value : structuredClone(ref);
  return typeof value === typeof ref ? value : ref;
}

export class ConfigStore {
  readonly onChange = new Emitter<JafferConfig>();
  private cfg: JafferConfig;

  constructor(private paths: JafferPaths) {
    this.cfg = conform(merge(structuredClone(DEFAULT_CONFIG), readJson<unknown>(paths.config, {})), DEFAULT_CONFIG) as JafferConfig;
  }

  get(): JafferConfig {
    return this.cfg;
  }

  patch(p: DeepPartial<JafferConfig>): JafferConfig {
    this.cfg = conform(merge(this.cfg, p), this.cfg) as JafferConfig; // a value of the wrong kind leaves what was there
    writeJson(this.paths.config, this.cfg);
    this.onChange.emit(this.cfg);
    return this.cfg;
  }
}
