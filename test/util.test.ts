import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Emitter } from '../src/shared/emitter';
import { makePaths, resolveHome } from '../src/shared/paths';
import { appendLine, dayKey, errMsg, ensureDir, readJson, readJsonl, SerialQueue, tail, truncate, uid, writeFileAtomic, writeJson, writeJsonl } from '../src/shared/util';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

describe('Emitter', () => {
  it('tells every listener, in the order they joined, and stops telling one that left', () => {
    const e = new Emitter<number>();
    const seen: string[] = [];
    const off = e.on((v) => seen.push(`a${v}`));
    e.on((v) => seen.push(`b${v}`));
    expect(e.size).toBe(2);
    e.emit(1);
    off();
    e.emit(2);
    expect(seen).toEqual(['a1', 'b1', 'b2']);
    expect(e.size).toBe(1);
  });

  it('a listener that throws neither stops the others nor reaches the one who emitted', () => {
    const e = new Emitter<void>();
    const seen: string[] = [];
    e.on(() => {
      throw new Error('bad listener');
    });
    e.on(() => seen.push('still told'));
    expect(() => e.emit()).not.toThrow();
    expect(seen).toEqual(['still told']);
  });

  it('a listener may leave or join while it is being told, without skipping anyone', () => {
    const e = new Emitter<void>();
    const seen: string[] = [];
    const offFirst = e.on(() => {
      seen.push('first');
      offFirst();
      e.on(() => seen.push('joined late'));
    });
    e.on(() => seen.push('second'));
    e.emit();
    expect(seen).toEqual(['first', 'second']); // the late joiner waits for the next emit
    e.emit();
    expect(seen).toEqual(['first', 'second', 'second', 'joined late']);
  });
});

describe('files', () => {
  const f = (name: string) => path.join(env.root, 'data', name);

  it('writes a file whole or not at all, makes its folder private, and leaves no temp file behind', () => {
    writeFileAtomic(f('a.txt'), 'hello');
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('hello');
    expect(fs.statSync(f('a.txt')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(f('a.txt'))).mode & 0o777).toBe(0o700);
    writeFileAtomic(f('a.txt'), 'replaced');
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('replaced');
    expect(fs.readdirSync(path.dirname(f('a.txt')))).toEqual(['a.txt']);
  });

  it('reads JSON, and falls back when the file is missing or not JSON', () => {
    writeJson(f('c.json'), { a: [1, 2], b: 'x' });
    expect(readJson(f('c.json'), null)).toEqual({ a: [1, 2], b: 'x' });
    expect(fs.readFileSync(f('c.json'), 'utf8').endsWith('\n')).toBe(true);
    expect(readJson(f('missing.json'), { fallback: true })).toEqual({ fallback: true });
    fs.writeFileSync(f('broken.json'), '{"a": ');
    expect(readJson(f('broken.json'), 7)).toBe(7);
  });

  it('appends lines and reads them back, skipping a torn or corrupt line and blank ones', () => {
    appendLine(f('log.jsonl'), { n: 1 });
    appendLine(f('log.jsonl'), { n: 2 });
    fs.appendFileSync(f('log.jsonl'), '{"n": 3\n\n   \n');
    appendLine(f('log.jsonl'), { n: 4 });
    expect(readJsonl<{ n: number }>(f('log.jsonl')).map((r) => r.n)).toEqual([1, 2, 4]);
    expect(readJsonl(f('missing.jsonl'))).toEqual([]);
    expect(fs.statSync(f('log.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('rewrites a whole JSONL file, and an empty list gives an empty file', () => {
    writeJsonl(f('rows.jsonl'), [{ a: 1 }, { a: 2 }]);
    expect(fs.readFileSync(f('rows.jsonl'), 'utf8')).toBe('{"a":1}\n{"a":2}\n');
    writeJsonl(f('rows.jsonl'), []);
    expect(fs.readFileSync(f('rows.jsonl'), 'utf8')).toBe('');
  });

  it('ensureDir is happy with a folder that is already there', () => {
    ensureDir(f('x'));
    expect(() => ensureDir(f('x'))).not.toThrow();
  });
});

describe('strings, ids, days, errors', () => {
  it('truncate keeps the start and says it cut; tail keeps the end', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 10)).toBe('abcdefghij');
    expect(truncate('abcdefghijk', 10)).toBe('abcdefghi…');
    expect(truncate('abc', 0)).toBe('…');
    expect(tail('short', 10)).toBe('short');
    expect(tail('abcdefghijk', 10)).toBe('…cdefghijk');
  });

  it('ids carry their prefix and do not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uid('m')));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^m_[0-9a-f]{10}$/);
  });

  it('a day key is the UTC date', () => {
    expect(dayKey('2026-10-07T23:59:59Z')).toBe('2026-10-07');
    expect(dayKey(Date.parse('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
    expect(dayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('errMsg gives a message for anything thrown', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
    expect(errMsg('plain')).toBe('plain');
    expect(errMsg(42)).toBe('42');
    expect(errMsg(null)).toBe('null');
  });
});

describe('SerialQueue', () => {
  it('runs tasks one after another in the order given, whatever their durations', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const task = (name: string, ms: number) => q.run(async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${name}`);
      return name;
    });
    const out = await Promise.all([task('slow', 40), task('fast', 1), task('mid', 10)]);
    expect(out).toEqual(['slow', 'fast', 'mid']);
    expect(order).toEqual(['start slow', 'end slow', 'start fast', 'end fast', 'start mid', 'end mid']);
  });

  it('a failing task rejects its own caller only; the queue carries on', async () => {
    const q = new SerialQueue();
    const bad = q.run(async () => {
      throw new Error('first failed');
    });
    const good = q.run(async () => 'second ran');
    await expect(bad).rejects.toThrow('first failed');
    await expect(good).resolves.toBe('second ran');
  });
});

describe('paths', () => {
  it('JAFFER_HOME moves everything; blank or missing means ~/.jaffer', () => {
    expect(resolveHome({ JAFFER_HOME: '/tmp/elsewhere/.jaffer' })).toBe('/tmp/elsewhere/.jaffer');
    expect(resolveHome({ JAFFER_HOME: '  ' })).toMatch(/\.jaffer$/);
    expect(resolveHome({})).toMatch(/\.jaffer$/);
    expect(path.isAbsolute(resolveHome({ JAFFER_HOME: 'relative/dir' }))).toBe(true);
  });

  it('keeps every path under the home, and the socket short enough for macOS (104 bytes) in an ordinary home', () => {
    const p = makePaths('/Users/someone/.jaffer');
    for (const [key, value] of Object.entries(p)) expect(value, key).toMatch(/^\/Users\/someone\/\.jaffer/);
    expect(p.socket).toBe('/Users/someone/.jaffer/run/jafferd.sock');
    expect(Buffer.byteLength(p.socket)).toBeLessThan(104);
    expect(new Set(Object.values(p)).size).toBe(Object.keys(p).length); // no two things share a path
  });
});
