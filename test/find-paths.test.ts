import { describe, expect, it } from 'vitest';
import { findPaths } from '../src/shared/find-paths';

const paths = (line: string) => findPaths(line).map((m) => [m.path, m.line, m.col]);

describe('findPaths: file paths printed in a terminal line', () => {
  it('finds absolute, home, ./ and ../ paths, and dir/file.ext or file.ext with an extension', () => {
    expect(paths('see /usr/local/bin/node and ~/code/app/README.md')).toEqual([
      ['/usr/local/bin/node', undefined, undefined],
      ['~/code/app/README.md', undefined, undefined],
    ]);
    expect(paths('./build.sh ../lib/x.ts src/main/main.ts package.json')).toEqual([
      ['./build.sh', undefined, undefined],
      ['../lib/x.ts', undefined, undefined],
      ['src/main/main.ts', undefined, undefined],
      ['package.json', undefined, undefined],
    ]);
  });

  it('reads :line and :line:col, and the match covers them', () => {
    const line = 'error in src/app.ts:12:3: missing ;';
    const [m] = findPaths(line);
    expect(m).toMatchObject({ path: 'src/app.ts', line: 12, col: 3 });
    expect(line.slice(m!.start, m!.end)).toBe('src/app.ts:12:3');
    expect(findPaths('at /a/b.js:7')).toEqual([{ start: 3, end: 12, path: '/a/b.js', line: 7 }]);
    expect(findPaths('    at fn (/srv/app/index.js:10:5)')[0]).toMatchObject({ path: '/srv/app/index.js', line: 10, col: 5 });
  });

  it('strips trailing punctuation and quotes', () => {
    const line = 'wrote "out/report.txt". Then (lib/a.rb), [x/y.go]; done: /tmp/z.log,';
    expect(paths(line).map((p) => p[0])).toEqual(['out/report.txt', 'lib/a.rb', 'x/y.go', '/tmp/z.log']);
    for (const m of findPaths(line)) expect(line.slice(m.start, m.end)).toBe(m.path);
  });

  it('never inside a URL, and not words, numbers, versions or a lone slash', () => {
    expect(paths('open https://example.com/a/b.html or file:///etc/hosts')).toEqual([]);
    expect(paths('and/or 1/2 50/50 v1.2.3 3.14 / // a: b ./ ~/')).toEqual([]);
    expect(paths('git@github.com:org/repo.git')).toEqual([]);
  });

  it('keeps an extension of 1 to 8 letters or digits, with at least one letter', () => {
    expect(paths('a.c b.toolongext c.12 d.mp4')).toEqual([
      ['a.c', undefined, undefined],
      ['d.mp4', undefined, undefined],
    ]);
  });

  it('returns at most 20 and reads only the first 4096 characters', () => {
    expect(findPaths(Array.from({ length: 50 }, (_, i) => `f${i}.ts`).join(' '))).toHaveLength(20);
    expect(findPaths('x'.repeat(4096) + ' /etc/hosts')).toEqual([]);
  });

  it('never throws, and is quick on 1 MB and 8 MB lines of any shape', () => {
    for (const v of [undefined, null, 42, {}] as unknown[]) expect(findPaths(v as string)).toEqual([]);
    for (const size of [1 << 20, 8 << 20]) {
      for (const unit of ['a', 'a/', './', 'a.', ':1', '/a:', 'a.b ', '~/']) {
        const big = unit.repeat(Math.ceil(size / unit.length));
        const t0 = performance.now();
        findPaths(big);
        expect(performance.now() - t0, `${unit} x ${size}`).toBeLessThan(200);
      }
    }
  });
});
