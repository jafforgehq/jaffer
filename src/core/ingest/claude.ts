import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCorrection } from '../memory/heuristics';
import { resolveProject } from '../session/project';
import type { EpisodeInput } from '../memory/types';

export interface ParsedLine {
  role: 'user' | 'assistant';
  text: string;
  cwd?: string;
  ts?: string;
  sessionId?: string;
}

const NOISE_PREFIXES = ['<command-name>', '<command-message>', '<command-args>', '<local-command-stdout>', '<local-command-caveat>', '<system-reminder>', '<user-prompt-submit-hook>', '[Request interrupted', 'Caveat:', '<bash-input>', '<bash-stdout>', '<bash-stderr>'];

function textOf(content: unknown, role: 'user' | 'assistant'): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; text?: string };
    // user turns that only carry tool results are plumbing, and thinking is private
    if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text);
  }
  void role;
  return parts.join('\n');
}

/** Parse one line of a Claude Code transcript into a conversational turn (or null for plumbing). */
export function parseClaudeLine(line: string): ParsedLine | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || (d.type !== 'user' && d.type !== 'assistant')) return null;
  if (d.isSidechain === true || d.isMeta === true) return null; // sub-agent chatter and injected context
  const role = d.type as 'user' | 'assistant';
  const raw = textOf(d.message?.content, role).trim();
  if (!raw) return null;
  if (NOISE_PREFIXES.some((p) => raw.startsWith(p))) return null;
  return { role, text: raw, cwd: typeof d.cwd === 'string' ? d.cwd : undefined, ts: typeof d.timestamp === 'string' ? d.timestamp : undefined, sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined };
}

export interface IngestOptions {
  home?: string;
  backfillDays: number;
  offsets: Record<string, number>;
  emit: (e: EpisodeInput) => void;
  /** Called with the new offsets after each scan. */
  save: (offsets: Record<string, number>) => void;
  maxInitialBytes?: number;
}

export interface ScanResult {
  files: number;
  turns: number;
}

/**
 * Watches Claude Code's own transcripts (~/.claude/projects/**.jsonl) so everything you do in
 * Claude Code — inside Jaffer or anywhere else — also teaches Jaffer's memory. Read-only.
 */
export class ClaudeIngestor {
  private home: string;
  constructor(private o: IngestOptions) {
    this.home = o.home ?? os.homedir();
  }

  get root(): string {
    return path.join(this.home, '.claude', 'projects');
  }

  scan(): ScanResult {
    const result: ScanResult = { files: 0, turns: 0 };
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.root);
    } catch {
      return result;
    }
    const cutoff = Date.now() - this.o.backfillDays * 86_400_000;
    const offsets = this.o.offsets;
    for (const d of dirs) {
      const dir = path.join(this.root, d);
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(dir, f);
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        const known = offsets[file];
        if (known === undefined && st.mtimeMs < cutoff) {
          offsets[file] = st.size; // old history: not our business
          continue;
        }
        let start = known ?? 0;
        if (known === undefined && st.size > (this.o.maxInitialBytes ?? 600_000)) start = st.size - (this.o.maxInitialBytes ?? 600_000);
        if (st.size < start) start = 0; // file was rewritten
        if (st.size === start) {
          offsets[file] = start;
          continue;
        }
        const { turns, end } = this.readFrom(file, start, st.size, known === undefined && start > 0);
        offsets[file] = end;
        result.files++;
        result.turns += turns;
      }
    }
    this.o.save(offsets);
    return result;
  }

  private readFrom(file: string, start: number, size: number, skipPartialFirst: boolean): { turns: number; end: number } {
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // Only consume complete lines; a half-written tail is picked up on the next scan.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { turns: 0, end: start };
    let body = text.slice(0, lastNl + 1);
    const end = start + Buffer.byteLength(body, 'utf8');
    if (skipPartialFirst) body = body.slice(body.indexOf('\n') + 1);
    let turns = 0;
    for (const line of body.split('\n')) {
      if (!line) continue;
      const t = parseClaudeLine(line);
      if (!t) continue;
      const project = t.cwd ? resolveProject(t.cwd, this.home).root : undefined;
      this.o.emit({
        t: 'ext',
        agent: 'claude-code',
        role: t.role,
        text: t.role === 'assistant' ? t.text.slice(0, 700) : t.text.slice(0, 1600),
        cwd: t.cwd,
        project,
        ts: t.ts,
        correction: t.role === 'user' ? detectCorrection(t.text) : false,
      });
      turns++;
    }
    return { turns, end };
  }
}
