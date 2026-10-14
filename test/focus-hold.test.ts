import { describe, expect, it } from 'vitest';
import { FocusHold } from '../src/shared/focus-hold';

describe('FocusHold: what a focus session holds back, and the one sentence when it ends (pure)', () => {
  it('holds nothing while it is not active, and says nothing', () => {
    const f = new FocusHold();
    expect(f.active).toBe(false);
    expect(f.hold('finished')).toBe(false); // (not held: the caller shows it)
    expect(f.release()).toBeNull();
  });

  it('holds while active and counts by kind; release says what was held and starts over', () => {
    const f = new FocusHold();
    f.start();
    expect(f.active).toBe(true);
    expect(f.hold('finished')).toBe(true);
    expect(f.hold('finished')).toBe(true);
    expect(f.hold('needs-you')).toBe(true);
    expect(f.hold('failed')).toBe(true);
    expect(f.release()).toBe('While you were focused: Claude finished 2 times, Claude needed you once, 1 command failed');
    expect(f.active).toBe(false);
    expect(f.hold('finished')).toBe(false);
    expect(f.release()).toBeNull();
    f.start(); // a new session starts from nothing
    expect(f.release()).toBeNull();
  });

  it('each kind in words, singular and plural, in a fixed order', () => {
    const f = new FocusHold();
    f.start();
    for (const k of ['terminal', 'command', 'command', 'command', 'failed', 'failed', 'needs-you', 'needs-you', 'needs-you', 'finished'] as const) f.hold(k);
    expect(f.release()).toBe('While you were focused: Claude finished once, Claude needed you 3 times, 3 commands finished, 2 commands failed, 1 terminal notification');
  });

  it('start() twice does not forget what was held, and an unknown kind is not counted', () => {
    const f = new FocusHold();
    f.start();
    f.hold('finished');
    f.start();
    expect(f.hold('bogus' as never)).toBe(true); // (still held, but it has no words)
    expect(f.release()).toBe('While you were focused: Claude finished once');
    f.start();
    f.hold('bogus' as never);
    expect(f.release()).toBeNull();
  });
});
