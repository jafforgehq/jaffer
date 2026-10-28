import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeVoiceLeftovers } from '../src/core/voice-leftovers';

let userHome: string;
let home: string;
beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
  home = path.join(userHome, 'x-jaffer');
  fs.mkdirSync(home);
});
afterEach(() => fs.rmSync(userHome, { recursive: true, force: true }));

describe('removeVoiceLeftovers (voice mode was removed in 1.6.2)', () => {
  it('deletes the model folder and the two voice keys, and keeps every other setting', () => {
    fs.mkdirSync(path.join(home, 'voice'));
    fs.writeFileSync(path.join(home, 'voice', 'model.onnx'), 'x');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onboarded: true, voice: { speed: 1 }, permissions: { voice: true, trash: false } }));
    removeVoiceLeftovers(home, userHome);
    expect(fs.existsSync(path.join(home, 'voice'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).toEqual({ onboarded: true, permissions: { trash: false } });
  });

  it('removes a link named voice, never what it points at', () => {
    const target = path.join(userHome, 'precious');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'f'), 'keep');
    fs.writeFileSync(path.join(home, 'config.json'), '{}');
    fs.symlinkSync(target, path.join(home, 'voice'));
    removeVoiceLeftovers(home, userHome);
    expect(fs.existsSync(path.join(home, 'voice'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'f'), 'utf8')).toBe('keep');
  });

  it('does nothing, and does not write the config, when there is nothing to remove', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, '{"onboarded":true}');
    const before = fs.statSync(file).mtimeMs;
    removeVoiceLeftovers(home, userHome);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"onboarded":true}');
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('touches nothing in a folder that is not clearly Jaffer\'s', () => {
    const other = path.join(userHome, 'documents');
    fs.mkdirSync(path.join(other, 'voice'), { recursive: true });
    removeVoiceLeftovers(other, userHome);
    expect(fs.existsSync(path.join(other, 'voice'))).toBe(true);
  });
});
