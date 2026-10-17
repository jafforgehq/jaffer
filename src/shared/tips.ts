/**
 * (1.4.0) First-time tips: the first time a concept comes up, a quiet toast asks "What is …?" with Explain (its glossary entry) and Turn
 * tips off. Each tip shows once ever (`tips.seen`), at most one in `TIP_GAP_MS`, none while first run or the tour is up, none with
 * `tips.enabled` off. Pure.
 */
export const TIPS = {
  compaction: { glossary: 'compaction', text: 'Claude is making room in its context. What is compaction?' },
  subagent: { glossary: 'subagent', text: 'Claude started a helper. What is a subagent?' },
  permission: { glossary: 'permission-prompt', text: 'Claude Code is asking before it acts. What is a permission prompt?' },
  context: { glossary: 'context-window', text: 'The context is 80% full. What is the context window?' },
  longturn: { glossary: 'turn', text: 'That turn took over 5 minutes. What is a turn?' },
  budget: { glossary: 'cost-estimate', text: 'What is a cost estimate?' },
} as const;
export type TipId = keyof typeof TIPS;

export const TIP_GAP_MS = 90_000;

/** Whether tip `id` may show now: tips on, not seen before, no tip in the last 90 s (`lastAt`), nothing else on screen (`busy`). */
export function shouldTip(id: TipId, tips: { enabled: boolean; seen: string[] } | undefined, at: { now: number; lastAt: number; busy: boolean }): boolean {
  return Object.hasOwn(TIPS, id) && tips?.enabled === true && !tips.seen.includes(id) && !at.busy && at.now - at.lastAt >= TIP_GAP_MS;
}
