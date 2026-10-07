import fs from 'node:fs';
import type { MemoryEngine } from './memory/engine';
import { writeFileAtomic } from '../shared/util';
import type { MemoryItem, MemoryKind } from './memory/types';
import { MEMORY_KINDS } from './memory/types';
import { resolveProject } from './session/project';

/**
 * The memory operations every surface shares (daemon RPC, CLI fallback, MCP server).
 * A plain table of async functions so "local" and "over the socket" are interchangeable.
 */
export type MemoryApi = Record<string, (params: any) => Promise<unknown>>;

function projectScope(cwd: string | undefined): string {
  const root = resolveProject(cwd).root;
  return root ? `project:${root}` : 'global';
}

export function view(i: MemoryItem) {
  return { id: i.id, kind: i.kind, scope: i.scope, text: i.text, confidence: Number(i.confidence.toFixed(2)), evidence: i.evidence, uses: i.uses, pinned: i.pinned, status: i.status, source: i.source, updatedAt: i.updatedAt, lastSeenAt: i.lastSeenAt };
}

export function makeMemoryApi(engine: MemoryEngine): MemoryApi {
  return {
    'memory.context': async (p: { cwd?: string; query?: string; budget?: number }) => engine.context({ cwd: p.cwd, query: p.query, budgetChars: p.budget ?? 4500 }).text,

    'memory.recall': async (p: { query: string; cwd?: string; limit?: number }) => {
      const r = engine.recall(p.query ?? '', { cwd: p.cwd, limit: p.limit ?? 8 });
      return { items: r.items.map((i) => ({ ...view(i), score: Number(i.score.toFixed(3)) })), skills: r.skills.map((s) => ({ id: s.id, name: s.name, whenToUse: s.whenToUse, steps: s.steps, scope: s.scope })) };
    },

    'memory.remember': async (p: { text: string; kind?: string; scope?: string; cwd?: string; source?: 'user' | 'agent'; pinned?: boolean }) => {
      const scope = p.scope === 'project' ? projectScope(p.cwd) : p.scope && (p.scope === 'global' || p.scope.startsWith('project:')) ? p.scope : 'global';
      const r = engine.remember(p.text, { kind: MEMORY_KINDS.includes(p.kind as MemoryKind) ? (p.kind as MemoryKind) : undefined, scope, source: p.source ?? 'user', pinned: p.pinned });
      if ('error' in r) throw new Error(r.error);
      return { item: view(r.item), deduped: r.deduped };
    },

    'memory.forget': async (p: { id: string }) => ({ archived: engine.forget(p.id).archived.map(view) }),

    'memory.list': async (p: { status?: 'active' | 'archived' | 'all'; scope?: string; kind?: MemoryKind }) => ({
      items: engine.store.listItems({ status: p.status ?? 'active', scope: p.scope, kind: p.kind }).map(view),
      skills: engine.store.listSkills().map((s) => ({ id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse, steps: s.steps, scope: s.scope, confidence: s.confidence, evidence: s.evidence, uses: s.uses, pinned: s.pinned })),
    }),

    'memory.update': async (p: { id: string; text?: string; kind?: MemoryKind; scope?: string }) => {
      const run = engine.store.newRun('user', 'edited by user');
      const it = engine.store.update(run, p.id, { text: p.text, kind: p.kind, scope: p.scope });
      engine.store.flush();
      engine.refreshViews();
      if (!it) throw new Error('Could not update that memory.');
      return view(it);
    },

    'memory.pin': async (p: { id: string; pinned: boolean }) => {
      const it = engine.store.pin(engine.store.newRun('user', 'pin'), p.id, p.pinned);
      engine.store.flush();
      engine.refreshViews();
      if (!it) throw new Error('No such memory.');
      return view(it);
    },

    'memory.notes.get': async () => {
      try {
        return { text: fs.readFileSync(engine.store.paths.memoryNotes, 'utf8') };
      } catch {
        return { text: '' };
      }
    },

    'memory.notes.set': async (p: { text: string }) => {
      writeFileAtomic(engine.store.paths.memoryNotes, String(p.text ?? '').slice(0, 20_000), 0o600);
      return { ok: true };
    },

    'memory.reflect': async (p: { force?: boolean }) => engine.reflect({ force: p.force ?? true }),
    'memory.consolidate': async () => engine.consolidate(),
    'memory.stats': async () => engine.stats(),

    'memory.log': async (p: { limit?: number }) => {
      const entries = engine.store.readJournal(p.limit ?? 100);
      // A reflection run can mix sources (offline rules + model curation); label it by the most meaningful one.
      const rank = ['user', 'reflector', 'consolidator', 'agent', 'heuristic', 'ingest'];
      const runs = new Map<string, { runId: string; ts: string; source: string; sources: string[]; reason?: string; ops: { op: string; id: string; text?: string }[] }>();
      for (const e of entries) {
        const after = (e.after ?? e.before) as { text?: string; name?: string } | null;
        const r = runs.get(e.runId) ?? { runId: e.runId, ts: e.ts, source: e.source, sources: [], reason: e.reason, ops: [] };
        if (!r.sources.includes(e.source)) r.sources.push(e.source);
        r.source = [...r.sources].sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0]!;
        r.ops.push({ op: e.op, id: e.id, text: after?.text ?? after?.name });
        runs.set(e.runId, r);
      }
      return { runs: [...runs.values()].reverse() };
    },

    'memory.revert': async (p: { runId: string }) => {
      const n = engine.store.revertRun(p.runId);
      engine.refreshViews();
      return { reverted: n };
    },
  };
}
