import { describe, expect, it } from 'vitest';
import { isSensitivePath } from '../src/shared/sensitive-path';

describe('isSensitivePath: a file whose name alone is not to be kept', () => {
  it('flags keys, credentials and secrets, wherever they are', () => {
    for (const p of [
      '/Users/me/.ssh/config',
      '/Users/me/.ssh/id_ed25519.pub',
      '/Users/me/.ssh',
      '/Users/me/.gnupg/pubring.kbx',
      '/Users/me/.aws/credentials',
      '/work/app/.env',
      '/work/app/.env.local',
      '/work/app/.env.production',
      '/work/app/certs/server.pem',
      '/work/app/certs/server.key',
      '/backup/id_rsa',
      '/backup/id_rsa.pub',
      '/backup/id_ed25519',
      '/work/app/credentials.json',
      '/work/app/config/credentials',
      '/Users/me/Library/Keychains/login.keychain-db',
      '/Users/me/.netrc',
      '/Users/me/.npmrc',
      '/Users/me/.pypirc',
      '.env',
      'secrets/prod.KEY',
      '/Users/me/.SSH/known_hosts',
      '/Users/me/.git-credentials',
      '/backup/id_ecdsa',
      '/backup/id_ecdsa.pub',
      '/backup/id_dsa',
      '/Users/me/.kube/config',
      '/Users/me/.docker/config.json',
      '/work/app/certs/client.p12',
      '/work/app/certs/client.PFX',
      '/work/app/certs/server.key.bak',
    ]) expect(isSensitivePath(p), p).toBe(true);
  });

  it('leaves ordinary source files alone, also ones that only look alike', () => {
    for (const p of [
      '/work/app/src/main.ts',
      '/work/app/README.md',
      '/work/app/src/environment.ts',
      '/work/app/docs/ssh-setup.md',
      '/work/app/src/keyboard.ts',
      '/work/app/src/aws.ts',
      '/work/app/src/pem-format.ts',
      '/work/app/.npmrc.md',
      '/work/app/src/my.env.ts',
      '/work/app/docker/config.json',
      '/work/app/src/kube/config.ts',
      '/work/app/src/monkey.ts',
      '/work/app/src/p12.ts',
      '',
    ]) expect(isSensitivePath(p), p).toBe(false);
  });

  it('reads only the first 4096 characters (it runs on the daemon thread over a hook payload)', () => {
    expect(isSensitivePath('/a'.repeat(3000) + '/.ssh/config')).toBe(true); // too long to read through: it fails closed, as if it were one
    expect(isSensitivePath('/.ssh/' + 'a'.repeat(10_000))).toBe(true);
  });

  const MB = 1_000_000;
  const crafted: Record<string, (bytes: number) => string> = {
    'one long name': (n) => 'a'.repeat(n),
    'a run of slashes': (n) => '/'.repeat(n),
    'a run of dots': (n) => '.'.repeat(n),
    'many short folders': (n) => 'a/'.repeat(n / 2),
    'almost a key, over and over (.ke)': (n) => '.ke'.repeat(n / 3),
    'almost a keychain, over and over': (n) => '.keychai'.repeat(n / 8),
  };
  for (const size of [1, 8]) {
    for (const [what, make] of Object.entries(crafted)) {
      it(`stays fast on ${what} (${size} MB)`, () => {
        const p = make(size * MB);
        const t0 = performance.now();
        expect(() => isSensitivePath(p), what).not.toThrow();
        expect(performance.now() - t0, what).toBeLessThan(200); // microseconds in practice once cut; generous for CI
      });
    }
  }
});
