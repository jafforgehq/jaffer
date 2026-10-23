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
  // SECURITY.md: "The licence text and the third-party notices ship with the app (`LICENSE`, `THIRD-PARTY-NOTICES.md`)"
  it('ships LICENSE and THIRD-PARTY-NOTICES.md in the app (electron-builder extraResources)', () => {
    const y = read('electron-builder.yml');
    for (const f of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) expect(y, f).toMatch(new RegExp(`\\n  - from: ${f.replace(/\./g, '\\.')}\\n    to: ${f.replace(/\./g, '\\.')}\\n`));
    expect(read('SECURITY.md')).toContain('ship with the app (`LICENSE`, `THIRD-PARTY-NOTICES.md`)');
  });
  it('names espeak-ng in the third-party notices', () => {
    const n = read('THIRD-PARTY-NOTICES.md');
    expect(n).toContain('espeak-ng');
    expect(n).toContain('GPL-3.0-or-later');
  });
});
