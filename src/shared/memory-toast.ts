import type { ReflectionResult } from '../core/memory/types';

export interface MemoryToast {
  text: string;
  undo: { kind: 'forget'; id: string } | { kind: 'revert'; runId: string };
}

/**
 * Which memory events are worth a notification on top of the person's terminal. The memory engine reviews activity all the time,
 * and most of what it does is housekeeping (a known fact seen again, nothing new to read, old things fading): that stays in the
 * Memory panel's Activity log. A toast is for something new it learned, or something the person asked it to remember.
 */
export function memoryToast(e: { type: string; result?: ReflectionResult; items?: { id: string; text: string }[] }): MemoryToast | null {
  if (e.type === 'learned') {
    const it = e.items?.[0];
    return it ? { text: `Remembered: ${it.text}`, undo: { kind: 'forget', id: it.id } } : null;
  }
  if (e.type === 'reflection' && e.result && e.result.mode !== 'consolidate') {
    const n = e.result.added + e.result.updated;
    if (n <= 0) return null;
    return { text: n === 1 ? 'Jaffer learned something new' : `Jaffer learned ${n} new things`, undo: { kind: 'revert', runId: e.result.runId } };
  }
  return null;
}
