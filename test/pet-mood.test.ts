import { describe, expect, it } from 'vitest';
import { petMood } from '../src/shared/pet-mood';
import { processBadge } from '../src/shared/process-badge';

const mood = (running: string | null, claude: Parameters<typeof processBadge>[1], cheering = false) => petMood({ badge: processBadge(running, claude), claude, cheering });

describe('petMood: what the pet is doing', () => {
  it('sleeps when nothing is going on', () => {
    expect(mood(null, undefined)).toBe('sleep');
    expect(mood(null, 'ended')).toBe('sleep');
  });

  it('digs while something runs: an ordinary command, or Claude at work', () => {
    expect(mood('npm run dev', undefined)).toBe('dig');
    expect(mood(null, 'working')).toBe('dig');
    expect(mood('claude', 'working')).toBe('dig');
  });

  it('is awake but calm while Claude Code is open and idle', () => {
    expect(mood('claude', 'idle')).toBe('rest');
    expect(mood('claude', undefined)).toBe('rest'); // running, no hook report: present, not digging
    expect(mood(null, 'idle')).toBe('rest');
  });

  it('pops up when Claude needs the person, whatever else is going on', () => {
    expect(mood('claude', 'needs-you')).toBe('alert');
    expect(mood('npm test', 'needs-you')).toBe('alert');
  });

  it('cheers for a moment after a turn, but never over a request for the person', () => {
    expect(mood('claude', 'idle', true)).toBe('cheer');
    expect(mood(null, 'idle', true)).toBe('cheer');
    expect(mood('claude', 'needs-you', true)).toBe('alert');
  });
});
