import { cleanVersion, isNewer, promptText, shouldAsk, type PromptText, type UpdateState, type UpdateStatus } from '../shared/update-policy';

/**
 * The update flow, with everything that touches the outside world injected (the updater, the dialog, ending the session),
 * so it is tested with fakes. Policy: check shortly after launch and every few hours, download in the background, then
 * ASK; nothing is ever installed without a yes (see docs/superpowers/specs/2026-10-07-updater-design.md).
 */

export interface UpdaterLike {
  on(ev: 'checking-for-update' | 'update-available' | 'update-not-available' | 'update-downloaded' | 'download-progress' | 'error', cb: (arg?: any) => void): unknown;
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null | undefined | void>;
  quitAndInstall(silent?: boolean, forceRun?: boolean): void;
}

export interface UpdateDeps {
  updater: UpdaterLike;
  /** The running version. */
  current: string;
  /** False for builds that cannot update themselves (dev, unsigned, ad-hoc). */
  enabled: boolean;
  /** Settings → Updates → Check automatically. */
  auto: () => boolean;
  /**
   * Show the prompt; true = update now. `text` is built by the caller when the dialog is about to appear (the Claude warning
   * must be current), `manual` says the user asked for it (bring the window forward).
   */
  ask(text: () => PromptText, version: string, manual: boolean): Promise<boolean>;
  claudeBusy(): boolean;
  /** End the session and let the app quit; called right before the install. */
  prepareInstall(): Promise<void>;
  log(msg: string): void;
  onState?(s: UpdateState): void;
  /** Shown instead of a generic message when `enabled` is false. */
  unavailableReason?: string;
  firstCheckMs?: number;
  intervalMs?: number;
  /** A check that has not answered by then counts as failed (default 90 s). */
  checkTimeoutMs?: number;
  /** A download with no progress for this long counts as stalled (default 15 min). */
  downloadStallMs?: number;
}

const MAX_ERROR = 200;
const DOWNLOAD_GRACE_MS = 1500;

export class UpdateController {
  private status: UpdateStatus;
  private version: string | undefined;
  private error: string | undefined;
  private declined: string | null = null;
  private asking = false;
  private manual = false;
  private running: Promise<UpdateState> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private last = '';
  private lastActivity = 0;

  constructor(private d: UpdateDeps) {
    this.status = d.enabled ? 'idle' : 'unavailable';
    if (!d.enabled) return;
    const u = d.updater;
    u.on('checking-for-update', () => {
      if (this.status !== 'ready' && this.status !== 'downloading') this.set('checking');
    });
    u.on('update-available', (info) => {
      const v = this.usable(info?.version);
      if (v && !(this.status === 'ready' && this.version === v)) this.set('downloading', { version: v });
    });
    u.on('update-not-available', () => {
      if (this.status !== 'ready') this.set('uptodate');
    });
    u.on('download-progress', () => {
      this.lastActivity = Date.now();
    });
    u.on('update-downloaded', (info) => {
      const v = this.usable(info?.version);
      if (!v) return;
      this.set('ready', { version: v });
      void this.offer(v);
    });
    u.on('error', (e) => this.onError(e));
  }

  state(): UpdateState {
    return { status: this.status, current: this.d.current, version: this.version, error: this.status === 'unavailable' ? this.d.unavailableReason : this.error, auto: this.d.auto() };
  }

  start(): void {
    if (!this.d.enabled || this.timers.length) return;
    const tick = () => {
      if (this.d.auto()) void this.check(false);
    };
    const first = setTimeout(tick, this.d.firstCheckMs ?? 15_000);
    const every = setInterval(tick, this.d.intervalMs ?? 6 * 3600_000);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  stop(): void {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  /** A check the user asked for: always answers, and asks again about an update that is already waiting. */
  checkNow(): Promise<UpdateState> {
    return this.check(true);
  }

  private usable(v: unknown): string | null {
    const clean = cleanVersion(v);
    if (clean && isNewer(clean, this.d.current)) return clean;
    this.d.log(`ignored version from the feed: ${typeof v === 'string' ? v.slice(0, 40) : typeof v}`);
    return null;
  }

  private set(status: UpdateStatus, o: { version?: string; error?: string } = {}): void {
    this.status = status;
    if (status === 'downloading') this.lastActivity = Date.now();
    this.version = o.version ?? (status === 'ready' || status === 'downloading' ? this.version : undefined);
    this.error = o.error;
    const s = this.state();
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    this.d.onState?.(s);
  }

  private onError(e: unknown): void {
    const msg = (e instanceof Error ? e.message : String(e ?? 'unknown error')).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR);
    this.d.log(`update error: ${msg}`);
    if (this.status === 'ready') return; // the downloaded update is still good; a failed later check must not hide it
    this.set('error', { error: msg });
  }

  private check(manual: boolean): Promise<UpdateState> {
    if (!this.d.enabled) return Promise.resolve(this.state());
    if (manual) {
      if (this.status === 'ready' && this.version) {
        this.manual = true;
        void this.offer(this.version);
        return Promise.resolve(this.state());
      }
    }
    if (this.status === 'downloading' && !this.stalled()) return Promise.resolve(this.state());
    if (this.running) {
      if (manual) this.manual = true; // the user asked while a background check was running: the answer is for them
      return this.running;
    }
    this.manual = manual;
    this.running = (async () => {
      this.error = undefined;
      try {
        const r = await this.withTimeout(this.d.updater.checkForUpdates());
        const download = r && r.downloadPromise ? r.downloadPromise.catch((e) => void this.onError(e)) : null; // always handled: a failed background download is not an unhandled rejection
        if (manual && this.status === 'downloading' && download) {
          // an update downloaded earlier is "downloaded" again within moments; wait briefly so the answer is "ready"
          await Promise.race([download, new Promise((res) => setTimeout(res, DOWNLOAD_GRACE_MS))]);
        }
        if (this.status === 'checking') this.set('uptodate');
      } catch (e) {
        this.onError(e);
      } finally {
        this.running = null;
      }
      return this.state();
    })();
    return this.running;
  }

  private stalled(): boolean {
    return Date.now() - this.lastActivity > (this.d.downloadStallMs ?? 15 * 60_000);
  }

  /** The updater library has no working request timeout under Electron, so a stuck network call must not stick the controller too. */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The check timed out')), this.d.checkTimeoutMs ?? 90_000);
    });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
  }

  private async offer(version: string): Promise<void> {
    const manual = this.manual;
    this.manual = false;
    if (this.asking || !shouldAsk({ manual, declined: this.declined, version })) return;
    this.asking = true;
    try {
      const yes = await this.d.ask(() => promptText({ version: this.version ?? version, claudeBusy: this.d.claudeBusy() }), version, manual);
      if (!yes) {
        this.declined = version;
        return;
      }
      await this.d.prepareInstall();
      this.d.updater.quitAndInstall(false, true);
    } catch (e) {
      this.d.log(`update prompt failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.asking = false;
    }
  }
}
