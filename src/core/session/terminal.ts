import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as nodePty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import { Emitter } from '../../shared/util';

export type PtyEvent =
  | { type: 'data'; data: string; seq: number }
  | { type: 'exit'; code: number | null; signal: number | null }
  | { type: 'start'; cmd: string }
  | { type: 'command'; cmd: string; exit: number | null; cwd: string; durMs: number; output: string }
  | { type: 'cwd'; cwd: string }
  | { type: 'title'; title: string }
  | { type: 'prompt' }
  | { type: 'bell' }
  | { type: 'notify'; title: string; body: string };

export interface PtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  scrollback?: number;
}

const MAX_OUTPUT_LINES = 400;
const MAX_OUTPUT_CHARS = 24_000;

function unescapeOsc(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * One pseudo-terminal running the user's shell, mirrored into a headless xterm so we can
 * (a) hand a faithful screen snapshot to any client that attaches later, (b) read command
 * output as clean text, and (c) track prompt/command state from the shell-integration marks.
 */
export class PtySession {
  readonly events = new Emitter<PtyEvent>();
  readonly term: Terminal;
  private serializer: SerializeAddon;
  private pty: IPty;
  private _alive = true;
  cwd: string;
  title = '';
  /** True once the shell has emitted integration marks, i.e. we can trust the state below. */
  integrated = false;
  promptReady = false;
  private pendingCmd = '';
  private running: { cmd: string; startedAt: number; marker: ReturnType<Terminal['registerMarker']> } | null = null;
  private batch: string[] = [];
  private batchBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Count of data events emitted so far; lets a client discard anything already covered by its snapshot. */
  private dataSeq = 0;

  constructor(opts: PtyOptions) {
    this.cwd = opts.cwd;
    this.term = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: opts.scrollback ?? 10_000, allowProposedApi: true, convertEol: false });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.registerParsers();
    this.pty = nodePty.spawn(opts.file, opts.args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
    this.pty.onData((d) => this.onPtyData(d));
    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      // Let every queued chunk be parsed and emitted before announcing the exit.
      this.term.write('', () => {
        this.flush();
        this.events.emit({ type: 'exit', code: exitCode ?? null, signal: signal ?? null });
      });
    });
  }

  get alive(): boolean {
    return this._alive;
  }

  get pid(): number {
    return this.pty.pid;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** When the running command started (ms since epoch), for how long the mole has been digging. */
  get runningSince(): number | null {
    return this.running?.startedAt ?? null;
  }

  get runningCommand(): string | null {
    return this.running?.cmd ?? null;
  }

  get altScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  // ------------------------------------------------------------------ io

  private onPtyData(data: string): void {
    // Emit only after the headless terminal has parsed the chunk. Snapshots taken via
    // consistentSnapshot() are then exactly "everything emitted so far", never a partial chunk.
    this.term.write(data, () => this.queueOut(data));
  }

  private queueOut(data: string): void {
    // Coalesce bursts (e.g. `cat bigfile`) into few IPC messages.
    this.batch.push(data);
    this.batchBytes += data.length;
    if (this.batchBytes >= 64 * 1024) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 4);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.batch.length) return;
    const data = this.batch.join('');
    this.batch = [];
    this.batchBytes = 0;
    this.events.emit({ type: 'data', data, seq: ++this.dataSeq });
  }

  write(data: string): void {
    if (this._alive) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(2, Math.min(1000, Math.floor(cols)));
    rows = Math.max(1, Math.min(500, Math.floor(rows)));
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    if (this._alive) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        /* pty already gone */
      }
    }
  }

  kill(signal?: string): void {
    if (!this._alive) return;
    try {
      this.pty.kill(signal);
    } catch {
      /* already dead */
    }
  }

  dispose(): void {
    this.kill();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.term.dispose();
  }

  // ------------------------------------------------------------------ state

  snapshot(scrollback = 4000): { data: string; cols: number; rows: number; cwd: string; title: string; alt: boolean; seq: number } {
    return { data: this.serializer.serialize({ scrollback }), cols: this.term.cols, rows: this.term.rows, cwd: this.cwd, title: this.title, alt: this.altScreen, seq: this.dataSeq };
  }

  /**
   * A snapshot consistent with the data stream: taken after all in-flight output was parsed AND emitted.
   * A client that applies it and then every later 'data' event sees exactly the live screen.
   */
  consistentSnapshot(scrollback = 4000): Promise<ReturnType<PtySession['snapshot']>> {
    return new Promise((resolve) =>
      this.term.write('', () => {
        this.flush();
        resolve(this.snapshot(scrollback));
      }),
    );
  }

  /** Inject text into the terminal buffer without going through the shell (e.g. a restore banner). */
  async inject(text: string): Promise<void> {
    await new Promise<void>((resolve) => this.term.write(text, resolve));
  }

  /** Plain text of the last `lines` rows of the active screen (what a human would see right now). */
  readScreen(lines = 40): string {
    const buf = this.term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const start = Math.max(0, end - lines + 1);
    return this.linesToText(buf, start, end);
  }

  private linesToText(buf: Terminal['buffer']['active'], start: number, end: number): string {
    const out: string[] = [];
    for (let i = start; i <= end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length && out[out.length - 1]!.trim() === '') out.pop();
    let text = out.slice(-MAX_OUTPUT_LINES).join('\n');
    if (text.length > MAX_OUTPUT_CHARS) text = '…' + text.slice(-MAX_OUTPUT_CHARS);
    return text;
  }

  // ------------------------------------------------------------------ shell integration

  private registerParsers(): void {
    const p = this.term.parser;
    p.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(';');
      if (kind === 'A') {
        this.integrated = true;
        this.promptReady = true;
        this.events.emit({ type: 'prompt' });
      } else if (kind === 'C') {
        this.integrated = true;
        this.promptReady = false;
        if (!this.running) {
          this.running = { cmd: this.pendingCmd, startedAt: Date.now(), marker: this.term.registerMarker(0) };
          this.events.emit({ type: 'start', cmd: this.running.cmd });
        }
        this.pendingCmd = '';
      } else if (kind === 'D') {
        this.finishCommand(arg === undefined || arg === '' ? null : Number.parseInt(arg, 10));
      }
      return true;
    });
    p.registerOscHandler(633, (data) => {
      const semi = data.indexOf(';');
      const kind = semi < 0 ? data : data.slice(0, semi);
      const rest = semi < 0 ? '' : data.slice(semi + 1);
      if (kind === 'E') this.pendingCmd = unescapeOsc(rest);
      else if (kind === 'P' && rest.startsWith('Cwd=')) {
        const cwd = unescapeOsc(rest.slice(4));
        if (cwd && cwd !== this.cwd) {
          this.cwd = cwd;
          this.events.emit({ type: 'cwd', cwd });
        }
      }
      return true;
    });
    // OSC 7 (file://host/path) — honoured too, for shells that already emit it.
    p.registerOscHandler(7, (data) => {
      try {
        const u = new URL(data);
        if (u.protocol === 'file:') {
          const cwd = decodeURIComponent(u.pathname);
          if (cwd && cwd !== this.cwd && !this.integrated) {
            this.cwd = cwd;
            this.events.emit({ type: 'cwd', cwd });
          }
        }
      } catch {
        /* ignore malformed */
      }
      return true;
    });
    // Desktop notifications: OSC 9 (iTerm2 / Claude Code) and OSC 777;notify (Ghostty/kitty style).
    p.registerOscHandler(9, (data) => {
      if (/^\d+;/.test(data)) return true; // OSC 9;4 progress etc. are not notifications
      this.events.emit({ type: 'notify', title: '', body: data });
      return true;
    });
    p.registerOscHandler(777, (data) => {
      const parts = data.split(';');
      if (parts[0] === 'notify') this.events.emit({ type: 'notify', title: parts[1] ?? '', body: parts.slice(2).join(';') });
      return true;
    });
    this.term.onTitleChange((t) => {
      this.title = t;
      this.events.emit({ type: 'title', title: t });
    });
    this.term.onBell(() => this.events.emit({ type: 'bell' }));
  }

  private finishCommand(exit: number | null): void {
    const run = this.running;
    if (!run) return;
    this.running = null;
    const normal = this.term.buffer.normal;
    const startLine = run.marker && run.marker.line >= 0 ? run.marker.line : Math.max(0, normal.baseY);
    const endLine = normal.baseY + normal.cursorY;
    const output = startLine <= endLine ? this.linesToText(normal, startLine, endLine) : '';
    run.marker?.dispose();
    this.events.emit({ type: 'command', cmd: run.cmd, exit, cwd: this.cwd, durMs: Date.now() - run.startedAt, output });
  }
}
