import type { MemoryStore, RunCtx } from './store';
import type { MemoryKind, ProposedOp } from './types';
import { MEMORY_KINDS } from './types';

export interface ApplyCounts {
  applied: number;
  skipped: number;
  added: number;
  updated: number;
  reinforced: number;
  archived: number;
  skills: number;
}

export function emptyCounts(): ApplyCounts {
  return { applied: 0, skipped: 0, added: 0, updated: 0, reinforced: 0, archived: 0, skills: 0 };
}

function validScope(s: string | undefined): string {
  if (!s) return 'global';
  return s === 'global' || (s.startsWith('project:') && s.length > 9) ? s : 'global';
}

function validKind(k: string | undefined, fallback: MemoryKind = 'fact'): MemoryKind {
  return MEMORY_KINDS.includes(k as MemoryKind) ? (k as MemoryKind) : fallback;
}

/**
 * Apply proposed operations through the store's guard rails: unknown ids are skipped,
 * pinned items are only ever reinforced by automated sources, and a hard cap bounds
 * how much a single reflection can change.
 */
export function applyOps(store: MemoryStore, run: RunCtx, ops: ProposedOp[], opts: { maxOps?: number } = {}): ApplyCounts {
  const counts = emptyCounts();
  const max = opts.maxOps ?? 24;
  const automated = run.source !== 'user';
  for (const op of ops.slice(0, max)) {
    const ctx: RunCtx = { ...run, source: ('source' in op && op.source) || run.source, reason: ('why' in op && op.why) || run.reason };
    let ok = false;
    switch (op.op) {
      case 'add': {
        const existed = !!op.key && !!store.findByKey(op.key); // a rule re-run that changes its own item updates it, it does not add one
        const r = op.key
          ? store.upsertByKey(ctx, op.key, { kind: validKind(op.kind), scope: validScope(op.scope), text: op.text, tags: op.tags, confidence: op.confidence })
          : store.add(ctx, { kind: validKind(op.kind), scope: validScope(op.scope), text: op.text, tags: op.tags, confidence: op.confidence });
        if (r?.unchanged) break; // a rule saw its own item again: nothing to do, nothing to count
        if (r) {
          ok = true;
          if (r.deduped) counts.reinforced++;
          else if (existed) counts.updated++;
          else counts.added++;
        }
        break;
      }
      case 'reinforce': {
        ok = !!store.reinforce(ctx, op.id);
        if (ok) counts.reinforced++;
        break;
      }
      case 'update': {
        const cur = store.getItem(op.id);
        if (cur && !(cur.pinned && automated)) {
          ok = !!store.update(ctx, op.id, { text: op.text });
          if (ok) counts.updated++;
        }
        break;
      }
      case 'merge': {
        const parts = [...new Set(op.ids)].map((id) => store.getItem(id));
        // one scope only: merging a project's note with a global one would move the project's note into every project
        const oneScope = new Set(parts.map((p) => p?.scope)).size === 1;
        if (parts.length >= 2 && oneScope && parts.every((p) => p && !(p.pinned && automated))) {
          ok = !!store.merge(ctx, [...new Set(op.ids)], op.text, { kind: op.kind ? validKind(op.kind) : undefined, scope: op.scope ? validScope(op.scope) : undefined });
          if (ok) counts.updated++;
        }
        break;
      }
      case 'contradict': {
        const cur = store.getItem(op.id);
        if (cur && !cur.pinned) {
          ok = !!store.contradict(ctx, op.id);
          if (ok) counts.updated++;
        }
        break;
      }
      case 'forget': {
        const cur = store.getItem(op.id);
        if (cur && !(cur.pinned && automated)) {
          ok = !!store.archive(ctx, op.id);
          if (ok) counts.archived++;
        }
        break;
      }
      case 'skill': {
        const s = store.addSkill(ctx, {
          name: op.name,
          description: op.description,
          whenToUse: op.whenToUse,
          steps: op.steps,
          scope: validScope(op.scope),
          confidence: op.confidence,
          key: op.key,
        });
        ok = !!s;
        if (ok) counts.skills++;
        break;
      }
    }
    if (ok) counts.applied++;
    else counts.skipped++;
  }
  counts.skipped += Math.max(0, ops.length - max);
  store.flush();
  return counts;
}
