import { describe, expect, it } from 'vitest';
import { isDozing, petMood, petTool } from '../src/shared/pet-mood';
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

describe('petTool: what kind of work the companion shows', () => {
  const at = (state: 'working' | 'idle' | 'needs-you' | 'ended', name?: string) => ({ state, tool: name ? { name, id: 't1' } : undefined });

  it('is the category of the tool Claude is running', () => {
    expect(petTool(at('working', 'Bash'))).toBe('shell');
    expect(petTool(at('working', 'Read'))).toBe('read');
    expect(petTool(at('working', 'Edit'))).toBe('write');
    expect(petTool(at('working', 'WebFetch'))).toBe('web');
    expect(petTool(at('working', 'Task'))).toBe('agent');
    expect(petTool(at('working', 'mcp__x__y'))).toBe('other');
  });

  it('is none without a session, without a tool, or when Claude is not working', () => {
    expect(petTool(null)).toBeNull();
    expect(petTool(undefined)).toBeNull();
    expect(petTool(at('working'))).toBeNull();
    expect(petTool(at('idle', 'Bash'))).toBeNull();
    expect(petTool(at('needs-you', 'Bash'))).toBeNull();
    expect(petTool(at('ended', 'Bash'))).toBeNull();
  });
});

describe('isDozing: the companion dozes after ten minutes of nothing', () => {
  it('dozes at ten minutes, not before', () => {
    expect(isDozing(0, 599_999)).toBe(false);
    expect(isDozing(0, 600_000)).toBe(true);
    expect(isDozing(1_000, 1_000 + 3_600_000)).toBe(true);
  });
  it('takes another delay', () => {
    expect(isDozing(0, 5_000, 5_000)).toBe(true);
    expect(isDozing(0, 4_999, 5_000)).toBe(false);
  });
  it('a clock that went backwards (or odd numbers) does not doze', () => {
    expect(isDozing(10_000, 5_000)).toBe(false);
    expect(isDozing(Number.NaN, 1e12)).toBe(false);
  });
});
