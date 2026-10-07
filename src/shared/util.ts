import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Emitter } from './emitter';

export { Emitter };

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/** Write a file atomically (tmp + rename) so a crash never leaves a half-written file. */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
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

export function appendLine(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
}

/** Read a JSONL file, silently skipping corrupt lines (a torn tail write must not brick startup). */
export function readJsonl<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function writeJsonl(file: string, rows: unknown[]): void {
  writeFileAtomic(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Keep the tail of a long string (most relevant part of command output). */
export function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max + 1);
}

export function dayKey(ts: string | number | Date = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialises async work: each task starts after the previous settles. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
