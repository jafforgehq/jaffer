import { describe, expect, it } from 'vitest';
import { shouldRecheckAuth } from '../src/shared/auth-recheck';

describe('shouldRecheckAuth', () => {
  it('looks again whenever the user comes back while signed out (they may have just signed in)', () => {
    expect(shouldRecheckAuth(false, 99_000, 100_000)).toBe(true);
  });
  it('rechecks a known sign-in at most once a minute', () => {
    expect(shouldRecheckAuth(true, 100_000 - 59_999, 100_000)).toBe(false);
    expect(shouldRecheckAuth(true, 100_000 - 60_000, 100_000)).toBe(true);
  });
  it('checks when nothing is known yet', () => {
    expect(shouldRecheckAuth(null, 0, 100_000)).toBe(true);
  });
});
