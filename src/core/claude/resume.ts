import fs from 'node:fs';
import path from 'node:path';
import { isSessionId, type ResumeOffer } from '../../shared/claude-resume';
import { AUTO_RESUME } from '../../shared/keep-running';
import { readJson, writeJson } from '../../shared/util';

/** A conversation not touched for this long is not offered: it is no longer "where I left off". */
const MAX_AGE_MS = 14 * 86_400_000;
/** The hooks fire on every tool call: "still going" is written at most this often, a changed point at once. */
const WRITE_EVERY_MS = 30_000;
/** How many ended conversations are remembered as ended (the newest): a straggler comes within moments, not weeks. */
const MAX_ENDED = 50;
/** More automatic attempts than the limit never matter; this only keeps the list in the file small. */
const MAX_ATTEMPT_TIMES = 20;

interface Point {
  id: string;
  /** The folder Claude Code was started in: its conversations live under it, so it is where `--resume` finds them. */
  cwd: string;
  transcriptPath?: string;
  at: number;
}

/** When automatic resume attempts were made for one conversation: how the limit (a few in ten minutes) survives a restart of the daemon. */
interface Attempts {
  id: string;
  at: number[];
}

const sameFolder = (a: string, b: string): boolean => {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

/**
 * The one Claude Code conversation to offer back after the daemon stopped (a reboot, an update, a crash): its id, where it ran, and when
 * it was last seen. Only ids, a folder and a time; nothing of what was said. Cleared when the person ended the conversation on
 * purpose, so a normal exit is never followed by an offer. Beside it, the times of the automatic attempts to resume one conversation
 * (just times and its id), so that the limit on attempts holds across a restart.
 */
export class ResumeStore {
  private point: Point | null;
  /** For one conversation at a time. Saved together with the point, so with no point they are kept in memory only. */
  private tries: Attempts | null;
  private writtenAt = 0;
  /**
   * Conversations that ended on purpose. The hooks after a tool call are asynchronous, so one can arrive after the exit that ended
   * the conversation: without this it would write the point back and a conversation the person quit would be offered after a restart.
   */
  private ended = new Set<string>();

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {
    const saved = readJson<{ point?: Partial<Point> | null; attempts?: unknown } | null>(this.file, null);
    this.point = this.read(saved?.point);
    this.tries = this.readAttempts(saved?.attempts);
  }

  private read(raw: Partial<Point> | null | undefined): Point | null {
    if (!raw || typeof raw !== 'object') return null;
    if (!isSessionId(raw.id) || typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd) || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
    const t = typeof raw.transcriptPath === 'string' && path.isAbsolute(raw.transcriptPath) && raw.transcriptPath.endsWith('.jsonl') ? raw.transcriptPath : undefined;
    return { id: raw.id, cwd: raw.cwd, transcriptPath: t, at: raw.at };
  }

  /** A block that is not an id and a list of finite times is not read at all: a limit that is too strict is better than a broken one. */
  private readAttempts(raw: unknown): Attempts | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { id, at } = raw as { id?: unknown; at?: unknown };
    if (!isSessionId(id) || !Array.isArray(at) || !at.every((t) => typeof t === 'number' && Number.isFinite(t))) return null;
    return { id, at: (at as number[]).slice(-MAX_ATTEMPT_TIMES) };
  }

  /** The times that still count: within the window, oldest first. */
  private recent(at: number[]): number[] {
    const now = this.now();
    return at.filter((t) => now - t < AUTO_RESUME.windowMs).sort((a, b) => a - b);
  }

  private write(): void {
    this.writtenAt = this.now();
    try {
      if (this.point) {
        const at = this.tries ? this.recent(this.tries.at) : [];
        writeJson(this.file, { version: 1, point: this.point, ...(this.tries && at.length ? { attempts: { id: this.tries.id, at } } : {}) });
      } else fs.rmSync(this.file, { force: true });
    } catch {
      /* a note that cannot be written is only a missed offer */
    }
  }

  /** Claude Code is alive in this conversation. `starts`: this is its SessionStart, so a conversation that had ended is back. */
  note(p: { id: string; cwd?: string; transcriptPath?: string; starts?: boolean }): void {
    if (!isSessionId(p.id)) return;
    if (p.starts) this.ended.delete(p.id);
    else if (this.ended.has(p.id)) return;
    const same = this.point?.id === p.id;
    const cwd = same ? this.point!.cwd : p.cwd; // where it began, not wherever it later wandered
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 400) return;
    const tp = p.transcriptPath && path.isAbsolute(p.transcriptPath) && p.transcriptPath.endsWith('.jsonl') && p.transcriptPath.length <= 400 ? p.transcriptPath : undefined;
    const transcriptPath = same ? (this.point!.transcriptPath ?? tp) : tp;
    const changed = !same || transcriptPath !== this.point!.transcriptPath;
    this.point = { id: p.id, cwd, transcriptPath, at: this.now() };
    if (changed || this.now() - this.writtenAt >= WRITE_EVERY_MS) this.write();
  }

  /** The conversation ended on purpose (or the person dismissed the offer). No id: whatever is kept. */
  forget(id?: string): void {
    const gone = id ?? this.point?.id;
    if (gone !== undefined && isSessionId(gone)) {
      this.ended.delete(gone);
      this.ended.add(gone); // newest last
      if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.values().next().value as string);
    }
    const hadTries = this.tries !== null && this.tries.id === gone; // ended on purpose: nothing left to attempt for it
    if (hadTries) this.tries = null;
    if (!this.point || (id !== undefined && this.point.id !== id)) {
      if (hadTries && this.point) this.write();
      return;
    }
    this.point = null;
    this.tries = null; // the file goes with the point
    this.write();
  }

  /** The times of the automatic attempts to resume this conversation that still count (within `AUTO_RESUME.windowMs`), oldest first. */
  attempts(id: string): number[] {
    return isSessionId(id) && this.tries?.id === id ? this.recent(this.tries.at) : [];
  }

  /** An automatic attempt to resume this conversation is being made now. Attempts are kept for one conversation: the last one named. */
  recordAttempt(id: string): void {
    if (!isSessionId(id)) return;
    const kept = this.tries?.id === id ? this.recent(this.tries.at) : [];
    this.tries = { id, at: [...kept, this.now()].slice(-MAX_ATTEMPT_TIMES) };
    if (this.point) this.write();
  }

  /** Claude Code is running again (or the person took over): the attempts for this conversation start over. */
  clearAttempts(id: string): void {
    if (!this.tries || this.tries.id !== id) return;
    this.tries = null;
    if (this.point) this.write();
  }

  /** Saves the latest time seen (the daemon is about to stop). */
  flush(): void {
    if (this.point) this.write();
  }

  /** The offer for the window, or null: only when nothing runs, in the folder it ran in, recent, and its transcript still there. */
  offer(ctx: { shellCwd: string | undefined; active: boolean; busy: boolean; enabled: boolean }): ResumeOffer | null {
    const p = this.point;
    if (!p || !ctx.enabled || ctx.active || ctx.busy || !ctx.shellCwd) return null;
    if (this.now() - p.at > MAX_AGE_MS) return null;
    if (!sameFolder(p.cwd, ctx.shellCwd)) return null;
    if (p.transcriptPath && !fs.existsSync(p.transcriptPath)) return null;
    return { id: p.id, cwd: p.cwd, at: p.at };
  }
}
