import { MENU_ITEMS } from './menu-spec';

/** One line of the shortcuts sheet (⌘/). */
export interface Shortcut {
  title: string;
  keys: string;
}
export interface ShortcutGroup {
  section: string;
  items: Shortcut[];
}

/** The palette's sections, in its order (the sheet uses the same). */
export const SECTION_ORDER = ['View', 'Claude', 'Terminal', 'Integrations', 'Appearance', 'App'];

/** The keys the terminal itself handles (TerminalView's key handler): they are no menu item, and a test keeps them in step with it. */
export const TERMINAL_KEYS: Shortcut[] = [
  { title: 'Move to the start of the line', keys: '⌘←' },
  { title: 'Move to the end of the line', keys: '⌘→' },
  { title: 'Delete to the start of the line', keys: '⌘⌫' },
  { title: 'New line (Claude Code, editors)', keys: '⇧↵' },
];

const SYMBOL: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', Up: '↑', Down: '↓' };
/** `Shift+Cmd+G` as the palette spells it: `⇧⌘G`. */
export const keysOf = (accelerator: string): string =>
  accelerator
    .split('+')
    .map((p) => SYMBOL[p] ?? p)
    .join('');

/**
 * The sheet's list, from the palette actions that have keys (so it cannot drift from the palette and the menu), the menu's keys that run
 * no action (the palette itself) and the terminal's own keys, by section in the palette's order; each key once.
 */
export function shortcutGroups(actions: readonly { id: string; title: string; section: string; keys?: string }[], menu: Record<string, { label: string; accelerator?: string }> = MENU_ITEMS): ShortcutGroup[] {
  const ids = new Set(actions.map((a) => a.id));
  const all: (Shortcut & { section: string })[] = actions.filter((a) => a.keys).map((a) => ({ section: a.section, title: a.title, keys: a.keys! }));
  for (const [id, m] of Object.entries(menu)) if (m.accelerator && !ids.has(id)) all.push({ section: 'App', title: m.label.replace(/…$/, ''), keys: keysOf(m.accelerator) });
  all.push(...TERMINAL_KEYS.map((k) => ({ ...k, section: 'Terminal' })));
  const seen = new Set<string>();
  const groups: ShortcutGroup[] = [];
  for (const section of [...SECTION_ORDER, ...all.map((s) => s.section)]) {
    if (groups.some((g) => g.section === section)) continue;
    const items = all.filter((s) => s.section === section && !seen.has(s.keys) && seen.add(s.keys)).map(({ title, keys }) => ({ title, keys }));
    if (items.length) groups.push({ section, items });
  }
  return groups;
}

/** The sheet's search: a title, the keys or the section that contains the text (any case); sections left empty go. */
export function filterShortcuts(groups: ShortcutGroup[], q: string): ShortcutGroup[] {
  const t = q.trim().toLowerCase();
  if (!t) return groups;
  return groups
    .map((g) => ({ section: g.section, items: g.section.toLowerCase().includes(t) ? g.items : g.items.filter((i) => i.title.toLowerCase().includes(t) || i.keys.toLowerCase().includes(t)) }))
    .filter((g) => g.items.length);
}
