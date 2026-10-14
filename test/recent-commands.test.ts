import { describe, expect, it } from 'vitest';
import { RecentCommands } from '../src/shared/recent-commands';
import { COMMAND_HEAD } from '../src/shared/process-badge';

describe('RecentCommands: the menu bar’s last five commands (memory only)', () => {
  it('keeps the newest five, newest first, and a command run again moves to the top once', () => {
    const r = new RecentCommands();
    for (const c of ['ls', 'pwd', 'git status', 'npm test', 'make', 'echo hi']) r.add(c);
    expect(r.list().map((c) => c.raw)).toEqual(['echo hi', 'make', 'npm test', 'git status', 'pwd']);
    r.add('make');
    r.add('make');
    expect(r.list().map((c) => c.raw)).toEqual(['make', 'echo hi', 'npm test', 'git status', 'pwd']);
  });

  it('leaves out empty and sensitive commands, and one longer than a command’s head', () => {
    const r = new RecentCommands();
    r.add('');
    r.add('   ');
    r.add(' secret-with-leading-space');
    r.add('cat ~/.ssh/id_rsa');
    r.add('printenv');
    r.add('x'.repeat(4 * COMMAND_HEAD + 1));
    expect(r.list()).toEqual([]);
  });

  it('labels are redacted, on one line and clipped to 60; the raw text is what is copied', () => {
    const r = new RecentCommands();
    const raw = 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" https://example.com';
    r.add(raw);
    r.add(`echo one\necho two ${'y'.repeat(100)}`);
    const [multi, curl] = r.list();
    expect(curl!.raw).toBe(raw);
    expect(curl!.label).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(curl!.label.length).toBeLessThanOrEqual(60);
    expect(multi!.label).not.toMatch(/\n/);
    expect(multi!.label.length).toBe(60);
    expect(multi!.label.endsWith('…')).toBe(true);
  });

  it('a long forged command line is handled at once', () => {
    const r = new RecentCommands();
    const t = performance.now();
    for (const n of [1 << 20, 8 << 20]) r.add('a'.repeat(n));
    r.add(`echo ${'b'.repeat(4 * COMMAND_HEAD - 10)}`);
    expect(performance.now() - t).toBeLessThan(1_000);
    expect(r.list()).toHaveLength(1);
  });
});
