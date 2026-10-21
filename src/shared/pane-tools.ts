/** Pure helpers for the terminals' labels and order (1.5.0). Memory only: nothing here touches disk or a shell. */

const LABEL_MAX = 24;
const INPUT_MAX = 200;

/** A terminal's label as typed: no control or format characters, spaces collapsed, at most 24 characters. '' means no label. */
export function cleanPaneLabel(raw: string): string {
  const head = String(raw).slice(0, INPUT_MAX); // (bounded before any regex work)
  const t = head.replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim(); // (a line break or tab is a space; a format character, such as a right-to-left mark, is gone)
  return [...t].slice(0, LABEL_MAX).join('').trim();
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
