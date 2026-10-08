import fs from 'node:fs';
import path from 'node:path';
import { isSessionId, type ResumeOffer } from '../../shared/claude-resume';
import { readJson, writeJson } from '../../shared/util';

/** A conversation not touched for this long is not offered: it is no longer "where I left off". */
const MAX_AGE_MS = 14 * 86_400_000;
/** The hooks fire on every tool call: "still going" is written at most this often, a changed point at once. */
const WRITE_EVERY_MS = 30_000;
/** How many ended conversations are remembered as ended (the newest): a straggler comes within moments, not weeks. */
const MAX_ENDED = 50;

interface Point {
  id: string;
  /** The folder Claude Code was started in: its conversations live under it, so it is where `--resume` finds them. */
  cwd: string;
  transcriptPath?: string;
  at: number;
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
 * purpose, so a normal exit is never followed by an offer.
 */
export class ResumeStore {
  private point: Point | null;
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
    this.point = this.read();
  }

  private read(): Point | null {
    const raw = readJson<{ point?: Partial<Point> | null } | null>(this.file, null)?.point;
    if (!raw || typeof raw !== 'object') return null;
    if (!isSessionId(raw.id) || typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd) || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
    const t = typeof raw.transcriptPath === 'string' && path.isAbsolute(raw.transcriptPath) && raw.transcriptPath.endsWith('.jsonl') ? raw.transcriptPath : undefined;
    return { id: raw.id, cwd: raw.cwd, transcriptPath: t, at: raw.at };
  }

  private write(): void {
    this.writtenAt = this.now();
    try {
      if (this.point) writeJson(this.file, { version: 1, point: this.point });
      else fs.rmSync(this.file, { force: true });
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
    if (!this.point || (id !== undefined && this.point.id !== id)) return;
    this.point = null;
    this.write();
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
