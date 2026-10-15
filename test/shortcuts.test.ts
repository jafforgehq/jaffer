import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU_ITEMS } from '../src/shared/menu-spec';
import { TERMINAL_KEYS, filterShortcuts, keysOf, shortcutGroups } from '../src/shared/shortcuts';

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/actions.ts'), 'utf8');
/** The palette actions (read from the source: actions.ts needs a DOM to be imported). */
const actions = [...source.matchAll(/\{ id: '([^']+)'[^\n]*/g)].map((m) => ({
  id: m[1]!,
  title: /title: '([^']+)'/.exec(m[0])?.[1] ?? m[1]!,
  section: /section: '([^']+)'/.exec(m[0])?.[1] ?? '',
  keys: /keys: '([^']+)'/.exec(m[0])?.[1],
}));

describe('the shortcuts sheet (⌘/, 1.2.0)', () => {
  it('keysOf spells an accelerator the way the palette does', () => {
    expect(keysOf('Shift+Cmd+G')).toBe('⇧⌘G');
    expect(keysOf('Alt+Cmd+C')).toBe('⌥⌘C');
    expect(keysOf('Cmd+Up')).toBe('⌘↑');
    expect(keysOf('Cmd+/')).toBe('⌘/');
    expect(keysOf('Cmd+P')).toBe('⌘P');
  });

  it('lists every key-bound action, the menu’s keys that are no action (the palette) and the terminal’s own keys, each once, by section', () => {
    const groups = shortcutGroups(actions);
    const all = groups.flatMap((g) => g.items);
    for (const a of actions.filter((x) => x.keys)) expect(all.some((i) => i.keys === a.keys && i.title === a.title), `${a.id} listed`).toBe(true);
    expect(all.find((i) => i.keys === '⌘P')?.title).toBe('Command Palette');
    for (const k of TERMINAL_KEYS) expect(groups.find((g) => g.section === 'Terminal')!.items).toContainEqual(k);
    const keys = all.map((i) => i.keys);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    expect(keys).toContain('⌘/');
    // the palette's section order; no empty section
    expect(groups.map((g) => g.section)).toEqual(['View', 'Terminal', 'App']);
    for (const [id, item] of Object.entries(MENU_ITEMS)) if (item.accelerator) expect(keys, id).toContain(keysOf(item.accelerator));
  });

  it('the terminal keys are the ones its key handler has', () => {
    const view = fs.readFileSync(path.join(__dirname, '../src/renderer/components/TerminalView.tsx'), 'utf8');
    expect(TERMINAL_KEYS.map((k) => k.keys)).toEqual(['⌘←', '⌘→', '⌘⌫', '⇧↵']);
    for (const key of ["'ArrowLeft'", "'ArrowRight'", "'Backspace'", "'Enter' && ev.shiftKey"]) expect(view).toContain(key);
  });

  it('search filters by title, keys or section and drops empty sections', () => {
    const groups = shortcutGroups(actions);
    expect(filterShortcuts(groups, '').length).toBe(groups.length);
    const find = filterShortcuts(groups, 'FIND');
    expect(find.flatMap((g) => g.items.map((i) => i.title))).toEqual(['Find in terminal', 'Find next', 'Find previous']);
    expect(filterShortcuts(groups, '⌘/').flatMap((g) => g.items.map((i) => i.title))).toEqual(['Keyboard shortcuts']);
    expect(filterShortcuts(groups, 'view').map((g) => g.section)).toEqual(['View']);
    expect(filterShortcuts(groups, 'zzzz')).toEqual([]);
  });
});
