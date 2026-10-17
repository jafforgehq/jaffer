import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from '../src/shared/tour';
import { glossaryEntry } from '../src/shared/glossary';

/** Every `data-tour` mark the renderer's components set (a literal, the InfoButton's `tour`, or a literal in an expression). */
const dir = path.join(__dirname, '../src/renderer/components');
const marks = new Set(
  fs.readdirSync(dir).flatMap((f) =>
    [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/data-tour="([a-z-]+)"|\btour="([a-z-]+)"|data-tour=\{([^}\n]*)\}/g)].flatMap((m) => (m[3] !== undefined ? [...m[3].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!) : [m[1] ?? m[2]!])),
  ),
);

describe('the tour (1.4.0)', () => {
  it('has the eight steps in order, each with a unique id, a target the window marks, a title and one to three sentences', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(['terminal', 'now', 'conversations', 'palette', 'split', 'setup', 'privacy', 'learn']);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const s of TOUR_STEPS) {
      expect(marks.has(s.target), `data-tour="${s.target}" for ${s.id}`).toBe(true);
      expect(s.title.trim(), s.id).not.toBe('');
      const sentences = s.text.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length, s.id).toBeGreaterThanOrEqual(1);
      expect(sentences.length, s.id).toBeLessThanOrEqual(3);
    }
  });

  it('Try it only where an action exists: the palette, a split, Settings; the privacy step says what each switch does in one line', () => {
    expect(TOUR_STEPS.filter((s) => s.action).map((s) => [s.id, s.action!.run])).toEqual([
      ['palette', 'palette'],
      ['split', 'split-terminal'],
      ['privacy', 'settings'],
    ]);
    const privacy = TOUR_STEPS.find((s) => s.id === 'privacy')!;
    expect(privacy.lines).toHaveLength(5);
    for (const l of privacy.lines!) expect(l.split(/(?<=[.!?])\s+/).filter(Boolean)).toHaveLength(1);
    expect(TOUR_STEPS.find((s) => s.id === 'split')!.text).toMatch(/⇧⌘W/);
    // the Setup step says it reads files, and that the MCP check starts the servers
    expect(TOUR_STEPS.find((s) => s.id === 'setup')!.text).toMatch(/read from its files/i);
    expect(TOUR_STEPS.find((s) => s.id === 'setup')!.text).toMatch(/Check MCP servers starts your servers briefly/);
    // what a step needs made visible first: the panel for its sections, Setup expanded, Settings open
    expect(Object.fromEntries(TOUR_STEPS.filter((s) => s.needs).map((s) => [s.id, s.needs]))).toEqual({ now: 'panel', conversations: 'panel', setup: 'setup', privacy: 'settings', learn: 'panel' });
    for (const s of TOUR_STEPS) if (s.glossary) expect(glossaryEntry(s.glossary), s.id).toBeDefined();
  });
});
