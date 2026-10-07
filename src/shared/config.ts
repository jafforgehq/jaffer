import type { JafferPaths } from './paths';
import { Emitter, readJson, writeJson } from './util';

/** ask: reads are automatic, everything that changes state needs approval. auto: only risky actions ask. */

export interface JafferConfig {
  /** First-run consent flow completed. Until then nothing is exported and no model is called. */
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
    /** A little mole in a corner of the terminal that digs while something runs. */
    pet: boolean;
  };
  shell: { path: string; args: string[] };
  memory: {
    enabled: boolean;
    /** "auto": use a model to curate memory when credentials exist. "off": offline heuristics only. */
    llm: 'auto' | 'off';
    reflectorModel: string;
    reflectEveryN: number;
    idleSeconds: number;
    llmMinIntervalSec: number;
    retentionDays: number;
  };
  export: { targets: 'claude-code'[]; claudeSkills: boolean };
  ingest: { claudeCode: boolean; backfillDays: number };
  /** The person chose a plain terminal at first run. Claude stays on offer (Settings → Claude Code), nothing about it nags; connecting it clears this. */
  claude: { skipped: boolean };
  /** Jaffer asks before updating itself; this only controls whether it looks in the background. */
  updates: { auto: boolean };
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
  },
  shell: { path: '', args: [] },
  memory: {
    enabled: true,
    llm: 'auto',
    reflectorModel: 'claude-haiku-4-5',
    reflectEveryN: 20,
    idleSeconds: 90,
    llmMinIntervalSec: 300,
    retentionDays: 45,
  },
  export: { targets: [], claudeSkills: false },
  ingest: { claudeCode: false, backfillDays: 7 },
  claude: { skipped: false },
  updates: { auto: true },
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

/** Jaffer is for Claude Code only. Targets saved by earlier builds for other agents are dropped when a config is loaded. */
function supported(cfg: JafferConfig): JafferConfig {
  return { ...cfg, export: { ...cfg.export, targets: cfg.export.targets.filter((t) => t === 'claude-code') } };
}

export class ConfigStore {
  readonly onChange = new Emitter<JafferConfig>();
  private cfg: JafferConfig;

  constructor(private paths: JafferPaths) {
    this.cfg = supported(merge(DEFAULT_CONFIG, readJson<unknown>(paths.config, {})));
  }

  get(): JafferConfig {
    return this.cfg;
  }

  patch(p: DeepPartial<JafferConfig>): JafferConfig {
    this.cfg = supported(merge(this.cfg, p));
    writeJson(this.paths.config, this.cfg);
    this.onChange.emit(this.cfg);
    return this.cfg;
  }

  reload(): void {
    this.cfg = supported(merge(DEFAULT_CONFIG, readJson<unknown>(this.paths.config, {})));
    this.onChange.emit(this.cfg);
  }
}
