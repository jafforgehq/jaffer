import { describe, expect, it } from 'vitest';
import { shortToolPath } from '../src/shared/short-path';

describe('shortToolPath', () => {
  it('shows a file inside the working directory relative to it', () => {
    expect(shortToolPath('/work/app/src/auth/session.ts', '/work/app')).toBe('src/auth/session.ts');
    expect(shortToolPath('/work/app/src/a.ts', '/work/app/')).toBe('src/a.ts');
  });

  it('keeps a short path outside the working directory as it is', () => {
    expect(shortToolPath('/etc/hosts', '/work/app')).toBe('/etc/hosts');
  });

  it('abbreviates a long path outside the working directory but keeps the file name visible', () => {
    expect(shortToolPath('/Users/someone/Library/Application Support/Some App/profiles/main/settings.json', '/work/app')).toBe('…/profiles/main/settings.json');
  });

  it('does not treat a sibling directory with the same prefix as inside the working directory', () => {
    expect(shortToolPath('/work/application/a.ts', '/work/app')).toBe('/work/application/a.ts');
  });

  it('leaves anything that is not a path, and an empty cwd, alone', () => {
    expect(shortToolPath('npm test', '/work/app')).toBe('npm test');
    expect(shortToolPath('', '/work/app')).toBe('');
    expect(shortToolPath('/work/app/src/a.ts', '')).toBe('/work/app/src/a.ts');
  });
});
