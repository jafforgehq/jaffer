import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { JafferPaths } from './paths';
import { readJson, writeJson } from './util';

/**
 * Secret storage. On macOS secrets live in the login Keychain (via the `security` tool, fed on
 * stdin so they never appear in a process listing). Elsewhere — and in tests — they fall back to a
 * 0600 file. Values are base64-wrapped so awkward characters never confuse the tool's parser.
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  readonly backend: 'keychain' | 'file';
}

const SERVICE = 'Jaffer';
const enc = (v: string) => Buffer.from(v, 'utf8').toString('base64');
const dec = (v: string) => Buffer.from(v.trim(), 'base64').toString('utf8');

class KeychainStore implements SecretStore {
  readonly backend = 'keychain' as const;
  get(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout.trim()) resolve(null);
        else resolve(dec(stdout));
      });
    });
  }
  set(name: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => (code === 0 && !err.includes('security:') ? resolve() : reject(new Error(err.trim() || `security exited ${code}`))));
      p.stdin.write(`add-generic-password -U -s ${SERVICE} -a ${JSON.stringify(name)} -w ${JSON.stringify(enc(value))}\n`);
      p.stdin.end();
    });
  }
  delete(name: string): Promise<void> {
    return new Promise((resolve) => execFile('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', name], () => resolve()));
  }
}

class FileStore implements SecretStore {
  readonly backend = 'file' as const;
  constructor(private file: string) {}
  async get(name: string): Promise<string | null> {
    const v = readJson<Record<string, string>>(this.file, {})[name];
    return v ? dec(v) : null;
  }
  async set(name: string, value: string): Promise<void> {
    const cur = readJson<Record<string, string>>(this.file, {});
    cur[name] = enc(value);
    writeJson(this.file, cur);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
  }
  async delete(name: string): Promise<void> {
    const cur = readJson<Record<string, string>>(this.file, {});
    delete cur[name];
    writeJson(this.file, cur);
  }
}

export function makeSecretStore(paths: JafferPaths, force?: 'keychain' | 'file'): SecretStore {
  const useKeychain = force ? force === 'keychain' : process.platform === 'darwin' && fs.existsSync('/usr/bin/security');
  return useKeychain ? new KeychainStore() : new FileStore(paths.secrets);
}
