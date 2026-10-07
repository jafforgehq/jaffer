import { describe, expect, it } from 'vitest';
import { isSensitiveCommand, redact, redactText } from '../src/shared/redact';

describe('redact', () => {
  it('masks well-known token formats', () => {
    const samples = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdefgh',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijkl',
      'AIzaSyA-1234567890abcdefghijklmnopqrstuv',
      'sk_live_abcdefghijklmnop1234',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ];
    for (const s of samples) {
      const out = redactText(`token is ${s} ok`);
      expect(out).not.toContain(s);
      expect(out).toContain('[REDACTED]');
    }
  });

  it('masks assignments but keeps the key name', () => {
    expect(redactText('export GITHUB_TOKEN=abc12345xyz')).toBe('export GITHUB_TOKEN=[REDACTED]');
    expect(redactText('password: "hunter2hunter2"')).toBe('password: "[REDACTED]"');
    expect(redactText('DB_PASSWORD=s3cr3t!')).toBe('DB_PASSWORD=[REDACTED]');
  });

  it('masks CLI flags and URL credentials', () => {
    expect(redactText('mysql --password=hunter2 -h db')).toContain('--password=[REDACTED]');
    expect(redactText('curl --token abcdef123456 https://x')).toContain('--token=[REDACTED]');
    expect(redactText('git clone https://bob:pw123@github.com/x/y.git')).toBe('git clone https://bob:[REDACTED]@github.com/x/y.git');
  });

  it('masks bearer headers', () => {
    expect(redactText('curl -H "Authorization: Bearer abcdefghijklmnop1234"')).toContain('Bearer [REDACTED]');
  });

  it('masks private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    const out = redactText(`before\n${pem}\nafter`);
    expect(out).not.toContain('MIIEow');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('masks unnamed high-entropy blobs but leaves git shas and normal words alone', () => {
    const blob = 'Zk9fQ2hhbmdlTWVQbGVhc2VfMTIzNDU2Nzg5MEFiQ2RFZkdoSWo';
    expect(redactText(`secret ${blob}`)).not.toContain(blob);
    const sha = 'a'.repeat(7) + '0123456789abcdef0123456789abcdef0';
    expect(redactText(`commit ${sha}`)).toContain(sha);
    expect(redactText('refactor the authentication module please')).toBe('refactor the authentication module please');
  });

  it('is idempotent and reports kinds', () => {
    const once = redact('TOKEN=abcdef123456');
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(once.kinds).toContain('assignment');
    expect(redact('nothing to see').count).toBe(0);
  });
});

describe('isSensitiveCommand', () => {
  it('flags commands that must never be recorded', () => {
    for (const c of [
      ' ls', // leading space
      'env',
      'printenv',
      'cat ~/.ssh/id_rsa',
      'security find-generic-password -s foo',
      'op read op://vault/item',
      'kubectl get secrets -n prod',
      'aws secretsmanager get-secret-value --secret-id x',
      'echo $OPENAI_API_KEY',
      'gh auth token',
    ]) {
      expect(isSensitiveCommand(c), c).toBe(true);
    }
  });
  it('lets ordinary commands through', () => {
    for (const c of ['ls -la', 'git status', 'pnpm test', 'cat README.md', 'echo hello', 'env FOO=1 node x.js']) {
      expect(isSensitiveCommand(c), c).toBe(false);
    }
  });
});
