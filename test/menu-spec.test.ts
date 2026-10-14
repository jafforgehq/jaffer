import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU_ITEMS, TOGGLE_FULLSCREEN } from '../src/shared/menu-spec';

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/actions.ts'), 'utf8');
/** The palette actions' ids, and the keys of the key-bound ones (read from the source: actions.ts needs a DOM to be imported). */
const actions = [...source.matchAll(/\{ id: '([^']+)'[^\n]*/g)].map((m) => ({ id: m[1]!, keys: /keys: '([^']+)'/.exec(m[0])?.[1] }));
const keyed = actions.filter((a): a is { id: string; keys: string } => !!a.keys);

const ACCEL: Record<string, string> = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Cmd', '↑': 'Up', '↓': 'Down' };
/** `⇧⌘G` as Electron spells it: `Shift+Cmd+G`. */
const accel = (keys: string): string => {
  const mods = [...keys].filter((c) => '⌃⌥⇧⌘'.includes(c)).map((c) => ACCEL[c]!);
  const key = [...keys].filter((c) => !'⌃⌥⇧⌘'.includes(c)).join('');
  return [...mods, ACCEL[key] ?? key].join('+');
};

describe('the menu and the palette agree', () => {
  it('every menu item runs an action that exists (the palette itself is the one special id)', () => {
    const ids = new Set(actions.map((a) => a.id));
    expect(ids.size).toBeGreaterThan(15);
    for (const id of Object.keys(MENU_ITEMS)) expect(ids.has(id) || id === 'palette', `menu id ${id}`).toBe(true);
  });

  it('every key-bound action is in the menu with the same keys, and the other way round', () => {
    expect(keyed.length).toBeGreaterThan(10);
    for (const a of keyed) expect(MENU_ITEMS[a.id]?.accelerator, `menu accelerator of ${a.id}`).toBe(accel(a.keys));
    for (const [id, item] of Object.entries(MENU_ITEMS)) if (item.accelerator && id !== 'palette') expect(keyed.some((a) => a.id === id), `${id} has keys in the palette`).toBe(true);
  });

  it('the new keys are all there: prompts ⌘↑ ⌘↓, recent commands ⌘R, find again ⌘G ⇧⌘G, Copy as Markdown ⌥⌘C, pin ⇧⌘L, focus mode ⌥⌘F', () => {
    const accelOf = (id: string) => MENU_ITEMS[id]?.accelerator;
    expect([accelOf('prompt-prev'), accelOf('prompt-next'), accelOf('recent-commands'), accelOf('find-next'), accelOf('find-prev'), accelOf('copy-markdown'), accelOf('pin-selection'), accelOf('focus-mode')]).toEqual([
      'Cmd+Up', 'Cmd+Down', 'Cmd+R', 'Cmd+G', 'Shift+Cmd+G', 'Alt+Cmd+C', 'Shift+Cmd+L', 'Alt+Cmd+F',
    ]);
  });

  it('no accelerator is used twice, and none takes ⌃⌘F (Full Screen) or ⌘Q', () => {
    const all = [...Object.values(MENU_ITEMS).map((i) => i.accelerator), 'Cmd+Q', TOGGLE_FULLSCREEN].filter(Boolean);
    expect(all.length).toBeGreaterThan(15);
    expect(all.filter((a, i) => all.indexOf(a) !== i)).toEqual([]);
    expect(TOGGLE_FULLSCREEN).toBe('Ctrl+Cmd+F');
  });
});
