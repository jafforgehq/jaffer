import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { updaterLog } from '../src/main/updater-log';

describe('updaterLog', () => {
  it('appends timestamped lines, never throws, and starts over instead of growing without bound', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-log-'));
    const file = path.join(dir, 'updater.log');
    const log = updaterLog(file, 200);
    log('first');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT.* first\n$/);
    for (let i = 0; i < 30; i++) log(`line ${i} ${'x'.repeat(20)}`);
    expect(fs.statSync(file).size).toBeLessThan(400);
    expect(fs.readFileSync(file, 'utf8')).toContain('line 29');
    expect(() => updaterLog(path.join(dir, 'missing', 'deep', 'x.log'))('nope')).not.toThrow();
  });
});
