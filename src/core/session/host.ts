import fs from 'node:fs';
import os from 'node:os';
import type { JafferPaths } from '../../shared/paths';
import type { ConfigStore } from '../../shared/config';
import { Emitter, ensureDir } from '../../shared/util';
import { PtySession, type PtyEvent } from './terminal';
import { buildShellSpawn, defaultShell, installShellIntegration } from './shell-integration';

export interface PaneInfo {
  id: string;
  pid: number;
  cwd: string;
  title: string;
  cols: number;
  rows: number;
  busy: string | null;
  alive: boolean;
}

export type HostEvent = { pane: string; event: PtyEvent } | { pane: string; lifecycle: 'spawned' | 'restarted' | 'closed' };

const MAIN = 'main';
/** The terminals there can be, in order: the first, then the ones a split adds. A closed one's id is free for the next split. */
const IDS = [MAIN, 'p2', 'p3', 'p4'];
const RESPAWN_MIN_MS = 150;
const RESPAWN_MAX_MS = 10_000;
/** A shell that lived this long was a working one: the next respawn is quick again. */
const HEALTHY_MS = 3_000;

/**
 * Owns the session: up to four terminals, the first at start and the others only when the person splits (`split`), each its own shell.
 * Nothing of them is saved: a start is one plain shell in the home folder with a blank screen, a shell that exits by itself is replaced by
 * a fresh one in the folder it was in, and a terminal the person closes (`close`) is gone for good (never the last one: that one restarts).
 */
export class SessionHost {
  readonly events = new Emitter<HostEvent>();
  private panes = new Map<string, PtySession>();
  private disposed = false;
  private restarting = new Set<PtySession>();
  /** Per terminal: how long to wait before the next respawn (short normally, longer each time the shell dies within seconds of starting), and when it last started. */
  private backoffMs = new Map<string, number>();
  private spawnedAt = new Map<string, number>();

  constructor(
    private paths: JafferPaths,
    private config: ConfigStore,
    private version: string,
  ) {
    installShellIntegration(paths);
    ensureDir(paths.binDir);
  }

  /** The terminal asked for by id; with none, the first (`main`, or the first left when it was closed). */
  get(id?: string): PtySession | undefined {
    return this.panes.get(id ?? this.firstId);
  }

  get firstId(): string {
    return this.panes.has(MAIN) ? MAIN : (IDS.find((i) => this.panes.has(i)) ?? MAIN);
  }

  list(): PaneInfo[] {
    return IDS.flatMap((id) => {
      const p = this.panes.get(id);
      return p ? [{ id, pid: p.pid, cwd: p.cwd, title: p.title, cols: p.cols, rows: p.rows, busy: p.runningCommand, alive: p.alive }] : [];
    });
  }

  /** Start the session: a shell in the home folder (the window resizes it when it attaches). Safe to call once at daemon start. */
  async start(): Promise<void> {
    await this.spawn(MAIN);
  }

  /** One more terminal (the person split one): a fresh shell, in `cwd` when it exists. Refused at four. */
  async split(o: { cwd?: string; cols?: number; rows?: number } = {}): Promise<PaneInfo> {
    const id = IDS.find((i) => !this.panes.has(i));
    if (!id) throw new Error('At most four terminals.');
    await this.spawn(id, o);
    return this.list().find((p) => p.id === id)!;
  }

  /** The person closed a terminal: its shell ends and it is not replaced. The last one is never closed (it restarts instead). */
  close(id: string): void {
    const s = this.panes.get(id);
    if (!s) throw new Error(`No such terminal: ${id}`);
    if (this.panes.size === 1) throw new Error('Use restart for the last terminal.');
    this.panes.delete(id); // (first: its exit is not a reason to respawn it)
    this.backoffMs.delete(id);
    this.spawnedAt.delete(id);
    s.dispose();
    this.events.emit({ pane: id, lifecycle: 'closed' });
  }

  private async spawn(id: string, o: { cwd?: string; cols?: number; rows?: number } = {}): Promise<PtySession> {
    const cfg = this.config.get();
    const shell = cfg.shell.path && fs.existsSync(cfg.shell.path) ? cfg.shell.path : defaultShell();
    const spawn = buildShellSpawn({ shell, extraArgs: cfg.shell.args, paths: this.paths, baseEnv: process.env, version: this.version, pane: id });
    const cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : os.homedir();
    const size = (v: number | undefined, max: number, d: number) => (Number.isFinite(v) ? Math.max(2, Math.min(max, Math.floor(v!))) : d);
    const session = new PtySession({ file: spawn.file, args: spawn.args, cwd, env: spawn.env, cols: size(o.cols, 1000, 120), rows: size(o.rows, 500, 32), scrollback: 10_000 });
    this.panes.set(id, session);
    this.spawnedAt.set(id, Date.now());
    session.events.on((event) => {
      if (this.panes.get(id) !== session) return; // (a closed terminal, or one already replaced, says nothing more)
      this.events.emit({ pane: id, event });
      if (event.type === 'exit') void this.onExit(id, session);
    });
    this.events.emit({ pane: id, lifecycle: 'spawned' });
    return session;
  }

  private async onExit(id: string, session: PtySession): Promise<void> {
    if (this.disposed || this.panes.get(id) !== session) return;
    // A terminal never goes away by itself: start a fresh shell in the same place, with a blank screen (the old one is not carried over).
    if (this.restarting.has(session)) return;
    this.restarting.add(session);
    const quick = Date.now() - (this.spawnedAt.get(id) ?? 0) < HEALTHY_MS;
    let backoff = quick ? Math.min((this.backoffMs.get(id) ?? RESPAWN_MIN_MS) * 2, RESPAWN_MAX_MS) : RESPAWN_MIN_MS;
    const { cwd, cols, rows } = session;
    session.dispose();
    try {
      // A shell that cannot start (a bad path, no ptys left) is tried again, each time after a longer wait: a terminal must not stay
      // dead because a single attempt threw, and must not burn the CPU on a shell that dies at once.
      for (;;) {
        this.backoffMs.set(id, backoff);
        await new Promise((r) => setTimeout(r, backoff));
        if (this.disposed || this.panes.get(id) !== session) return; // (closed meanwhile)
        try {
          await this.spawn(id, { cwd, cols, rows });
          break;
        } catch {
          backoff = Math.min(backoff * 2, RESPAWN_MAX_MS);
        }
      }
    } finally {
      this.restarting.delete(session);
    }
    this.events.emit({ pane: id, lifecycle: 'restarted' });
  }

  /** Restart shell: that terminal's shell ends and a fresh one replaces it (see `onExit`). */
  async restart(id: string = this.firstId): Promise<void> {
    this.panes.get(id)?.kill();
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.panes.values()) p.dispose();
    this.panes.clear();
  }
}
