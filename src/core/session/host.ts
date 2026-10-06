import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export type HostEvent = { pane: string; event: PtyEvent } | { pane: string; lifecycle: 'spawned' | 'closed' | 'restarted' };

interface SavedState {
  version: number;
  startedAt: string;
  savedAt: string;
  panes: { id: string; cwd: string; cols: number; rows: number }[];
}

interface SavedScreens {
  [paneId: string]: { data: string; cols: number; rows: number; cwd: string; savedAt: string };
}

const MAIN = 'main';

/**
 * Owns the one session: its terminal panes. The shell(s) live in the daemon, so closing the
 * app never kills them; on a cold start the previous screen and working directory are restored.
 */
export class SessionHost {
  readonly events = new Emitter<HostEvent>();
  private panes = new Map<string, PtySession>();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private startedAt = nowIso();
  private disposed = false;
  private restarting = new Set<string>();

  constructor(
    private paths: JafferPaths,
    private config: ConfigStore,
    private version: string,
  ) {
    ensureDir(paths.sessionDir);
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

  /** Start (or restore) the session. Safe to call once at daemon start. */
  async start(): Promise<void> {
    const saved = readJson<SavedState | null>(this.paths.sessionState, null);
    const screens = readJson<SavedScreens>(this.paths.screenSnapshot, {});
    const paneDefs = saved?.panes?.length ? saved.panes : [{ id: MAIN, cwd: os.homedir(), cols: 120, rows: 32 }];
    if (!paneDefs.some((p) => p.id === MAIN)) paneDefs.unshift({ id: MAIN, cwd: os.homedir(), cols: 120, rows: 32 });
    for (const def of paneDefs) {
      const cwd = fs.existsSync(def.cwd) ? def.cwd : os.homedir();
      const restoredScreen = screens[def.id]?.data;
      await this.spawn(def.id, { cwd, cols: def.cols, rows: def.rows, restoreScreen: restoredScreen, restoredAt: saved?.savedAt });
    }
    this.persistTimer = setInterval(() => this.persistIfDirty(), 4000);
    this.persistTimer.unref?.();
    this.persist();
  }

  async spawn(id: string, o: { cwd?: string; cols?: number; rows?: number; restoreScreen?: string; restoredAt?: string; banner?: string } = {}): Promise<PtySession> {
    const cfg = this.config.get();
    const shell = cfg.shell.path && fs.existsSync(cfg.shell.path) ? cfg.shell.path : defaultShell();
    const spawn = buildShellSpawn({ shell, extraArgs: cfg.shell.args, paths: this.paths, baseEnv: process.env, version: this.version });
    const cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : os.homedir();
    const session = new PtySession({ file: spawn.file, args: spawn.args, cwd, env: spawn.env, cols: o.cols ?? 120, rows: o.rows ?? 32, scrollback: 10_000 });
    this.panes.set(id, session);
    // Queue the restored screen *before* any shell output can arrive.
    if (o.restoreScreen) {
      const when = o.restoredAt ? ` ${new Date(o.restoredAt).toLocaleString()}` : '';
      void session.inject(o.restoreScreen + `\x1b[0m\r\n\x1b[2m── session restored${when} ──\x1b[0m\r\n`);
    } else if (o.banner) {
      void session.inject(o.banner);
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
    if (id !== MAIN) {
      this.panes.delete(id);
      session.dispose();
      this.events.emit({ pane: id, lifecycle: 'closed' });
      this.persist();
      return;
    }
    // The one session never goes away: start a fresh shell in the same place.
    if (this.restarting.has(id)) return;
    this.restarting.add(id);
    const { cwd, cols, rows } = session;
    const snap = session.snapshot();
    session.dispose();
    await new Promise((r) => setTimeout(r, 150));
    if (this.disposed) return;
    await this.spawn(id, { cwd, cols, rows, restoreScreen: snap.data, banner: undefined });
    this.restarting.delete(id);
    this.events.emit({ pane: id, lifecycle: 'restarted' });
  }

  async split(cwd?: string): Promise<string> {
    const id = `p${Math.random().toString(36).slice(2, 6)}`;
    const base = this.mainPane;
    await this.spawn(id, { cwd: cwd ?? base?.cwd, cols: base?.cols, rows: base?.rows });
    this.persist();
    return id;
  }

  close(id: string): boolean {
    if (id === MAIN) return false;
    const p = this.panes.get(id);
    if (!p) return false;
    p.kill();
    return true;
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
      const screens: SavedScreens = {};
      for (const [id, p] of this.panes) {
        if (!p.alive) continue;
        const s = p.snapshot(3000);
        screens[id] = { data: s.data, cols: s.cols, rows: s.rows, cwd: s.cwd, savedAt: state.savedAt };
      }
      writeJson(this.paths.screenSnapshot, screens);
    } catch {
      /* persistence must never take the session down */
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persist();
    for (const p of this.panes.values()) p.dispose();
    this.panes.clear();
  }
}

