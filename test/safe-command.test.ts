import { describe, expect, it } from 'vitest';
import { safeCommand } from '../src/renderer/state';
import { COMMAND_HEAD } from '../src/shared/process-badge';

describe('safeCommand: what the window may show of a command', () => {
  it('redacts secrets and hides a sensitive command', () => {
    expect(safeCommand('cat ~/.ssh/id_rsa')).toBe('(hidden)');
    expect(safeCommand('ls -la')).toBe('ls -la');
  });

  it('reads only the head of a forged 8 MB command: quick, no throw, nothing longer than the head', () => {
    const big = 'echo ' + 'a=b; '.repeat(8 * 1024 * 1024 / 5);
    const t0 = performance.now();
    const out = safeCommand(big);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(4 * COMMAND_HEAD);
  });
});
