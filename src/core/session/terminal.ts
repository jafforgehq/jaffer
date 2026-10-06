import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as nodePty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import { Emitter, SerialQueue, sleep } from '../../shared/util';

export type PtyEvent =
  | { type: 'data'; data: string; seq: number }
  | { type: 'exit'; code: number | null; signal: number | null }
  | { type: 'command'; cmd: string; exit: number | null; cwd: string; durMs: number; output: string; by: 'user' | 'agent' }
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

export interface RunResult {
  cmd: string;
  exit: number | null;
  output: string;
  durMs: number;
  timedOut: boolean;
  cwd: string;
}

export class RunRefused extends Error {
  constructor(
    message: string,
    readonly reason: 'busy' | 'no-integration' | 'not-started' | 'exited',
  ) {
    super(message);
  }
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
  lastExit: number | null = null;
  private pendingCmd = '';
  private running: { cmd: string; startedAt: number; marker: ReturnType<Terminal['registerMarker']>; by: 'user' | 'agent' } | null = null;
  private nextBy: 'user' | 'agent' = 'user';
  private injecting = false;
  private runQueue = new SerialQueue();
  private batch: string[] = [];
  private batchBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();
  /** Count of data events emitted so far; lets a client discard anything already covered by its snapshot. */
  private dataSeq = 0;

  constructor(private opts: PtyOptions) {
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

  get idleMs(): number {
    return Date.now() - this.lastActivity;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  get runningCommand(): string | null {
    return this.running?.cmd ?? null;
  }

  get altScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  // ------------------------------------------------------------------ io

  private onPtyData(data: string): void {
    this.lastActivity = Date.now();
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

  /** Make full-screen apps (Claude Code, vim…) repaint, e.g. after a client re-attaches. */
  nudge(): void {
    if (!this._alive) return;
    const { cols, rows } = this.term;
    try {
      this.pty.resize(cols, Math.max(1, rows - 1));
      setTimeout(() => {
        try {
          if (this._alive) this.pty.resize(cols, rows);
        } catch {
          /* ignore */
        }
      }, 30);
    } catch {
      /* ignore */
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
        this.injecting = false;
        this.events.emit({ type: 'prompt' });
      } else if (kind === 'C') {
        this.integrated = true;
        this.promptReady = false;
        this.injecting = false;
        if (!this.running) {
          this.running = { cmd: this.pendingCmd, startedAt: Date.now(), marker: this.term.registerMarker(0), by: this.nextBy };
          this.nextBy = 'user';
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
    this.lastExit = exit;
    const run = this.running;
    if (!run) return;
    this.running = null;
    const normal = this.term.buffer.normal;
    const startLine = run.marker && run.marker.line >= 0 ? run.marker.line : Math.max(0, normal.baseY);
    const endLine = normal.baseY + normal.cursorY;
    const output = startLine <= endLine ? this.linesToText(normal, startLine, endLine) : '';
    run.marker?.dispose();
    this.events.emit({ type: 'command', cmd: run.cmd, exit, cwd: this.cwd, durMs: Date.now() - run.startedAt, output, by: run.by });
  }

  // ------------------------------------------------------------------ agent-driven commands

  /**
   * Type a command into the live shell and wait for it to finish, exactly as a user would.
   * The command shows up in the terminal the user is watching and shares its cwd/env/venv.
   */
  runCommand(cmd: string, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    return this.runQueue.run(() => this.doRun(cmd, opts.timeoutMs ?? 120_000));
  }

  private async doRun(cmd: string, timeoutMs: number): Promise<RunResult> {
    if (!this._alive) throw new RunRefused('The shell has exited.', 'exited');
    if (!this.integrated) throw new RunRefused('Shell integration is not active in this session.', 'no-integration');
    const busy = () => new RunRefused(`The terminal is busy${this.running ? ` running \`${this.running.cmd}\`` : ''}.`, 'busy');
    if (this.running || this.altScreen) throw busy();
    // Between a command finishing and the next prompt being drawn there is a short gap; wait it out.
    if (!this.promptReady && !(await this.waitUntilPrompt(2000))) throw busy();
    if (this.running || this.altScreen) throw busy();
    this.nextBy = 'agent';
    this.injecting = true;
    const multiline = cmd.includes('\n');
    const payload = multiline && this.term.modes.bracketedPasteMode ? `\x1b[200~${cmd}\x1b[201~\r` : multiline ? cmd.replace(/\n+/g, '; ') + '\r' : cmd + '\r';
    const done = new Promise<RunResult>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let started = false;
      const t0 = Date.now();
      const off = this.events.on((e) => {
        if (e.type === 'command' && e.by === 'agent') {
          if (timer) clearTimeout(timer);
          off();
          resolve({ cmd: e.cmd || cmd, exit: e.exit, output: e.output, durMs: e.durMs, timedOut: false, cwd: e.cwd });
        }
      });
      timer = setTimeout(() => {
        off();
        started = this.running !== null;
        resolve({ cmd, exit: null, output: started ? this.partialOutput() : '', durMs: Date.now() - t0, timedOut: true, cwd: this.cwd });
      }, timeoutMs);
    });
    this.write(payload);
    // If the shell never starts the command (e.g. unfinished quote in the user's prompt), fail fast.
    const startedOk = await Promise.race([this.waitUntilStarted(5000), done.then(() => true)]);
    if (!startedOk) {
      this.nextBy = 'user';
      this.injecting = false;
      throw new RunRefused('The shell did not start the command (is something half-typed at the prompt?).', 'not-started');
    }
    return done;
  }

  private async waitUntilPrompt(ms: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.promptReady) return true;
      if (this.running || !this._alive) return false;
      await sleep(10);
    }
    return this.promptReady;
  }

  private async waitUntilStarted(ms: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.running || !this.injecting) return true;
      await sleep(15);
    }
    return false;
  }

  private partialOutput(): string {
    const run = this.running;
    if (!run) return '';
    const normal = this.term.buffer.normal;
    const start = run.marker && run.marker.line >= 0 ? run.marker.line : 0;
    return this.linesToText(normal, start, normal.baseY + normal.cursorY);
  }
}
