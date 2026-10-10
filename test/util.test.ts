import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Emitter } from '../src/shared/emitter';
import { makePaths, resolveHome } from '../src/shared/paths';
import { errMsg, ensureDir, readJson, writeFileAtomic, writeJson } from '../src/shared/util';
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

  it('ensureDir is happy with a folder that is already there', () => {
    ensureDir(f('x'));
    expect(() => ensureDir(f('x'))).not.toThrow();
  });
});

describe('writeFileAtomic', () => {
  it('can follow a link and keep the mode of a file that is already there', () => {
    const real = path.join(env.root, 'real.txt');
    const link = path.join(env.root, 'link.txt');
    fs.writeFileSync(real, 'a', { mode: 0o640 });
    fs.symlinkSync(real, link);
    writeFileAtomic(link, 'b', 0o600, { preserve: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('b');
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
    // without the option, Jaffer’s own files are written as asked
    writeFileAtomic(real, 'c', 0o600);
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    // and a file that is not there yet gets the mode asked for
    writeFileAtomic(path.join(env.root, 'new.txt'), 'x', 0o644, { preserve: true });
    expect(fs.statSync(path.join(env.root, 'new.txt')).mode & 0o777).toBe(0o644);
  });
});

describe('errors', () => {
  it('errMsg gives a message for anything thrown', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
    expect(errMsg('plain')).toBe('plain');
    expect(errMsg(42)).toBe('42');
    expect(errMsg(null)).toBe('null');
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
