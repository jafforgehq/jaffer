import { DEFAULT_COMPANION, type Companion } from './companions';
import type { JafferPaths } from './paths';
import { Emitter, readJson, writeJson } from './util';

export interface JafferConfig {
  /** First-run flow completed. */
  onboarded: boolean;
  appearance: {
    theme: string;
    /** `off`: always `theme`; `system`: `theme` while macOS is dark, `lightTheme` while it is light; `time`: `lightTheme` from 07:00 to 19:00, `theme` otherwise. */
    autoTheme: 'off' | 'system' | 'time';
    /** The theme `autoTheme` switches to by day or in light mode. */
    lightTheme: string;
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
    /** Small bars for CPU, memory and battery at the right of the title bar (the app samples them every 5 s only while this is on). */
    systemStats: boolean;
    /** A soft glow on the window's edge: while Claude needs you, while it works, and once when a turn ends. Off with Animations off too. */
    glow: boolean;
    /** The window blurs what is behind it (macOS vibrancy). Off, the window is opaque whatever the opacity slider says. */
    blur: boolean;
  };
  shell: { path: string; args: string[] };
  /** The person chose a plain terminal at first run. Claude stays on offer (Settings → Claude Code), nothing about it nags; connecting it clears this. */
  claude: {
    skipped: boolean;
    /** After every answer, say what it cost (an estimate from the token counts at API list prices; a subscription is not billed per token). */
    showCost: boolean;
    /** While Claude works, also what the answer has cost so far (read from the transcript every 2 s; only with `showCost`). */
    liveCost: boolean;
    /** Dollars a day the cost figure is measured against (an estimate, see `showCost`); 0 is no budget. */
    dailyBudgetUsd: number;
    /** How long a turn of Claude typically takes (ms; the median of the last finished ones of 3 s or more), for the ring's progress. Kept by the daemon, not a setting; 0 is not known yet. */
    typicalTurnMs: number;
    /** A 2 px strip under the title bar: this turn's tool calls, coloured by kind, as wide as they took. */
    toolStrip: boolean;
    /** When a turn of 10 s or more ends: a toast with how long it took, what Claude did, the files it edited (and the cost, with `showCost`). */
    turnSummary: boolean;
  };
  terminal: {
    /** Command blocks: a mark beside every command's prompt (its exit, its times), jumping between prompts, the sticky command header, copying and saving a command's output. */
    blocks: boolean;
    /** Pasting two or more lines asks first ("Paste 14 lines?"). */
    pasteGuard: boolean;
    /** A faint line at this column: 0 (off), 80, 100 or 120. */
    ruler: number;
    /** ⌘-click on a printed file path opens this editor link (`vscode://file/{path}:{line}:{col}`; editor schemes only); empty reveals the file in Finder. */
    editorUrl: string;
    /** Pictures programs print (sixel, iTerm's inline images). */
    images: boolean;
    /** A chip in the title bar for a local server the running command mentions (`localhost:5173`); a click opens it in the browser. */
    portLinks: boolean;
  };
  /** Jaffer asks before updating itself; this only controls whether it looks in the background. */
  updates: { auto: boolean };
  /** What Jaffer may tell you while it is in the background. */
  notifications: {
    /** "Claude finished" when a turn that took half a minute or more ends. */
    claudeFinished: boolean;
  };
  session: {
    /** Keep the Mac from idle sleep while Claude works (and while a long command runs). Takes no admin rights and lets go when the work stops. */
    stayAwake: boolean;
  };
  /** The window's close button and the menu bar item. */
  window: {
    /** What the red ✕ (and ⌘W) does: hide the window to the menu bar, quit (asking first when something runs), or ask. */
    closeAction: 'menubar' | 'quit' | 'ask';
    /** An icon in the menu bar: Claude's state, a click shows or hides the window, a menu. */
    menuBar: boolean;
    /** No Dock icon: Jaffer lives in the menu bar only (only with `menuBar`). */
    menuBarOnly: boolean;
    /** Text beside the menu bar icon: nothing, this session's cost, the running turn's time, or today's cost (the costs only with `claude.showCost`). */
    menuBarTitle: 'off' | 'cost' | 'time' | 'today';
    /** The one notification that says Jaffer is still running in the menu bar, the first time the window hides, was shown. */
    hintShown: boolean;
  };
  /** The side panel at the right of the terminal (⌘B): the live Claude status and past conversations. */
  panel: {
    open: boolean;
    /** Its width in px (the window keeps it to 220..480). */
    width: number;
  };
  hotkey: string;
  /**
   * The one-time clean-up of a Mac an older Jaffer ran on (`core/migrate.ts`) has run (1). It runs at the app's start while this is 0, and
   * sets it whatever its steps did, so a step that failed is not retried at every start (`jaffer config set migrated 0` runs it again).
   */
  migrated: number;
}

export const DEFAULT_CONFIG: JafferConfig = {
  onboarded: false,
  appearance: {
    theme: 'jaffer-dark',
    autoTheme: 'off',
    lightTheme: 'jaffer-light',
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
    systemStats: false,
    glow: true,
    blur: true,
  },
  shell: { path: '', args: [] },
  claude: { skipped: false, showCost: true, liveCost: true, dailyBudgetUsd: 0, typicalTurnMs: 0, toolStrip: true, turnSummary: true },
  terminal: { blocks: true, pasteGuard: true, ruler: 0, editorUrl: '', images: true, portLinks: true },
  updates: { auto: true },
  notifications: { claudeFinished: true },
  session: { stayAwake: true },
  window: { closeAction: 'menubar', menuBar: true, menuBarOnly: false, menuBarTitle: 'off', hintShown: false },
  panel: { open: true, width: 300 },
  hotkey: 'Control+`',
  migrated: 0,
};

/**
 * The settings older versions had and 0.6.0 does not (the memory, its learning and exports, the Safety edges, the saved screen, Resume,
 * the login agent). A config file keeps them (the store keeps any key it does not know) until the first start's clean-up prunes them
 * with `pruneDeadKeys`. `claude.skipped` is a live setting and is not one of them.
 */
export const DEAD_KEYS = ['memory', 'ingest', 'export', 'safety', 'session.restoreScreen', 'session.resumeClaude', 'session.keepRunning', 'session.autoResume'] as const;

/** `raw` (a config file's content) without the `DEAD_KEYS`; everything else, unknown keys included, as it was. `raw` is not changed. */
export function pruneDeadKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const key of DEAD_KEYS) {
    const [section, name] = key.split('.') as [string, string | undefined];
    const value = out[section];
    if (name === undefined) delete out[section];
    else if (isRecord(value) && name in value) {
      const rest = { ...value };
      delete rest[name];
      out[section] = rest;
    }
  }
  return out;
}

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
