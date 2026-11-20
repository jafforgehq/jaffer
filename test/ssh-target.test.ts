import { describe, expect, it } from 'vitest';
import { sshTarget } from '../src/shared/ssh-target';

describe('sshTarget', () => {
  it('is null for anything that is not an ssh connection', () => {
    for (const c of [null, undefined, '', 'ls', 'sshfs a b', 'echo ssh host', 'ssh', 'ssh -V', 'ssh -p', 'cat ~/.ssh/config']) expect(sshTarget(c as never), String(c)).toBeNull();
  });

  it('finds a host after options, with or without a user, and a path to ssh', () => {
    for (const c of ['ssh box', 'ssh me@box', 'ssh -i ~/.ssh/k -p 2200 me@box', '/usr/bin/ssh -o StrictHostKeyChecking=no box ls -la', 'FOO=1 ssh -J jump box', 'ssh -v -A box'])
      expect(sshTarget(c), c).toEqual({ prod: false });
  });

  it('knows a production-looking host and gives nothing else away', () => {
    for (const c of ['ssh prod', 'ssh me@api.prod.example.com', 'ssh web-prod-1', 'ssh live_db', 'ssh PRD-3']) expect(sshTarget(c), c).toEqual({ prod: true });
    for (const c of ['ssh produce', 'ssh reprod', 'ssh delivery']) expect(sshTarget(c), c).toEqual({ prod: false });
    expect(Object.keys(sshTarget('ssh me@prod')!)).toEqual(['prod']);
  });

  it('reads only the head of a very long command', () => {
    const t0 = Date.now();
    expect(sshTarget('ssh ' + 'x'.repeat(8_000_000))).toEqual({ prod: false });
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
