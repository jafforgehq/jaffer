import { execFile, spawn } from 'node:child_process';

/**
 * Is the user signed in to Claude Code? Jaffer is for Claude Code only, so the first run walks the user through
 * signing in, and the panel offers it again if the login lapses. Both go through the `claude` CLI itself
 * (`claude auth status` / `claude auth login`), so Jaffer never sees credentials.
 */

export interface ClaudeAuth {
  installed: boolean;
  loggedIn: boolean;
}

/**
 * Ask the CLI whether a login exists. Only the loggedIn flag is read: the account email and organisation in its
 * answer stay inside this function. Anything unreadable, slow or failing counts as signed out.
 */
export function claudeAuth(claude: string | null, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<ClaudeAuth> {
  if (!claude) return Promise.resolve({ installed: false, loggedIn: false });
  return new Promise((resolve) => {
    execFile(claude, ['auth', 'status', '--json'], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      resolve({ installed: true, loggedIn: /"loggedIn"\s*:\s*true/.test(String(stdout)) });
    });
  });
}

export interface LoginResult {
  ok: boolean;
  message?: string;
}

/** One `claude auth login` at a time. It opens the user's browser and ends when they finish (or give up). */
export class ClaudeLogin {
  private child: ReturnType<typeof spawn> | null = null;
  private pending: Promise<LoginResult> | null = null;
  private cancelled = false;

  constructor(
    private claude: string,
    private env: NodeJS.ProcessEnv,
    private timeoutMs = 10 * 60_000,
  ) {}

  get running(): boolean {
    return this.pending !== null;
  }

  /** Start a login, or join the one already running. */
  start(): Promise<LoginResult> {
    if (this.pending) return this.pending;
    this.cancelled = false;
    this.pending = new Promise<LoginResult>((resolve) => {
      let tail = '';
      let timedOut = false;
      let child: ReturnType<typeof spawn> | undefined;
      const finish = (r: LoginResult) => {
        clearTimeout(timer);
        this.child = null;
        this.pending = null;
        resolve(r);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child?.kill('SIGKILL');
      }, this.timeoutMs);
      try {
        child = spawn(this.claude, ['auth', 'login'], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        finish({ ok: false, message: e instanceof Error ? e.message : String(e) });
        return;
      }
      this.child = child;
      const keep = (d: Buffer) => (tail = (tail + d.toString()).slice(-600));
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.on('error', (e) => finish({ ok: false, message: e.message }));
      child.on('close', (code) => {
        if (this.cancelled) return finish({ ok: false, message: 'cancelled' });
        if (timedOut) return finish({ ok: false, message: 'Sign-in timed out. Try again.' });
        if (code === 0) return finish({ ok: true });
        finish({ ok: false, message: tail.trim().replace(/\s+/g, ' ').slice(-300) || `claude auth login exited with code ${code}` });
      });
    });
    return this.pending;
  }

  /** Stop a login that is waiting for the browser. */
  cancel(): void {
    if (!this.child) return;
    this.cancelled = true;
    this.child.kill('SIGKILL');
  }
}
