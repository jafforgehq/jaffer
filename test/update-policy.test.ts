import { describe, expect, it } from 'vitest';
import { cleanVersion, isNewer, manualResult, promptText, shouldAsk, signerKind } from '../src/shared/update-policy';

describe('cleanVersion', () => {
  it('accepts release versions and rejects anything else', () => {
    expect(cleanVersion('0.2.0')).toBe('0.2.0');
    expect(cleanVersion('1.10.3-beta.2')).toBe('1.10.3-beta.2');
    expect(cleanVersion('v0.2.0')).toBeNull();
    expect(cleanVersion('0.2.0<script>')).toBeNull();
    expect(cleanVersion('')).toBeNull();
    expect(cleanVersion(42)).toBeNull();
    expect(cleanVersion(undefined)).toBeNull();
  });
});

describe('promptText', () => {
  it('names the version, offers Update and restart or Later, and says what restarting costs', () => {
    const t = promptText({ version: '0.2.0', claudeBusy: false });
    expect(t.message).toContain('0.2.0');
    expect(t.buttons).toEqual(['Update and restart', 'Later']);
    expect(t.detail).toMatch(/ends your terminal session/i);
    expect(t.detail).toMatch(/memory is kept/i);
    expect(t.detail).not.toMatch(/claude is working/i);
  });
  it('warns when Claude is working or waiting right now', () => {
    const t = promptText({ version: '0.2.0', claudeBusy: true });
    expect(t.detail).toMatch(/claude is working/i);
  });
});

describe('shouldAsk', () => {
  it('always asks after a manual check', () => {
    expect(shouldAsk({ manual: true, declined: '0.2.0', version: '0.2.0' })).toBe(true);
  });
  it('does not nag about a version the user already put off', () => {
    expect(shouldAsk({ manual: false, declined: '0.2.0', version: '0.2.0' })).toBe(false);
  });
  it('asks about a newer version, and when nothing was declined', () => {
    expect(shouldAsk({ manual: false, declined: '0.2.0', version: '0.2.1' })).toBe(true);
    expect(shouldAsk({ manual: false, declined: null, version: '0.2.0' })).toBe(true);
  });
});

describe('signerKind', () => {
  it('recognises a Developer ID signature', () => {
    const out = 'Executable=/Applications/Jaffer.app/Contents/MacOS/Jaffer\nIdentifier=com.jafforge.jaffer\nAuthority=Developer ID Application: Fedja H (R9QFVTDHY5)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=R9QFVTDHY5\n';
    expect(signerKind(out)).toBe('developer-id');
  });
  it('tells ad-hoc from unsigned', () => {
    expect(signerKind('Identifier=com.jafforge.jaffer\nSignature=adhoc\nTeamIdentifier=not set\n')).toBe('adhoc');
    expect(signerKind('/x/Jaffer.app: code object is not signed at all\n')).toBe('unsigned');
    expect(signerKind('')).toBe('unsigned');
    expect(signerKind('Authority=Apple Development: Someone (ABC)\n')).toBe('unsigned');
  });
});

describe('isNewer', () => {
  it('compares numerically, not as text', () => {
    expect(isNewer('0.2.0', '0.1.1')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
  });
  it('never calls a different build of the same version newer, and rejects what is not a version', () => {
    expect(isNewer('0.2.0-beta.1', '0.2.0')).toBe(false);
    expect(isNewer('nope', '0.1.1')).toBe(false);
    expect(isNewer('0.2.0', 'dev')).toBe(false);
  });
});

describe('manualResult', () => {
  const base = { current: '0.1.1', auto: true };
  it('answers every outcome of Check for Updates… in plain words', () => {
    expect(manualResult({ ...base, status: 'uptodate' })).toMatchObject({ message: 'Jaffer is up to date', releases: false });
    expect(manualResult({ ...base, status: 'uptodate' })!.detail).toContain('0.1.1');
    expect(manualResult({ ...base, status: 'downloading', version: '0.2.0' })!.message).toContain('0.2.0');
    expect(manualResult({ ...base, status: 'downloading', version: '0.2.0' })!.detail).toMatch(/ask/i);
    expect(manualResult({ ...base, status: 'unavailable' })).toMatchObject({ message: 'Updates are off in this build', releases: true });
    expect(manualResult({ ...base, status: 'error', error: 'offline' })).toMatchObject({ message: 'Could not check for updates', detail: 'offline', releases: true });
  });
  it('says nothing when the prompt itself is the answer', () => {
    expect(manualResult({ ...base, status: 'ready', version: '0.2.0' })).toBeNull();
    expect(manualResult({ ...base, status: 'checking' })).toBeNull();
    expect(manualResult({ ...base, status: 'idle' })).toBeNull();
  });
});
