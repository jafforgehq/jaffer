import type { MemoryStore, RunCtx } from './store';
import { similarity } from './text';
import { strength } from './ranking';
import type { MemoryItem } from './types';

export interface ConsolidationCounts {
  merged: number;
  archived: number;
  capped: number;
}

export const CAPS = { perScope: 60, global: 160 };

/**
 * "Sleep" pass: merge near-duplicates, let faded memories go, and enforce size caps so the
 * always-injected memory stays small and sharp. Entirely deterministic and offline.
 */
export function consolidateHeuristic(store: MemoryStore, run: RunCtx): ConsolidationCounts {
  const counts: ConsolidationCounts = { merged: 0, archived: 0, capped: 0 };
  const now = store.now();

  // 1. merge near-duplicates within a scope
  const active = store.listItems();
  const consumed = new Set<string>();
  const byScope = new Map<string, MemoryItem[]>();
  for (const i of active) byScope.set(i.scope, [...(byScope.get(i.scope) ?? []), i]);
  for (const items of byScope.values()) {
    const sorted = [...items].sort((a, b) => strength(b, now) - strength(a, now));
    for (const base of sorted) {
      if (consumed.has(base.id)) continue;
      const cluster = [base];
      for (const other of sorted) {
        if (other.id === base.id || consumed.has(other.id)) continue;
        if (base.key && other.key && base.key !== other.key) continue; // distinct rule-derived facts stay distinct
        if (similarity(base.text, other.text) >= 0.62) cluster.push(other);
      }
      if (cluster.length < 2) continue;
      for (const c of cluster) consumed.add(c.id);
      // The strongest wording wins; pinned/user-authored text is preferred.
      const winner = cluster.find((c) => c.pinned) ?? cluster.find((c) => c.source === 'user') ?? cluster[0]!;
      if (store.merge(run, cluster.map((c) => c.id), winner.text)) counts.merged += cluster.length - 1;
    }
  }

  // 2. let faded memories go (never pinned)
  for (const i of store.fadedItems()) {
    if (store.archive(run, i.id)) counts.archived++;
  }

  // 3. size caps — archive the weakest beyond the cap
  const post = store.listItems();
  const perScope = new Map<string, MemoryItem[]>();
  for (const i of post) perScope.set(i.scope, [...(perScope.get(i.scope) ?? []), i]);
  for (const items of perScope.values()) {
    const sorted = items.filter((i) => !i.pinned).sort((a, b) => strength(a, now) - strength(b, now));
    const over = items.length - CAPS.perScope;
    for (let k = 0; k < over && k < sorted.length; k++) if (store.archive(run, sorted[k]!.id)) counts.capped++;
  }
  const globalOver = store.listItems().length - CAPS.global;
  if (globalOver > 0) {
    const weakest = store
      .listItems()
      .filter((i) => !i.pinned)
      .sort((a, b) => strength(a, now) - strength(b, now))
      .slice(0, globalOver);
    for (const i of weakest) if (store.archive(run, i.id)) counts.capped++;
  }
  store.flush();
  return counts;
}
