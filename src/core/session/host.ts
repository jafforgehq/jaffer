import fs from 'node:fs';
import os from 'node:os';
import type { JafferPaths } from '../../shared/paths';
import type { ConfigStore } from '../../shared/config';
import { Emitter, ensureDir, nowIso, readJson, writeJson } from '../../shared/util';
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

interface SavedState {
  version: number;
  startedAt: string;
  savedAt: string;
  panes: { id: string; cwd: string; cols: number; rows: number }[];
}

interface SavedScreens {
  [paneId: string]: { data: string };
}

const MAIN = 'main';
const RESPAWN_MIN_MS = 150;
const RESPAWN_MAX_MS = 10_000;
/** A shell that lived this long was a working one: the next respawn is quick again. */
const HEALTHY_MS = 3_000;

/**
 * Owns the one session: a single terminal. There is no way to open a second one, by design. The shell lives in the
 * daemon, so closing the app never kills it; on a cold start the previous screen and working directory are restored.
 */
export class SessionHost {
  readonly events = new Emitter<HostEvent>();
  private panes = new Map<string, PtySession>();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private startedAt = nowIso();
  private disposed = false;
  private restarting = new Set<string>();
  /** How long to wait before the next respawn: short normally, longer each time the shell dies within seconds of starting. */
  private backoffMs = RESPAWN_MIN_MS;
  private spawnedAt = 0;

  private offConfig: (() => void) | null = null;

  constructor(
    private paths: JafferPaths,
    private config: ConfigStore,
    private version: string,
  ) {
    ensureDir(paths.sessionDir);
    installShellIntegration(paths);
    ensureDir(paths.binDir);
    // switched off: what was saved goes at once, not at the next save; switched on: saving starts again
    this.offConfig = config.onChange.on((c) => {
      if (c.session.restoreScreen) this.dirty = true;
      else fs.rmSync(paths.screenSnapshot, { force: true });
    });
  }

  /** Is the screen saved so it can come back (Settings → Appearance)? The folder is restored either way. */
  private keepsScreen(): boolean {
    return this.config.get().session.restoreScreen;
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

  /** Start (or restore) the session. Safe to call once at daemon start. */
  async start(): Promise<void> {
    const saved = readJson<SavedState | null>(this.paths.sessionState, null);
    const screens = this.keepsScreen() ? readJson<SavedScreens>(this.paths.screenSnapshot, {}) : {};
    // Only the one session is restored; any other pane an older version left in the state file is dropped.
    const def = saved?.panes?.find((p) => p.id === MAIN) ?? { id: MAIN, cwd: os.homedir(), cols: 120, rows: 32 };
    const cwd = fs.existsSync(def.cwd) ? def.cwd : os.homedir();
    await this.spawn(MAIN, { cwd, cols: def.cols, rows: def.rows, restoreScreen: screens[MAIN]?.data, restoredAt: saved?.savedAt });
    this.persistTimer = setInterval(() => this.persistIfDirty(), 4000);
    this.persistTimer.unref?.();
    this.persist();
  }

  async spawn(id: string, o: { cwd?: string; cols?: number; rows?: number; restoreScreen?: string; restoredAt?: string } = {}): Promise<PtySession> {
    if (id !== MAIN) throw new Error('There is only one session.');
    const cfg = this.config.get();
    const shell = cfg.shell.path && fs.existsSync(cfg.shell.path) ? cfg.shell.path : defaultShell();
    const spawn = buildShellSpawn({ shell, extraArgs: cfg.shell.args, paths: this.paths, baseEnv: process.env, version: this.version });
    const cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : os.homedir();
    const session = new PtySession({ file: spawn.file, args: spawn.args, cwd, env: spawn.env, cols: o.cols ?? 120, rows: o.rows ?? 32, scrollback: 10_000, shellKind: spawn.kind });
    this.panes.set(id, session);
    this.spawnedAt = Date.now();
    // Queue the restored screen *before* any shell output can arrive.
    if (o.restoreScreen) {
      const when = o.restoredAt ? ` ${new Date(o.restoredAt).toLocaleString()}` : '';
      void session.inject(o.restoreScreen + `\x1b[0m\r\n\x1b[2m── session restored${when} ──\x1b[0m\r\n`);
    }
    session.events.on((event) => {
      if (event.type === 'data' || event.type === 'command' || event.type === 'cwd') this.dirty = true;
      this.events.emit({ pane: id, event });
      if (event.type === 'exit') void this.onExit(id, session);
    });
    this.events.emit({ pane: id, lifecycle: 'spawned' });
    this.dirty = true;
    return session;
  }

  private async onExit(id: string, session: PtySession): Promise<void> {
    if (this.disposed || this.panes.get(id) !== session) return;
    // The one session never goes away: start a fresh shell in the same place.
    if (this.restarting.has(id)) return;
    this.restarting.add(id);
    this.backoffMs = Date.now() - this.spawnedAt < HEALTHY_MS ? Math.min(this.backoffMs * 2, RESPAWN_MAX_MS) : RESPAWN_MIN_MS;
    const { cwd, cols, rows } = session;
    const snap = session.snapshot();
    session.dispose();
    try {
      // A shell that cannot start (a bad path, no ptys left) is tried again, each time after a longer wait: the one session
      // must not stay dead because a single attempt threw, and must not burn the CPU on a shell that dies at once.
      for (;;) {
        await new Promise((r) => setTimeout(r, this.backoffMs));
        if (this.disposed) return;
        try {
          await this.spawn(id, { cwd, cols, rows, restoreScreen: snap.data });
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

  // ------------------------------------------------------------ persistence

  private persistIfDirty(): void {
    if (this.dirty) this.persist();
  }

  persist(): void {
    this.dirty = false;
    try {
      const state: SavedState = {
        version: 1,
        startedAt: this.startedAt,
        savedAt: nowIso(),
        panes: [...this.panes.entries()].filter(([, p]) => p.alive).map(([id, p]) => ({ id, cwd: p.cwd, cols: p.cols, rows: p.rows })),
      };
      writeJson(this.paths.sessionState, state);
      if (!this.keepsScreen()) {
        fs.rmSync(this.paths.screenSnapshot, { force: true }); // nothing of the screen is kept on disk
        return;
      }
      const screens: SavedScreens = {};
      for (const [id, p] of this.panes) {
        if (!p.alive) continue;
        const s = p.snapshot(3000);
        screens[id] = { data: s.data };
      }
      writeJson(this.paths.screenSnapshot, screens);
    } catch {
      /* persistence must never take the session down */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.offConfig?.();
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persist();
    for (const p of this.panes.values()) p.dispose();
    this.panes.clear();
  }
}

