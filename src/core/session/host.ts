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

export type HostEvent = { pane: string; event: PtyEvent } | { pane: string; lifecycle: 'spawned' | 'restarted' };

const MAIN = 'main';
const RESPAWN_MIN_MS = 150;
const RESPAWN_MAX_MS = 10_000;
/** A shell that lived this long was a working one: the next respawn is quick again. */
const HEALTHY_MS = 3_000;

/**
 * Owns the one session: a single terminal. There is no way to open a second one, by design. Nothing of it is saved: a start is a
 * plain shell in the home folder with a blank screen, and a shell that exits is replaced by a fresh one in the folder it was in.
 */
export class SessionHost {
  readonly events = new Emitter<HostEvent>();
  private panes = new Map<string, PtySession>();
  private disposed = false;
  private restarting = new Set<string>();
  /** How long to wait before the next respawn: short normally, longer each time the shell dies within seconds of starting. */
  private backoffMs = RESPAWN_MIN_MS;
  private spawnedAt = 0;

  constructor(
    private paths: JafferPaths,
    private config: ConfigStore,
    private version: string,
  ) {
    installShellIntegration(paths);
    ensureDir(paths.binDir);
  }

  get mainPane(): PtySession | undefined {
    return this.panes.get(MAIN);
  }

  get(id: string = MAIN): PtySession | undefined {
    return this.panes.get(id);
  }

  list(): PaneInfo[] {
    return [...this.panes.entries()].map(([id, p]) => ({ id, pid: p.pid, cwd: p.cwd, title: p.title, cols: p.cols, rows: p.rows, busy: p.runningCommand, alive: p.alive }));
  }

  /** Start the session: a shell in the home folder (the window resizes it when it attaches). Safe to call once at daemon start. */
  async start(): Promise<void> {
    await this.spawn(MAIN);
  }

  async spawn(id: string, o: { cwd?: string; cols?: number; rows?: number } = {}): Promise<PtySession> {
    if (id !== MAIN) throw new Error('There is only one session.');
    const cfg = this.config.get();
    const shell = cfg.shell.path && fs.existsSync(cfg.shell.path) ? cfg.shell.path : defaultShell();
    const spawn = buildShellSpawn({ shell, extraArgs: cfg.shell.args, paths: this.paths, baseEnv: process.env, version: this.version });
    const cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : os.homedir();
    const session = new PtySession({ file: spawn.file, args: spawn.args, cwd, env: spawn.env, cols: o.cols ?? 120, rows: o.rows ?? 32, scrollback: 10_000 });
    this.panes.set(id, session);
    this.spawnedAt = Date.now();
    session.events.on((event) => {
      this.events.emit({ pane: id, event });
      if (event.type === 'exit') void this.onExit(id, session);
    });
    this.events.emit({ pane: id, lifecycle: 'spawned' });
    return session;
  }

  private async onExit(id: string, session: PtySession): Promise<void> {
    if (this.disposed || this.panes.get(id) !== session) return;
    // The one session never goes away: start a fresh shell in the same place, with a blank screen (the old one is not carried over).
    if (this.restarting.has(id)) return;
    this.restarting.add(id);
    this.backoffMs = Date.now() - this.spawnedAt < HEALTHY_MS ? Math.min(this.backoffMs * 2, RESPAWN_MAX_MS) : RESPAWN_MIN_MS;
    const { cwd, cols, rows } = session;
    session.dispose();
    try {
      // A shell that cannot start (a bad path, no ptys left) is tried again, each time after a longer wait: the one session
      // must not stay dead because a single attempt threw, and must not burn the CPU on a shell that dies at once.
      for (;;) {
        await new Promise((r) => setTimeout(r, this.backoffMs));
        if (this.disposed) return;
        try {
          await this.spawn(id, { cwd, cols, rows });
          break;
        } catch {
          this.backoffMs = Math.min(this.backoffMs * 2, RESPAWN_MAX_MS);
        }
      }
    } finally {
      this.restarting.delete(id);
    }
    this.events.emit({ pane: id, lifecycle: 'restarted' });
  }

  async restartMain(): Promise<void> {
    const s = this.mainPane;
    if (!s) return;
    s.kill();
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.panes.values()) p.dispose();
    this.panes.clear();
  }
}

