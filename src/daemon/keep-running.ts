import { bootoutNote, type AgentFiles, type AgentPlan, type Bootout, type LaunchAgent } from '../core/service/launch-agent';
import type { AgentStatus } from '../shared/keep-running';

/**
 * What the daemon does for the switch *Keep my session running in the background* (`session.keepRunning`): the RPCs `service.status`,
 * `service.install` and `service.remove`, the reconcile at its start, and a change of the switch in the config (`switchChanged`, so that
 * the switch and the agent never disagree for a whole session). The agent itself (files, launchd) is `LaunchAgent`; this decides when to
 * call it, from where the daemon runs:
 * - **Started detached** (by the app or the CLI, as without the agent): install writes the files but never loads the job. launchd's
 *   instance would find the socket taken by this daemon, exit 0, and with `SuccessfulExit: false` supervise nothing. The status then says
 *   `installed`: launchd takes over at the next login, or at the next start of the session (the app or the CLI load the job and start
 *   the daemon through launchd).
 * - **Run by launchd** (the wrapper exports `JAFFER_LAUNCHD=1`): install only refreshes the files. Remove, and an unwanted agent at the
 *   start, boot out the job, which ends this very daemon (SIGTERM, saved first): the reply goes out first, and it says the session ends.
 * - **Refused** (not macOS, not the person's own `~/.jaffer`): every call says why and touches nothing: no file, no `launchctl`, not the
 *   switch. Only an app run from a disk image or a translocated copy may still take away an agent installed earlier (`files()`).
 */
export interface KeepRunningDeps {
  agent: Pick<LaunchAgent, 'status' | 'remove' | 'reconcile'>;
  /** The agent for this daemon, or why there can be none. */
  plan: () => AgentPlan | { refused: string };
  /** Where an agent installed earlier is, for removing it while the plan is refused for where the app runs; null when nothing is ours to touch. */
  files: () => AgentFiles | null;
  /** This daemon is the job launchd runs. */
  launchd: boolean;
  /** This daemon's pid (default: this process's). */
  pid?: number;
  keepRunning: () => boolean;
  setKeepRunning: (on: boolean) => void;
  /** Runs `fn` a moment from now (after the RPC's reply has gone out). */
  later: (fn: () => unknown, ms: number) => void;
  log: (msg: string) => void;
}

/** What the person is told when the agent is taken away from the daemon launchd runs. */
export const SESSION_ENDS_NOTE = 'The session ends now: launchd was running it, and stops it with the agent. Jaffer starts a new one in the same folder (at once while the window is open, or the next time you open Jaffer).';

/**
 * The switch turned off in a daemon that launchd does not run: launchd usually had nothing loaded ("Boot-out failed: 3: No such
 * process", or "Could not find service"), which is the normal case, not news. Anything else launchctl said is told.
 */
function turnedOffNote(r: Bootout): string {
  if (r.code === 0) return 'Turned off; launchd unloaded it.';
  if (r.code === 3 || r.code === 113 || /No such process|Could not find service/i.test(r.out)) return 'Turned off.';
  return `Turned off. ${bootoutNote(r)}`;
}

/** Long enough for the reply to leave the socket before the bootout ends this daemon. */
const REPLY_FIRST_MS = 50;

export class KeepRunning {
  /**
   * The value of the switch the agent was last brought in line with (at the start, by install or remove, or by a change of the switch):
   * the change that install and remove make to the switch themselves comes back through the config, and is not acted on twice.
   */
  private inLine: boolean | undefined;

  constructor(private readonly d: KeepRunningDeps) {
    this.inLine = d.keepRunning(); // (what the start brings the agent in line with; a change of any other setting is not one of this)
  }

  /** What launchd and the disk say. `not-loaded` in a daemon that launchd does not run is `installed`: launchd takes over at the next start. */
  private view(s: AgentStatus): AgentStatus {
    return s.state === 'not-loaded' && !this.d.launchd ? { state: 'installed' } : s;
  }

  /**
   * What the switch is about now. The daemon that launchd runs is `running`, with its own pid, whatever `launchctl print` says (it may
   * print no pid line, and someone may have deleted the plist): taking the agent away ends this session, and the app asks first on
   * `running` alone.
   */
  private now(s: AgentStatus): AgentStatus {
    if (this.d.launchd && s.state !== 'refused') return { state: 'running', pid: s.state === 'running' ? s.pid : (this.d.pid ?? process.pid) };
    return this.view(s);
  }

  async status(): Promise<AgentStatus> {
    const plan = this.d.plan();
    if ('refused' in plan) return { state: 'refused', reason: plan.refused };
    return this.now(await this.d.agent.status(plan));
  }

  /** Writes (or refreshes) the files, never loads the job (see above), and turns the switch on. Refused: nothing at all. */
  async install(): Promise<AgentStatus> {
    const plan = this.d.plan();
    if ('refused' in plan) return { state: 'refused', reason: plan.refused };
    const s = await this.d.agent.reconcile(true, plan, { load: false });
    this.inLine = true;
    this.d.setKeepRunning(true);
    return this.now(s);
  }

  /** Takes the agent away and turns the switch off. In the daemon launchd runs, the bootout (which ends it) comes after the reply. */
  async remove(): Promise<AgentStatus> {
    const plan = this.d.plan();
    const files = 'refused' in plan ? this.d.files() : plan;
    if (!files) return { state: 'refused', reason: (plan as { refused: string }).refused }; // another home or another platform: nothing here is this daemon's
    this.inLine = false;
    this.d.setKeepRunning(false);
    return this.takeAway(plan, files);
  }

  /**
   * The switch was changed in the config (Settings, `jaffer service`, `jaffer config set`): the agent is brought in line with it, with
   * the guards of install and remove. On writes or refreshes the files and loads nothing; off takes the agent away (in the daemon
   * launchd runs, the bootout that ends it comes after the reply to the change). A refused home is not touched (only an agent installed
   * earlier is taken away when the app runs from a disk image, as at the start). Asking the person first is the app's, before it sets
   * the switch. Null: already in line (the same value, or install and remove setting it themselves).
   */
  async switchChanged(on: boolean): Promise<AgentStatus | null> {
    if (on === this.inLine) return null;
    this.inLine = on;
    try {
      const plan = this.d.plan();
      if (on) {
        if ('refused' in plan) return { state: 'refused', reason: plan.refused };
        return this.now(await this.d.agent.reconcile(true, plan, { load: false }));
      }
      const files = 'refused' in plan ? this.d.files() : plan;
      if (!files) return { state: 'refused', reason: (plan as { refused: string }).refused };
      return await this.takeAway(plan, files);
    } catch (e) {
      this.inLine = undefined; // not in line after all: the next change, or the next start, tries again
      throw e;
    }
  }

  /** The files go and launchd is told; in the daemon launchd runs, after the reply (the bootout ends this very daemon). */
  private async takeAway(plan: AgentPlan | { refused: string }, files: AgentFiles): Promise<AgentStatus> {
    const refused: AgentStatus | null = 'refused' in plan ? { state: 'refused', reason: plan.refused } : null;
    if (this.d.launchd) {
      this.d.later(async () => {
        this.d.log('keep running: the agent is taken away; launchd stops this daemon');
        const r = await this.d.agent.remove(files).catch((e: unknown) => ({ code: -1, out: String(e) }));
        this.d.log(`keep running: removed; ${bootoutNote(r)}`); // (if launchd did not stop it, the daemon goes on, detached)
      }, REPLY_FIRST_MS);
      return { ...(refused ?? { state: 'not-installed' }), note: SESSION_ENDS_NOTE };
    }
    const r = await this.d.agent.remove(files);
    return { ...(refused ?? this.view(await this.d.agent.status(plan as AgentPlan))), note: turnedOffNote(r) };
  }

  /**
   * At the start of the daemon (once its socket listens): the switch on refreshes stale or missing files (without loading the job); off
   * takes an installed agent away, also when the app now runs from a disk image. In the daemon launchd runs, taking it away ends that
   * daemon: the switch said so. A refused home is not touched.
   */
  async reconcileAtStart(): Promise<AgentStatus> {
    const want = this.d.keepRunning();
    this.inLine = want;
    const plan = this.d.plan();
    if ('refused' in plan) {
      const files = want ? null : this.d.files();
      if (!files) return { state: 'refused', reason: plan.refused };
      return this.d.agent.reconcile(false, plan, { paths: files });
    }
    if (!want && this.d.launchd) this.d.log('keep running: the switch is off, so the agent goes; launchd stops this daemon if it has one');
    return this.view(await this.d.agent.reconcile(want, plan, { load: false }));
  }
}
