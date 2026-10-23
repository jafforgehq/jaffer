import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertVoiceDir } from '../src/main/voice-models';

describe('assertVoiceDir (the only folder removeVoice may be pointed at)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  const userHome = path.join(root, 'home');
  const jh = path.join(userHome, '.jaffer');
  fs.mkdirSync(jh, { recursive: true });
  it('accepts <jaffer home>/voice', () => expect(assertVoiceDir(path.join(jh, 'voice'), userHome)).toBe(path.join(jh, 'voice')));
  it('refuses another name, the home itself, the user home, root and a non-Jaffer parent', () => {
    for (const d of [jh, path.join(jh, 'voices'), path.join(jh, 'a', 'voice'), userHome, path.join(userHome, 'voice'), '/', '/voice', path.join(root, 'proj', 'voice')]) {
      expect(() => assertVoiceDir(d, userHome), d).toThrow();
    }
  });
  it('refuses a parent that holds a code checkout', () => {
    const p = path.join(root, 'jaffer-code');
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'package.json'), '{}');
    expect(() => assertVoiceDir(path.join(p, 'voice'), userHome)).toThrow();
  });
});
