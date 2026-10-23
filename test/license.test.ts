import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('licence', () => {
  it('is GPL-3.0-or-later', () => {
    expect(JSON.parse(read('package.json')).license).toBe('GPL-3.0-or-later');
    const l = read('LICENSE');
    expect(l.trimStart().startsWith('GNU GENERAL PUBLIC LICENSE')).toBe(true);
    expect(l).toContain('Version 3, 29 June 2007');
  });
  it('names espeak-ng in the third-party notices', () => {
    const n = read('THIRD-PARTY-NOTICES.md');
    expect(n).toContain('espeak-ng');
    expect(n).toContain('GPL-3.0-or-later');
  });
});
