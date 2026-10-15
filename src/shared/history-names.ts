import { isSessionId } from './session-id';

/**
 * The person's own names for past conversations and the ones they pinned (1.2.0), as the config keeps them: `history.names` is a list of
 * `"<session id> <name>"` (newest first), `history.pinned` a list of session ids. A name is what the person typed, never transcript text.
 * Read tolerantly: a hand-edited entry that does not fit is skipped, and dropped at the next write.
 */
export const MAX_NAMES = 200;
export const MAX_NAME = 80;
export const MAX_PINNED = 50;

/** One line without control or format characters, whitespace collapsed, at most 80 characters; '' when nothing is left. */
export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const one = name
    .slice(0, 4096) // (bounded: a name is 80 characters, a config file may hold anything)
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(one).slice(0, MAX_NAME).join('').trim();
}

/** id → name, from the config's list (the first entry of an id wins; only the first 200 entries are read: a real list never has more). */
export function parseNames(list: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(list)) return out;
  for (const e of list.slice(0, MAX_NAMES)) {
    if (typeof e !== 'string' || e[36] !== ' ') continue;
    const id = e.slice(0, 36);
    const name = cleanName(e.slice(37));
    if (isSessionId(id) && name && !out.has(id)) out.set(id, name);
  }
  return out;
}

const format = (m: Map<string, string>): string[] => [...m].slice(0, MAX_NAMES).map(([id, name]) => `${id} ${name}`);

/** The list with `name` for `id`, first; an empty name removes it; a bad id changes nothing. */
export function setName(list: unknown, id: string, name: string): string[] {
  const m = parseNames(list);
  if (!isSessionId(id)) return format(m);
  m.delete(id);
  const clean = cleanName(name);
  return format(clean ? new Map([[id, clean], ...m]) : m);
}

export function removeName(list: unknown, id: string): string[] {
  return setName(list, id, '');
}

/** The pinned ids: valid, each once, at most 50. */
export function pinnedIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.slice(0, MAX_PINNED * 2).filter((x): x is string => typeof x === 'string' && isSessionId(x)))].slice(0, MAX_PINNED);
}

/** Pinned → unpinned, else pinned first; null when 50 are pinned already (a bad id changes nothing). */
export function togglePin(list: unknown, id: string): string[] | null {
  const ids = pinnedIds(list);
  if (!isSessionId(id)) return ids;
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  return ids.length >= MAX_PINNED ? null : [id, ...ids];
}
