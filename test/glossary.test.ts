import { describe, expect, it } from 'vitest';
import { GLOSSARY, glossaryEntry, searchGlossary } from '../src/shared/glossary';

describe('the glossary (1.4.0)', () => {
  it('has at least 16 entries with unique lowercase-dash ids, a title, a short line of at most 220 characters and more of at most 700', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(16);
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of GLOSSARY) {
      expect(e.id, e.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(e.title.trim(), e.id).not.toBe('');
      expect(e.short.trim().length, e.id).toBeGreaterThan(20);
      expect(e.more.trim().length, e.id).toBeGreaterThan(20);
      expect(e.short.length, e.id).toBeLessThanOrEqual(220);
      expect(e.more.length, e.id).toBeLessThanOrEqual(700);
    }
  });

  it('names the words a newcomer to Claude Code meets, and the Jaffer ones', () => {
    for (const id of ['session', 'model', 'context-window', 'compaction', 'token', 'cost-estimate', 'subagent', 'hook', 'mcp', 'skill', 'rules', 'permission-prompt', 'plan-mode', 'transcript', 'companion', 'side-panel', 'split-terminals', 'resume']) {
      expect(glossaryEntry(id)?.id, id).toBe(id);
    }
    expect(glossaryEntry('nope')).toBeUndefined();
    // the cost entry says it is an estimate and that a subscription is not billed per token
    expect(glossaryEntry('cost-estimate')!.short).toMatch(/estimate/i);
    expect(`${glossaryEntry('cost-estimate')!.short} ${glossaryEntry('cost-estimate')!.more}`).toMatch(/not billed per token/i);
  });

  it('says no more than is true: hooks may answer a permission prompt (after a click), Claude Code asks when its rules do not already allow, a plan is for approval, compaction by itself only with auto-compact', () => {
    const all = (id: string) => `${glossaryEntry(id)!.short} ${glossaryEntry(id)!.more}`;
    expect(all('hook')).not.toMatch(/change nothing/i);
    expect(all('hook')).toMatch(/allow or deny after your click/i);
    expect(glossaryEntry('permission-prompt')!.short).toMatch(/rules don't already allow/i);
    expect(glossaryEntry('permission-prompt')!.short).not.toMatch(/before (it|Claude) acts/i);
    expect(all('plan-mode')).toMatch(/for your approval/i);
    expect(glossaryEntry('context-window')!.more).toMatch(/while auto-compact is on/i);
    expect(glossaryEntry('compaction')!.more).toMatch(/auto-compact/i);
  });

  it('search: a case-insensitive substring of the title, the short line or more; empty is everything; a long query is cut, not scanned', () => {
    expect(searchGlossary('')).toEqual(GLOSSARY);
    expect(searchGlossary('   ')).toEqual(GLOSSARY);
    expect(searchGlossary('COMPACT').map((e) => e.id)).toContain('compaction');
    expect(searchGlossary('jsonl').map((e) => e.id)).toContain('transcript'); // (in its text, not its title)
    expect(searchGlossary('zzzz-no-such-word')).toEqual([]);
    const t0 = Date.now();
    expect(searchGlossary('a'.repeat(8_000_000))).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
