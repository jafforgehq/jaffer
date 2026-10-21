/** Pure helpers for the terminals' labels and order (1.5.0). Memory only: nothing here touches disk or a shell. */

const LABEL_MAX = 24;
const INPUT_MAX = 200;

/** A terminal's label as typed: no control or format characters, spaces collapsed, at most 24 characters. '' means no label. */
export function cleanPaneLabel(raw: string): string {
  const head = String(raw).slice(0, INPUT_MAX); // (bounded before any regex work)
  const t = head.replace(/[\p{Cf}\u115F\u1160\u2800\u3164\uFFA0]/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim(); // (a line break or tab is a space; a format character, such as a right-to-left mark, and the fillers that draw nothing are gone)
  const out = [...t].slice(0, LABEL_MAX).join('').trim();
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(out) ? out : ''; // (only marks or selectors: nothing to see, so no label)
}

/** Moves `id` to the place `to` holds. A copy of `list`, unchanged when either is unknown or they are the same. */
export function reorderPanes(list: string[], id: string, to: string): string[] {
  const from = list.indexOf(id);
  const at = list.indexOf(to);
  if (from < 0 || at < 0 || from === at) return [...list];
  const out = list.filter((p) => p !== id);
  out.splice(at, 0, id);
  return out;
}

/** One step up (-1) or down (1); unchanged at the ends or for an unknown id. */
export function movePane(list: string[], id: string, dir: -1 | 1): string[] {
  const i = list.indexOf(id);
  const j = i + dir;
  return i < 0 || j < 0 || j >= list.length ? [...list] : reorderPanes(list, id, list[j]!);
}

/** The terminals "close idle" would end: not the focused one, not a busy one. At least one always stays. */
export function idleToClose(list: string[], focused: string, busy: (id: string) => boolean): string[] {
  const keep = list.includes(focused) ? focused : list[0];
  return list.filter((id) => id !== keep && !busy(id));
}

/** The first terminal the daemon holds: the first of `main, p2, p3, p4` that is open (the daemon's own order, not the window's, which the person can reorder). */
export function firstPaneId(list: readonly string[]): string {
  return ['main', 'p2', 'p3', 'p4'].find((id) => list.includes(id)) ?? 'main';
}
