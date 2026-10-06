export type MemoryKind =
  | 'preference' // how the user likes things done
  | 'convention' // how a codebase/team does things
  | 'fact' // durable facts about the user, machine or projects
  | 'workflow' // commands / procedures that work
  | 'lesson' // mistakes to avoid, fixes that were needed
  | 'project' // what a project is / its current focus
  | 'environment'; // OS, tools, paths

export const MEMORY_KINDS: MemoryKind[] = ['preference', 'convention', 'fact', 'workflow', 'lesson', 'project', 'environment'];

/** "global" or "project:<absolute path>" */
export type MemoryScope = string;

export type MemorySource = 'user' | 'agent' | 'reflector' | 'heuristic' | 'ingest' | 'consolidator';
export type MemoryStatus = 'active' | 'archived' | 'superseded';

export interface MemoryItem {
  id: string;
  /** Stable identity for items derived by deterministic rules so re-runs update instead of duplicating. */
  key?: string;
  kind: MemoryKind;
  scope: MemoryScope;
  text: string;
  tags: string[];
  /** 0..1 — how sure we are this is true and still useful. */
  confidence: number;
  /** Independent observations backing the item. */
  evidence: number;
  /** Times the item was surfaced to an agent and recalled on purpose. */
  uses: number;
  /** Times the item was contradicted or corrected. */
  contradictions: number;
  pinned: boolean;
  status: MemoryStatus;
  supersededBy?: string;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface SkillItem {
  id: string;
  key?: string;
  name: string;
  description: string;
  whenToUse: string;
  steps: string[];
  scope: MemoryScope;
  confidence: number;
  evidence: number;
  uses: number;
  pinned: boolean;
  status: MemoryStatus;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

// ---------------------------------------------------------------- episodes

export interface BaseEpisode {
  seq: number;
  id: string;
  ts: string;
  cwd?: string;
  /** Resolved project root (git toplevel) when known. */
  project?: string;
}

export interface CommandEpisode extends BaseEpisode {
  t: 'cmd';
  cmd: string;
  exit: number | null;
  durMs?: number;
  branch?: string;
  /** Redacted tail of output; only kept for failed commands and agent-run commands. */
  out?: string;
  by?: 'user' | 'agent';
}

export interface AgentTurnEpisode extends BaseEpisode {
  t: 'agent';
  user: string;
  reply: string;
  tools: string[];
  /** The user pushed back on the previous turn ("no, use pnpm"). */
  correction?: boolean;
  error?: string;
}

export interface ExternalAgentEpisode extends BaseEpisode {
  t: 'ext';
  agent: string;
  role: 'user' | 'assistant';
  text: string;
  correction?: boolean;
}

export interface NoteEpisode extends BaseEpisode {
  t: 'note';
  text: string;
}

export type Episode = CommandEpisode | AgentTurnEpisode | ExternalAgentEpisode | NoteEpisode;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EpisodeInput = DistributiveOmit<Episode, 'seq' | 'id' | 'ts'> & { ts?: string };

// ---------------------------------------------------------------- journal

export type JournalOp = 'add' | 'update' | 'reinforce' | 'contradict' | 'archive' | 'restore' | 'delete' | 'pin' | 'merge' | 'skill-add' | 'skill-update' | 'skill-archive';

export interface JournalEntry {
  ts: string;
  runId: string;
  op: JournalOp;
  target: 'item' | 'skill';
  id: string;
  before: unknown | null;
  after: unknown | null;
  reason?: string;
  source: MemorySource;
}

// ---------------------------------------------------------------- ops proposed by reflectors

export type ProposedOp =
  | { op: 'add'; kind: MemoryKind; scope: MemoryScope; text: string; tags?: string[]; confidence?: number; why?: string; key?: string; source?: MemorySource }
  | { op: 'reinforce'; id: string; why?: string }
  | { op: 'update'; id: string; text: string; why?: string }
  | { op: 'merge'; ids: string[]; text: string; kind?: MemoryKind; scope?: MemoryScope; why?: string }
  | { op: 'contradict'; id: string; why?: string }
  | { op: 'forget'; id: string; why?: string }
  | { op: 'skill'; name: string; description: string; whenToUse: string; steps: string[]; scope?: MemoryScope; key?: string; why?: string; confidence?: number };

export interface ReflectionResult {
  runId: string;
  ts: string;
  mode: 'heuristic' | 'llm' | 'both' | 'consolidate';
  episodes: number;
  applied: number;
  skipped: number;
  added: number;
  updated: number;
  reinforced: number;
  archived: number;
  skills: number;
  summary: string;
  error?: string;
}

export interface MemoryStats {
  active: number;
  archived: number;
  pinned: number;
  skills: number;
  episodesPending: number;
  lastReflection?: ReflectionResult;
  lastConsolidation?: string;
}
