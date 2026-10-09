import { execFile } from 'node:child_process';
import path from 'node:path';
import { AGENT_LABEL } from '../../shared/keep-running';

/**
 * The login agent that owns the daemon (`~/Library/LaunchAgents/com.jafforge.jaffer.daemon.plist`, loaded into the person's `gui/<uid>`
 * domain): the text of the plist and of the wrapper it runs, the rules that refuse it, and the install / remove / reconcile / status
 * steps. `launchctl` and the file system are injected, so the tests never touch the real ones.
 *
 * The decision comes from the person's switch (`session.keepRunning`) and happens only for the default home: Task 9 wires the switch,
 * the RPCs and `jaffer service`. Nothing in this file reads the config or starts a daemon.
 */

export interface PlanInput {
  /** The Jaffer home this daemon runs with (`JAFFER_HOME`). */
  home: string;
  /** The home of the person's own Jaffer, `~/.jaffer`. Any other home is refused: tests and development homes never get an agent. */
  defaultHome: string;
  /** The person's home folder: where `Library/LaunchAgents` is. */
  userHome: string;
  uid: number;
  platform: string;
  /** The binary that runs the daemon script: the app's own executable (Electron, run as node) or node. */
  execPath: string;
  daemonScript: string;
  /** `execPath` is Electron's binary, which needs `ELECTRON_RUN_AS_NODE=1` to run a script. */
  electron: boolean;
}

export interface AgentPlan {
  plistPath: string;
  wrapperPath: string;
  plist: string;
  wrapper: string;
}

export interface Launchctl {
  run(args: string[]): Promise<{ code: number; out: string }>;
}

export type AgentStatus = { state: 'not-installed' } | { state: 'running'; pid: number } | { state: 'not-loaded' } | { state: 'refused'; reason: string };

/** What the agent needs from the file system (a fake in the tests). */
export type LaunchAgentFs = Pick<typeof import('node:fs'), 'writeFileSync' | 'mkdirSync' | 'rmSync' | 'existsSync' | 'chmodSync' | 'readFileSync'>;

/** Where the agent's files are: the plist in the person's LaunchAgents folder, the wrapper in the Jaffer home. */
export function agentPaths(i: Pick<PlanInput, 'home' | 'userHome'>): { plistPath: string; wrapperPath: string } {
  return {
    plistPath: path.join(i.userHome, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
    wrapperPath: path.join(i.home, 'bin', 'jafferd'),
  };
}

/** Text for an XML element: the five characters XML reserves are written as entities. */
function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A word for sh: single-quoted, an embedded single quote written as '\''. Nothing inside single quotes is expanded. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** XML 1.0 cannot carry a control character at all, so a plist for a path with one would not load. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The files for the agent, or why there can be none. The plist holds no secret: the label, how launchd restarts the job (only after a
 * failure: a deliberate end exits 0), where the log goes and `JAFFER_HOME`, nothing else.
 */
export function planAgent(i: PlanInput): AgentPlan | { refused: string } {
  if (i.platform !== 'darwin') return { refused: 'Keeping the session running in the background works on macOS only.' };
  if (i.home !== i.defaultHome) return { refused: 'Only the usual Jaffer folder (~/.jaffer) can be kept running by macOS; this Jaffer uses another folder (JAFFER_HOME).' };
  if ([i.home, i.userHome, i.execPath, i.daemonScript].some((p) => CONTROL.test(p))) return { refused: 'A folder name with a control character cannot be used for the background agent.' };
  if (i.execPath.includes('/AppTranslocation/') || i.execPath.startsWith('/Volumes/')) {
    return { refused: 'Jaffer is running from a disk image or a temporary location. Move Jaffer to Applications first.' };
  }
  const { plistPath, wrapperPath } = agentPaths(i);
  const log = path.join(i.home, 'run', 'jafferd.log');
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(AGENT_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(wrapperPath)}</string>`,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>JAFFER_HOME</key>',
    `    <string>${xml(i.home)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>LimitLoadToSessionType</key>',
    '  <string>Aqua</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  // The wrapper is what launchd runs, so that the plist never has to change when the app moves. When the app it was written for is
  // gone, it takes the agent away instead of failing for ever. The files go first: the bootout ends this very script.
  const app = shq(i.execPath);
  const wrapper = [
    '#!/bin/sh',
    '# Written by Jaffer for launchd. Jaffer rewrites it whenever it starts; do not edit.',
    `if [ ! -x ${app} ]; then`,
    '  # the app this was written for is gone (deleted or moved)',
    `  /bin/rm -f ${shq(plistPath)} ${shq(wrapperPath)}`,
    `  /bin/launchctl bootout gui/${i.uid}/${AGENT_LABEL} >/dev/null 2>&1`,
    '  exit 0',
    'fi',
    `${i.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${app} ${shq(i.daemonScript)}`,
    '',
  ].join('\n');
  return { plistPath, wrapperPath, plist, wrapper };
}

/** The real `launchctl`. It never rejects: a failed run, or one that could not start, is a code that is not 0 and what was printed. */
export function execLaunchctl(): Launchctl {
  return {
    run: (args) =>
      new Promise((resolve) => {
        execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
          const out = `${stdout ?? ''}${stderr ?? ''}`;
          if (!err) return resolve({ code: 0, out });
          const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          resolve({ code: typeof code === 'number' && code !== 0 ? code : 1, out: out || err.message });
        });
      }),
  };
}

/** `launchctl print` names the process of a running job on a line of its own: `pid = 1234`. */
const PID = /^\s*pid = (\d+)\s*$/m;

export class LaunchAgent {
  private readonly launchctl: Launchctl;
  private readonly uid: number;
  private readonly fs: LaunchAgentFs;

  constructor(d: { launchctl: Launchctl; uid: number; fs: LaunchAgentFs }) {
    this.launchctl = d.launchctl;
    this.uid = d.uid;
    this.fs = d.fs;
  }

  private get domain(): string {
    return `gui/${this.uid}`;
  }

  private get target(): string {
    return `${this.domain}/${AGENT_LABEL}`;
  }

  /** What launchd says about the job: whether it knows it, and the process it runs. */
  private async probe(): Promise<{ loaded: boolean; pid?: number }> {
    const r = await this.launchctl.run(['print', this.target]);
    if (r.code !== 0) return { loaded: false };
    const m = PID.exec(r.out);
    return m ? { loaded: true, pid: Number(m[1]) } : { loaded: true };
  }

  private read(file: string): string {
    try {
      return String(this.fs.readFileSync(file, 'utf8'));
    } catch {
      return '';
    }
  }

  /**
   * From the plist on disk and launchd. A job that launchd knows but that has no process (it exited 0 because another daemon already
   * ran) is `not-loaded` too: either way launchd is not running the daemon right now.
   */
  async status(plan: AgentPlan | { refused: string }): Promise<AgentStatus> {
    if ('refused' in plan) return { state: 'refused', reason: plan.refused };
    if (!this.fs.existsSync(plan.plistPath)) return { state: 'not-installed' };
    const job = await this.probe();
    return job.pid !== undefined ? { state: 'running', pid: job.pid } : { state: 'not-loaded' };
  }

  /**
   * Write the wrapper, then the plist (it never points at a missing wrapper), and load the job. A job that runs is left as it is, with
   * the new files for its next start: booting out the job from the daemon it runs would end that daemon, and the session with it.
   * Throws, with what `launchctl` said, when launchd will not load the job; the files stay, for the next try.
   */
  async install(plan: AgentPlan): Promise<void> {
    const { fs } = this;
    const home = path.dirname(path.dirname(plan.wrapperPath));
    fs.mkdirSync(path.dirname(plan.plistPath), { recursive: true });
    fs.mkdirSync(path.dirname(plan.wrapperPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(home, 'run'), { recursive: true, mode: 0o700 }); // launchd opens the log file before it starts the job
    fs.writeFileSync(plan.wrapperPath, plan.wrapper, { mode: 0o755 });
    fs.chmodSync(plan.wrapperPath, 0o755); // (the umask must not narrow it)
    fs.writeFileSync(plan.plistPath, plan.plist, { mode: 0o644 });
    fs.chmodSync(plan.plistPath, 0o644);
    const job = await this.probe();
    if (job.pid !== undefined) return;
    if (job.loaded) await this.launchctl.run(['bootout', this.target]); // bootstrap fails on a job that is loaded; if this fails, bootstrap says why
    const r = await this.launchctl.run(['bootstrap', this.domain, plan.plistPath]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed (${r.code}): ${r.out.trim()}`);
  }

  /**
   * Delete both files, then boot the job out. The bootout is last because it ends the daemon when the daemon is the job that runs
   * (that is a deliberate end: launchd does not start it again). Silent when nothing is installed.
   */
  async remove(plan: AgentPlan): Promise<void> {
    this.fs.rmSync(plan.plistPath, { force: true });
    this.fs.rmSync(plan.wrapperPath, { force: true });
    await this.launchctl.run(['bootout', this.target]);
  }

  /**
   * Make the disk and launchd agree with the switch, and say how it stands. Wanted: nothing installed is installed; files that differ
   * from the plan (the app moved, a new version) are rewritten, and the job loaded again unless it runs; files that are current are
   * left alone, also when the job is not loaded (a person's own `launchctl bootout` stays: status says so). Not wanted: removed when
   * anything of it is on disk. A refused plan touches nothing. May throw what `install` throws.
   */
  async reconcile(want: boolean, plan: AgentPlan | { refused: string }): Promise<AgentStatus> {
    if ('refused' in plan) return this.status(plan);
    if (!want) {
      if (this.fs.existsSync(plan.plistPath) || this.fs.existsSync(plan.wrapperPath)) await this.remove(plan);
      return this.status(plan);
    }
    const current = this.fs.existsSync(plan.plistPath) && this.read(plan.plistPath) === plan.plist && this.read(plan.wrapperPath) === plan.wrapper;
    if (!current) await this.install(plan);
    return this.status(plan);
  }

  /** Start the job now (no `-k`: one that runs is not touched). True when launchd did. */
  async kickstart(): Promise<boolean> {
    return (await this.launchctl.run(['kickstart', this.target])).code === 0;
  }
}
