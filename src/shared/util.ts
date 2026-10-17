import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Emitter } from './emitter';

export { Emitter };

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/**
 * (1.4.1) A folder of this user that others may read or enter (an older build made it 0755) is made private: its group and other bits
 * go, the owner's stay. Opened without following a link (a link is left alone), best effort: it never throws.
 */
export async function tightenDir(dir: string): Promise<void> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (st.isDirectory() && st.uid === process.getuid?.() && st.mode & 0o077) await fh.chmod(st.mode & 0o700);
  } catch {
    /* not there, a link, or not ours */
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Write a file atomically (tmp + rename) so a crash never leaves a half-written file. `preserve` is for files that belong to the
 * user (their CLAUDE.md, a settings file): a symlink (a dotfiles manager) is written through, not replaced by a plain file, and
 * the permissions the file already has are kept; `mode` is only for a file that is not there yet.
 */
export function writeFileAtomic(file: string, data: string, mode = 0o600, opts: { preserve?: boolean } = {}): void {
  let target = file;
  let useMode = mode;
  if (opts.preserve) {
    try {
      target = fs.realpathSync(file);
      useMode = fs.statSync(target).mode & 0o777;
    } catch {
      /* not there yet: a new file */
    }
  }
  ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: useMode });
  fs.chmodSync(tmp, useMode); // the umask must not narrow what was asked for or kept
  fs.renameSync(tmp, target);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/** Keep a log bounded: past `maxBytes` it is moved aside (`<file>.1`, replacing the one before) and a fresh one starts. */
export function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): void {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1');
  } catch {
    /* no log yet */
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
