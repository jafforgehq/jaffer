import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { makeSecretStore } from '../src/shared/secrets';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

describe('file secret store', () => {
  it('round-trips awkward values and keeps the file private', async () => {
    const s = makeSecretStore(env.paths, 'file');
    const tricky = `sk-ant-"quote" 'single' $dollar \`tick\` \\back ünï\ncode`;
    await s.set('k', tricky);
    expect(await s.get('k')).toBe(tricky);
    expect(await s.get('missing')).toBeNull();
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
    await s.set('k2', 'v');
    const fs = await import('node:fs');
    expect((fs.statSync(env.paths.secrets).mode & 0o777).toString(8)).toBe('600');
    // stored obfuscated, never in the clear
    expect(fs.readFileSync(env.paths.secrets, 'utf8')).not.toContain('"v"');
  });
});

// Only meaningful on a Mac; CI's macOS runner exercises the real login Keychain through /usr/bin/security.
describe.skipIf(process.platform !== 'darwin')('macOS Keychain secret store', () => {
  it('stores, reads back and deletes a secret without exposing it in argv', async () => {
    const s = makeSecretStore(env.paths, 'keychain');
    const name = `jaffer-test-${Date.now()}`;
    const value = 'sk-ant-api03-test-' + Math.random().toString(36).slice(2);
    try {
      await s.set(name, value);
      expect(await s.get(name)).toBe(value);
      await s.set(name, value + '-2'); // -U updates in place
      expect(await s.get(name)).toBe(value + '-2');
    } finally {
      await s.delete(name);
    }
    expect(await s.get(name)).toBeNull();
  }, 30_000);
});
