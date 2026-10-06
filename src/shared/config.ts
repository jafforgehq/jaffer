import type { JafferPaths } from './paths';
import { Emitter, readJson, writeJson } from './util';

export type ApprovalMode = 'ask' | 'auto-read' | 'auto';

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
  };
  shell: { path: string; args: string[] };
  agent: {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    approvals: ApprovalMode;
    /** "session": agent commands run visibly in your shell; "subprocess": isolated child process. */
    runIn: 'session' | 'subprocess';
    maxToolRounds: number;
    refusalFallback: boolean;
    /** Compact the thread when it exceeds this many (estimated) tokens. */
    compactAtTokens: number;
  };
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
  export: { targets: ('claude-code' | 'codex' | 'gemini')[]; claudeSkills: boolean };
  ingest: { claudeCode: boolean; codex: boolean; backfillDays: number };
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
  },
  shell: { path: '', args: [] },
  agent: {
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    approvals: 'ask',
    runIn: 'session',
    maxToolRounds: 40,
    refusalFallback: true,
    compactAtTokens: 140_000,
  },
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
  ingest: { claudeCode: false, codex: false, backfillDays: 7 },
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

export class ConfigStore {
  readonly onChange = new Emitter<JafferConfig>();
  private cfg: JafferConfig;

  constructor(private paths: JafferPaths) {
    this.cfg = merge(DEFAULT_CONFIG, readJson<unknown>(paths.config, {}));
  }

  get(): JafferConfig {
    return this.cfg;
  }

  patch(p: DeepPartial<JafferConfig>): JafferConfig {
    this.cfg = merge(this.cfg, p);
    writeJson(this.paths.config, this.cfg);
    this.onChange.emit(this.cfg);
    return this.cfg;
  }

  reload(): void {
    this.cfg = merge(DEFAULT_CONFIG, readJson<unknown>(this.paths.config, {}));
    this.onChange.emit(this.cfg);
  }
}
