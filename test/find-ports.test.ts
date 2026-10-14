import { describe, expect, it } from 'vitest';
import { findPorts } from '../src/shared/find-ports';

describe('findPorts: local servers a command says it listens on', () => {
  it('finds localhost, 127.0.0.1, 0.0.0.0 and [::1] ports, unique and in order', () => {
    expect(findPorts('  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://0.0.0.0:5173/')).toEqual([5173]);
    expect(findPorts('listening on 127.0.0.1:8080 and [::1]:3000, also localhost:8080')).toEqual([8080, 3000]);
  });

  it('reads through colours (ANSI is stripped first)', () => {
    expect(findPorts('\x1b[32mhttp://localhost:\x1b[1m4321\x1b[22m/\x1b[0m')).toEqual([4321]);
    expect(findPorts('\x1b]8;;http://x\x07localhost:9000\x1b]8;;\x07')).toEqual([9000]);
  });

  it('only 2 to 5 digits within 1..65535, and only those hosts', () => {
    expect(findPorts('localhost:8 localhost:65536 localhost:123456 localhost:65535 example.com:80 10.0.0.1:22')).toEqual([65535]);
  });

  it('reads only the first 64 KB of a chunk', () => {
    expect(findPorts('x'.repeat(64 * 1024) + 'localhost:5000')).toEqual([]);
  });

  it('never throws, and is quick on 1 MB and 8 MB chunks of any shape', () => {
    for (const v of [undefined, null, 1] as unknown[]) expect(findPorts(v as string)).toEqual([]);
    for (const size of [1 << 20, 8 << 20]) {
      for (const unit of ['localhost:', '\x1b[', '\x1b]', 'localhost:1', ':9', '[::1]']) {
        const big = unit.repeat(Math.ceil(size / unit.length));
        const t0 = performance.now();
        findPorts(big);
        expect(performance.now() - t0, `${JSON.stringify(unit)} x ${size}`).toBeLessThan(200);
      }
    }
  });
});
