import { describe, expect, it } from 'vitest';
import { twoRunning } from '../src/shared/one-claude';

const s = (id: string, state = 'idle') => ({ id, state });

describe('twoRunning: tell the person once when a second Claude conversation runs, never end anything', () => {
  it('says nothing for none, or for one conversation', () => {
    expect(twoRunning([], new Set())).toBeNull();
    expect(twoRunning([s('a')], new Set())).toBeNull();
    expect(twoRunning([s('a', 'working')], new Set())).toBeNull();
  });

  it('gives a key for two that are active: the ids, sorted and joined by +', () => {
    expect(twoRunning([s('a'), s('b')], new Set())).toBe('a+b');
  });

  it('counts idle, working and needs-you alike', () => {
    expect(twoRunning([s('a', 'idle'), s('b', 'working')], new Set())).toBe('a+b');
    expect(twoRunning([s('a', 'needs-you'), s('b', 'idle')], new Set())).toBe('a+b');
    expect(twoRunning([s('a', 'working'), s('b', 'needs-you')], new Set())).toBe('a+b');
  });

  it('says nothing the second time for the same two: a key already told is not given again', () => {
    expect(twoRunning([s('a'), s('b')], new Set(['a+b']))).toBeNull();
    // and it does not remember by itself: the caller keeps the set
    const told = new Set<string>();
    expect(twoRunning([s('a'), s('b')], told)).toBe('a+b');
    expect(told.size).toBe(0);
  });

  it('does not count a conversation that has ended', () => {
    expect(twoRunning([s('a'), s('b', 'ended')], new Set())).toBeNull();
    expect(twoRunning([s('a', 'ended'), s('b', 'ended')], new Set())).toBeNull();
    // the ended one is not in the key either
    expect(twoRunning([s('a'), s('b', 'ended'), s('c', 'working')], new Set())).toBe('a+c');
  });

  it('gives one key for three, with all three in it', () => {
    expect(twoRunning([s('a'), s('b'), s('c')], new Set())).toBe('a+b+c');
    // two of them told earlier is a different set, so it is told
    expect(twoRunning([s('a'), s('b'), s('c')], new Set(['a+b']))).toBe('a+b+c');
  });

  it('sorts the ids, so the order they arrive in does not matter', () => {
    expect(twoRunning([s('b'), s('a')], new Set())).toBe('a+b');
    expect(twoRunning([s('c'), s('a'), s('b')], new Set())).toBe('a+b+c');
    expect(twoRunning([s('b'), s('a')], new Set(['a+b']))).toBeNull();
  });

  it('a pair that changes (one leaves, another comes) is a new set; the pair seen before is not told again', () => {
    const told = new Set(['a+b']);
    expect(twoRunning([s('a'), s('c')], told)).toBe('a+c');
    expect(twoRunning([s('a'), s('b')], told)).toBeNull();
  });

  it('one conversation listed twice is still one', () => {
    expect(twoRunning([s('a'), s('a', 'working')], new Set())).toBeNull();
  });

  it('only reads the sessions: nothing is changed in them', () => {
    const sessions = [s('b'), s('a'), s('c', 'ended')];
    const copy = JSON.parse(JSON.stringify(sessions));
    twoRunning(sessions, new Set());
    expect(sessions).toEqual(copy);
  });
});
