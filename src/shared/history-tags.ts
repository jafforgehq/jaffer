import { cleanName } from './history-names';
import { isSessionId } from './session-id';

/**
 * The person's own tags for past conversations and the ones they hid (1.4.0), as the config keeps them: `history.tags` is a list of
 * `"<session id> <tag>"` (at most 3 tags a conversation, 400 entries in all), `history.hidden` a list of session ids (at most 500). A tag is
 * what the person typed, never transcript text. Read tolerantly, like the names: an entry that does not fit is skipped, and dropped at the
 * next write.
 */
export const MAX_TAG_ENTRIES = 400;
export const MAX_TAGS = 3;
export const MAX_TAG = 20;
export const MAX_HIDDEN = 500;

/** The clean-up of a name (one line, no control or format characters, whitespace collapsed), at most 20 characters; '' when nothing is left. */
export function cleanTag(tag: unknown): string {
  return Array.from(cleanName(tag)).slice(0, MAX_TAG).join('').trim();
}

/** id → its tags (each once in any case, at most 3), from the config's list (only the first 400 entries are read). */
export function parseTags(list: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(list)) return out;
  for (const e of list.slice(0, MAX_TAG_ENTRIES)) {
    if (typeof e !== 'string' || e[36] !== ' ') continue;
    const id = e.slice(0, 36);
    const tag = cleanTag(e.slice(37));
    const has = out.get(id) ?? [];
    if (!isSessionId(id) || !tag || has.length >= MAX_TAGS || has.some((t) => same(t, tag))) continue;
    out.set(id, [...has, tag]);
  }
  return out;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const format = (m: Map<string, string[]>): string[] => [...m].flatMap(([id, tags]) => tags.map((t) => `${id} ${t}`)).slice(0, MAX_TAG_ENTRIES);

export function tagsOf(list: unknown, id: string): string[] {
  return parseTags(list).get(id) ?? [];
}

/** The list with `tag` on `id` (already there in any case: unchanged); null when that conversation has 3 or the list 400; a bad id or an empty tag changes nothing. */
export function addTag(list: unknown, id: string, tag: string): string[] | null {
  const m = parseTags(list);
  const clean = cleanTag(tag);
  const has = m.get(id) ?? [];
  if (!isSessionId(id) || !clean || has.some((t) => same(t, clean))) return format(m);
  if (has.length >= MAX_TAGS || format(m).length >= MAX_TAG_ENTRIES) return null;
  m.set(id, [...has, clean]);
  return format(m);
}

export function removeTag(list: unknown, id: string, tag: string): string[] {
  const m = parseTags(list);
  const left = (m.get(id) ?? []).filter((t) => !same(t, tag));
  if (left.length) m.set(id, left);
  else m.delete(id);
  return format(m);
}

/** Without the tags of these conversations (moved to the Trash). */
export function dropTags(list: unknown, ids: Iterable<string>): string[] {
  const m = parseTags(list);
  for (const id of ids) m.delete(id);
  return format(m);
}

/** Every tag once (any case: its first spelling) with how many conversations carry it, the most used first, then by name. */
export function allTags(list: unknown): { tag: string; count: number }[] {
  const by = new Map<string, { tag: string; count: number }>();
  for (const tags of parseTags(list).values()) {
    for (const t of tags) {
      const k = t.toLowerCase();
      const f = by.get(k);
      if (f) f.count++;
      else by.set(k, { tag: t, count: 1 });
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || (a.tag.toLowerCase() < b.tag.toLowerCase() ? -1 : 1));
}

/** Which of the 6 tag colours (the theme's tokens) a tag gets: by a hash of its name, the same in any case. */
export function tagColor(tag: string): number {
  let h = 0;
  for (const ch of tag.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 6;
}

/** The hidden ids: valid, each once, at most 500. */
export function hiddenIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.slice(0, MAX_HIDDEN * 2).filter((x): x is string => typeof x === 'string' && isSessionId(x)))].slice(0, MAX_HIDDEN);
}

/** Hidden → shown, else hidden (first); null when 500 are hidden already (a bad id changes nothing). */
export function toggleHidden(list: unknown, id: string): string[] | null {
  const ids = hiddenIds(list);
  if (!isSessionId(id)) return ids;
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  return ids.length >= MAX_HIDDEN ? null : [id, ...ids];
}
