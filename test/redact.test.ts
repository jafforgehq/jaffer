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

  it('masks a password glued to -p for the programs that take it that way, and leaves -p alone elsewhere', () => {
    expect(redactText('mysql -u root -pHunter2 -e "select 1"')).toBe('mysql -u root -p[REDACTED] -e "select 1"');
    expect(redactText('mysqldump -h db -pS3cret mydb > dump.sql')).toBe('mysqldump -h db -p[REDACTED] mydb > dump.sql');
    expect(redactText('7z a -pTopSecret archive.7z files')).toBe('7z a -p[REDACTED] archive.7z files');
    expect(redactText('mysql -p -u root')).toBe('mysql -p -u root'); // asks for it: nothing to hide
    for (const harmless of ['docker run -p8080:80 nginx', 'lsof -p1234', 'gcc -pthread main.c', 'mkdir -p build/out', 'ssh -p2222 host', 'psql -p5432 -U me']) expect(redactText(harmless), harmless).toBe(harmless);
  });

  it('masks passwords given to sshpass, docker login, curl and openssl on the command line', () => {
    expect(redactText('sshpass -p hunter2 ssh me@host')).toBe('sshpass -p [REDACTED] ssh me@host');
    expect(redactText('docker login -u me -p s3cretvalue registry.example.com')).toBe('docker login -u me -p [REDACTED] registry.example.com');
    expect(redactText('curl -u alice:hunter2 https://api.example.com/x')).toBe('curl -u alice:[REDACTED] https://api.example.com/x');
    expect(redactText('curl https://api.example.com/x --user bob:p@ss')).toBe('curl https://api.example.com/x --user bob:[REDACTED]');
    expect(redactText('curl -u alice https://api.example.com/x')).toBe('curl -u alice https://api.example.com/x'); // no password in it
    expect(redactText('openssl enc -aes-256-cbc -pass pass:hunter2 -in a')).not.toContain('hunter2');
    expect(redactText('openssl rsa -passin pass:hunter2')).toBe('openssl rsa -passin pass:[REDACTED]');
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

describe('redact on hostile or merely large input', () => {
  const quick = (what: string, input: string) => {
    const t0 = Date.now();
    redactText(input);
    expect(Date.now() - t0, what).toBeLessThan(250); // it runs on the daemon's main thread, which also relays the terminal
  };

  it('stays fast on long runs that almost look like a key (a failing command can print 24 KB, a transcript far more)', () => {
    quick('password. repeated', 'password.'.repeat(3000));
    quick('dotted run', 'a.'.repeat(15_000));
    quick('dashed run', 'a-'.repeat(15_000));
    quick('underscored key', 'my_token_'.repeat(4000));
    quick('url scheme run', 'a.'.repeat(12_000) + '://user:pw@host');
    quick('one long word', 'x'.repeat(100_000));
    quick('key with no value', 'API_KEY'.repeat(5000));
    quick('lots of BEGIN markers', '-----BEGIN PRIVATE KEY-----\n'.repeat(2000));
  });

  it('still masks a secret that sits in the middle of such a run', () => {
    expect(redactText(`${'a.'.repeat(5000)} DB_PASSWORD=Sup3rS3cret ${'b.'.repeat(5000)}`)).not.toContain('Sup3rS3cret');
    expect(redactText('x'.repeat(30) + '_api_key=abcd1234efgh' + 'y'.repeat(30))).toContain('[REDACTED]');
  });
});

describe('redact: values with spaces and odd characters', () => {
  it('masks a quoted value whole, spaces and all, for flags and for assignments', () => {
    expect(redactText('deploy --password "correct horse battery" --env prod')).toBe('deploy --password=[REDACTED] --env prod');
    expect(redactText("deploy --token 'a b c d' now")).toBe('deploy --token=[REDACTED] now');
    expect(redactText('password: "hunter two three"')).toBe('password: "[REDACTED]"');
    expect(redactText("export SECRET_KEY='two words here'")).toBe("export SECRET_KEY='[REDACTED]'");
    expect(redactText('{"api_key": "abc def ghi", "other": 1}')).toBe('{"api_key": "[REDACTED]", "other": 1}');
    expect(redactText('{"password":"hunter2hunter2","user":"me"}')).toBe('{"password":"[REDACTED]","user":"me"}'); // JSON: the key is quoted too
    expect(redactText("{'client_secret': 'xyz 123'}")).toBe("{'client_secret': '[REDACTED]'}");
  });

  it('masks an unquoted value up to the next space, with commas, semicolons and ampersands in it', () => {
    expect(redactText('PASSWORD=pass,word,secret99 next')).toBe('PASSWORD=[REDACTED] next');
    expect(redactText('TOKEN=ab;cd&ef next')).toBe('TOKEN=[REDACTED] next');
  });

  it('leaves ordinary text and short or empty values alone', () => {
    expect(redactText('the password field is optional')).toBe('the password field is optional');
    expect(redactText('token: ')).toBe('token: ');
    expect(redactText('secret=no')).toBe('secret=no'); // too short to be one
    expect(redactText('--password')).toBe('--password');
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
      'cat .env',
      'cat apps/api/.env.local',
      'less ./.env.production',
      'source .env',
      'printenv OPENAI_API_KEY',
      'sudo printenv HOME',
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
