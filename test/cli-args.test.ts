import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args';

const parse = (line: string) => parseArgs(line.split(' '));
const flags = (line: string) => Object.fromEntries(parse(line).flags);

describe('parseArgs', () => {
  it('takes the plain words after the command, in order, without the command itself', () => {
    expect(parse('remember Always run the linter').positional).toEqual(['Always', 'run', 'the', 'linter']);
    expect(parse('status').positional).toEqual([]);
  });

  it('reads --name value, --name=value, and a bare --name', () => {
    expect(flags('remember x --kind convention')).toEqual({ kind: 'convention' });
    expect(flags('remember x --kind=convention')).toEqual({ kind: 'convention' });
    expect(flags('context --query pnpm --budget=4000')).toEqual({ query: 'pnpm', budget: '4000' });
    expect(flags('remember x --kind')).toEqual({ kind: 'true' });
    expect(flags('remember --kind --pin x')).toEqual({ kind: 'true', pin: 'true' });
    expect(flags('x --a=b=c')).toEqual({ a: 'b=c' }); // only the first = splits
  });

  it('a switch never swallows the word after it: --pin, --project, --remove, --yes, --delete, --all', () => {
    const p = parse('remember --pin Always use pnpm here');
    expect(p.flags.get('pin')).toBe('true');
    expect(p.positional).toEqual(['Always', 'use', 'pnpm', 'here']);
    expect(parse('remember Always use pnpm --project').positional).toEqual(['Always', 'use', 'pnpm']);
    expect(parse('remember --project Use vitest here --kind convention').positional).toEqual(['Use', 'vitest', 'here']);
    expect(parse('memory list --all').flags.get('all')).toBe('true');
    expect(parse('reset --yes --delete').positional).toEqual([]);
    expect(flags('reset --yes --delete')).toEqual({ yes: 'true', delete: 'true' });
  });

  it('a value flag takes its value out of the plain words', () => {
    expect(parse('remember --kind lesson Never force push').positional).toEqual(['Never', 'force', 'push']);
    expect(flags('remember --kind lesson Never force push')).toEqual({ kind: 'lesson' });
  });

  it('after -- everything is plain text, dashes and all', () => {
    const p = parse('remember --pin -- --not-a-flag and more');
    expect(p.positional).toEqual(['--not-a-flag', 'and', 'more']);
    expect(p.flags.get('pin')).toBe('true');
    expect(parse('remember --').positional).toEqual([]);
  });

  it('single dashes and words with dashes are plain text', () => {
    expect(parse('remember use -p for ports and a-b-c').positional).toEqual(['use', '-p', 'for', 'ports', 'and', 'a-b-c']);
  });

  it('copes with nothing at all', () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: new Map() });
    expect(parseArgs(['remember'])).toEqual({ positional: [], flags: new Map() });
  });
});
