import { describe, expect, it } from 'vitest';
import { branchMatches, dangerZone, DEFAULT_PROTECTED_BRANCHES, sshHost } from '../src/shared/danger-zone';

describe('sshHost', () => {
  it('is the machine an ssh or mosh command line connects to, without the user, the port or the options', () => {
    const cases: [string, string][] = [
      ['ssh prod-db-1', 'prod-db-1'],
      ['ssh deploy@prod-db-1', 'prod-db-1'],
      ['ssh -p 2222 me@10.0.0.7', '10.0.0.7'],
      ['ssh -p2222 me@10.0.0.7', '10.0.0.7'],
      ['ssh -i ~/.ssh/work -o StrictHostKeyChecking=no -A deploy@web.example.com', 'web.example.com'],
      ['ssh -vvv -t host.example.com htop', 'host.example.com'],
      ['ssh -J jump.example.com target.internal', 'target.internal'],
      ['ssh -l admin box', 'box'],
      ['ssh ssh://me@host.example.com:2222', 'host.example.com'],
      ['ssh me@[::1]', '::1'],
      ['ssh -L 8080:localhost:80 tunnel-host', 'tunnel-host'],
      ['ssh host.example.com ls -la /var/log', 'host.example.com'],
      ['mosh me@far-away', 'far-away'],
      ['mosh --ssh="ssh -p 2222" me@far-away', 'far-away'],
      ['FOO=1 ssh prod', 'prod'],
      ['sudo ssh prod', 'prod'],
      ['command ssh prod', 'prod'],
      ['/usr/bin/ssh prod', 'prod'],
    ];
    for (const [cmd, host] of cases) expect(sshHost(cmd), cmd).toBe(host);
  });

  it('knows it is ssh even when it cannot tell where to', () => {
    expect(sshHost('ssh')).toBeNull();
    expect(sshHost('ssh -v')).toBeNull();
    expect(sshHost('ssh -p 22')).toBeNull();
  });

  it('is undefined for anything that is not ssh, even when it starts alike or mentions it', () => {
    for (const cmd of ['ls', 'ssh-keygen -t ed25519', 'ssh-add -l', 'ssh-agent', 'sshd -D', 'echo ssh prod', 'git push', 'cat ~/.ssh/config', 'sshfs host: mnt', '', 'sshpass -p x ssh host']) {
      expect(sshHost(cmd), cmd).toBeUndefined();
    }
  });

  it('keeps a long host name short', () => {
    expect(sshHost(`ssh ${'a'.repeat(200)}.example.com`)!.length).toBeLessThanOrEqual(60);
  });
});

describe('branchMatches', () => {
  it('matches a name or a pattern with * (any characters), ignoring case and surrounding space', () => {
    expect(branchMatches('main', ['main'])).toBe(true);
    expect(branchMatches('Main', [' main '])).toBe(true);
    expect(branchMatches('release/2026.10', ['release/*'])).toBe(true);
    expect(branchMatches('hotfix-login', ['hotfix*'])).toBe(true);
    expect(branchMatches('prod', ['production', 'prod'])).toBe(true);
  });

  it('does not match a name that merely contains one, or when there are no patterns, or an empty branch', () => {
    expect(branchMatches('maintenance', ['main'])).toBe(false);
    expect(branchMatches('feature/main-menu', ['main'])).toBe(false);
    expect(branchMatches('feature/login', ['release/*', 'main'])).toBe(false);
    expect(branchMatches('main', [])).toBe(false);
    expect(branchMatches('main', ['', '  '])).toBe(false);
    expect(branchMatches('', ['*'])).toBe(false);
  });

  it('treats regular-expression characters in a pattern as plain text', () => {
    expect(branchMatches('v1.0', ['v1.0'])).toBe(true);
    expect(branchMatches('v1x0', ['v1.0'])).toBe(false);
    expect(branchMatches('release(1)', ['release(1)'])).toBe(true);
    expect(() => branchMatches('x', ['(', '[', '+', '\\'])).not.toThrow();
  });

  it('is fast on a hostile pattern', () => {
    const t0 = Date.now();
    branchMatches('a'.repeat(5000) + 'b', ['*a*a*a*a*a*a*a*a*a*a*c']);
    expect(Date.now() - t0).toBeLessThan(250);
  });
});

describe('dangerZone', () => {
  const patterns = DEFAULT_PROTECTED_BRANCHES;

  it('is ssh while an ssh command runs, naming the host', () => {
    expect(dangerZone({ branch: 'feature/x', running: 'ssh deploy@prod-db-1', patterns })).toEqual({ kind: 'ssh', what: 'prod-db-1' });
    expect(dangerZone({ running: 'ssh', patterns })).toEqual({ kind: 'ssh', what: 'a remote machine' });
  });

  it('is branch on a protected branch', () => {
    expect(dangerZone({ branch: 'main', running: null, patterns })).toEqual({ kind: 'branch', what: 'main' });
    expect(dangerZone({ branch: 'production', patterns })).toEqual({ kind: 'branch', what: 'production' });
    expect(dangerZone({ branch: 'release/2.0', running: 'npm test', patterns })).toEqual({ kind: 'branch', what: 'release/2.0' });
  });

  it('ssh wins over the branch, and nothing is a calm terminal', () => {
    expect(dangerZone({ branch: 'main', running: 'ssh prod', patterns })).toEqual({ kind: 'ssh', what: 'prod' });
    expect(dangerZone({ branch: 'feature/login', running: 'npm run dev', patterns })).toBeNull();
    expect(dangerZone({ patterns })).toBeNull();
    expect(dangerZone({ branch: undefined, running: undefined, patterns })).toBeNull();
  });

  it('follows the patterns it is given: your own list, or none', () => {
    expect(dangerZone({ branch: 'main', patterns: ['production'] })).toBeNull();
    expect(dangerZone({ branch: 'staging', patterns: ['production', 'staging'] })).toEqual({ kind: 'branch', what: 'staging' });
    expect(dangerZone({ branch: 'main', patterns: [] })).toBeNull();
    expect(dangerZone({ branch: 'main', running: 'ssh prod', patterns: [] })).toEqual({ kind: 'ssh', what: 'prod' }); // ssh does not depend on branches
  });

  it('the defaults are the usual suspects', () => {
    for (const b of ['main', 'master', 'production', 'prod', 'release/1.2']) expect(branchMatches(b, DEFAULT_PROTECTED_BRANCHES), b).toBe(true);
    for (const b of ['develop', 'feature/prod-fix', 'staging', 'fix/main-menu']) expect(branchMatches(b, DEFAULT_PROTECTED_BRANCHES), b).toBe(false);
  });
});
