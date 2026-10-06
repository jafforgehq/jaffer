import fs from 'node:fs';
import path from 'node:path';
import type { JafferPaths } from '../../shared/paths';
import { dayKey, ensureDir, nowIso, readJson, uid, writeJson } from '../../shared/util';
import { redactText, isSensitiveCommand } from '../../shared/redact';
import type { CommandEpisode, Episode, EpisodeInput } from './types';

export interface CursorState {
  /** Last episode seq the reflector has consumed. */
  reflectedSeq: number;
  lastReflectionAt?: string;
  lastConsolidationAt?: string;
  /** Pattern candidates seen but not yet frequent enough to become memory. */
  candidates: Record<string, { count: number; last: string; payload?: unknown }>;
  /** Byte offsets of external transcript files already ingested. */
  ingest: Record<string, number>;
}

export const DEFAULT_CURSOR: CursorState = { reflectedSeq: 0, candidates: {}, ingest: {} };

const MAX_TEXT = 4000;

/**
 * Append-only log of what happened (commands, agent turns, ingested external agent
 * turns). Everything is redacted on the way in. Episodes are raw material for the
 * reflector, not memory themselves, so they are pruned after a retention window.
 */
export class EpisodeLog {
  private seq = 0;
  private cache: { file: string; mtime: number; rows: Episode[] } | null = null;

  constructor(
    private paths: JafferPaths,
    private clock: () => number = Date.now,
  ) {
    ensureDir(paths.memoryEpisodesDir);
    this.seq = this.scanMaxSeq();
  }

  private fileFor(ts: string): string {
    return path.join(this.paths.memoryEpisodesDir, `${dayKey(ts)}.jsonl`);
  }

  private files(): string[] {
    try {
      return fs
        .readdirSync(this.paths.memoryEpisodesDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .map((f) => path.join(this.paths.memoryEpisodesDir, f));
    } catch {
      return [];
    }
  }

  private scanMaxSeq(): number {
    const files = this.files();
    for (let i = files.length - 1; i >= 0; i--) {
      const rows = this.readFile(files[i]!);
      if (rows.length) return Math.max(...rows.map((r) => r.seq));
    }
    return 0;
  }

  private readFile(file: string): Episode[] {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: Episode[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as Episode);
      } catch {
        /* torn line */
      }
    }
    return out;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Returns null when the input was dropped (sensitive command etc.). */
  append(input: EpisodeInput): Episode | null {
    const e = this.sanitize(input);
    if (!e) return null;
    const ts = input.ts ?? new Date(this.clock()).toISOString();
    const ep = { ...e, seq: ++this.seq, id: uid('e'), ts } as Episode;
    ensureDir(this.paths.memoryEpisodesDir);
    // File by insertion time (not event time) so seq order always matches file order.
    fs.appendFileSync(this.fileFor(new Date(this.clock()).toISOString()), JSON.stringify(ep) + '\n', { mode: 0o600 });
    return ep;
  }

  private sanitize(input: EpisodeInput): EpisodeInput | null {
    switch (input.t) {
      case 'cmd': {
        if (!input.cmd.trim() || isSensitiveCommand(input.cmd)) return null;
        const out: CommandEpisode = { ...(input as CommandEpisode), seq: 0, id: '', ts: '' };
        out.cmd = redactText(input.cmd).slice(0, 600);
        if (input.out) out.out = redactText(input.out).slice(-1500);
        return out;
      }
      case 'agent':
        return { ...input, user: redactText(input.user).slice(0, MAX_TEXT), reply: redactText(input.reply).slice(0, MAX_TEXT) };
      case 'ext':
        return { ...input, text: redactText(input.text).slice(0, MAX_TEXT) };
      case 'note':
        return { ...input, text: redactText(input.text).slice(0, MAX_TEXT) };
    }
  }

  /** Episodes with seq > `after`, oldest first. */
  readAfter(after: number, limit = 2000): Episode[] {
    const files = this.files();
    const out: Episode[] = [];
    // Files are named by insertion day and seq is monotonic, so once a file holds nothing
    // newer than the cursor, no older file can either.
    for (let i = files.length - 1; i >= 0; i--) {
      const rows = this.readFile(files[i]!).filter((r) => r.seq > after);
      if (rows.length === 0) break;
      out.unshift(...rows);
    }
    return out.slice(0, limit);
  }

  pending(after: number): number {
    return Math.max(0, this.seq - after);
  }

  recent(limit = 50): Episode[] {
    const files = this.files();
    const out: Episode[] = [];
    for (let i = files.length - 1; i >= 0 && out.length < limit; i--) out.unshift(...this.readFile(files[i]!));
    return out.slice(-limit);
  }

  /** Delete day files older than `days`. Returns number removed. */
  prune(days: number): number {
    const cutoff = dayKey(this.clock() - days * 86_400_000);
    let n = 0;
    for (const f of this.files()) {
      const day = path.basename(f, '.jsonl');
      if (day < cutoff) {
        fs.rmSync(f, { force: true });
        n++;
      }
    }
    return n;
  }
}

export class CursorFile {
  constructor(private file: string) {}
  read(): CursorState {
    const c = readJson<Partial<CursorState>>(this.file, {});
    return { ...DEFAULT_CURSOR, ...c, candidates: c.candidates ?? {}, ingest: c.ingest ?? {} };
  }
  write(c: CursorState): void {
    writeJson(this.file, c);
  }
  update(fn: (c: CursorState) => void): CursorState {
    const c = this.read();
    fn(c);
    this.write(c);
    return c;
  }
}

export { nowIso };
