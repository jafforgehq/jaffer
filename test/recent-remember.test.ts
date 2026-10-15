import { describe, expect, it } from 'vitest';
import { commands, remember } from '../src/renderer/state';

describe('remember: ⌘R keeps the folder a command ended in (1.2.0, memory only)', () => {
  it('keeps the folder, redacted and clipped to 4096; a missing or odd one is no folder', () => {
    commands.value = [];
    remember({ cmd: 'echo a', exit: 0, at: 1, durMs: 1, cwd: '/Users/maya/code' });
    expect(commands.value[0]).toEqual({ cmd: 'echo a', exit: 0, at: 1, durMs: 1, cwd: '/Users/maya/code' });
    remember({ cmd: 'echo b', exit: 0, at: 2, durMs: 1, cwd: '/tmp/ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(commands.value[0]!.cwd).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    remember({ cmd: 'echo c', exit: 0, at: 3, durMs: 1, cwd: `/${'d'.repeat(8 << 20)}` });
    expect(commands.value[0]!.cwd!.length).toBeLessThanOrEqual(4096);
    remember({ cmd: 'echo d', exit: 0, at: 4, durMs: 1, cwd: 42 as unknown as string });
    expect(commands.value[0]!.cwd).toBeUndefined();
    remember({ cmd: 'echo e', exit: 0, at: 5, durMs: 1 });
    expect(commands.value[0]!.cwd).toBeUndefined();
  });

  it('a sensitive command is still never kept, folder or not', () => {
    commands.value = [];
    remember({ cmd: 'cat ~/.ssh/id_rsa', exit: 0, at: 1, durMs: 1, cwd: '/Users/maya' });
    expect(commands.value).toEqual([]);
  });
});
