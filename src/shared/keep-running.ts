/**
 * The login agent that keeps the session running (`service.*`), as the daemon, the CLI and the window speak of it. One place, so they
 * agree.
 */

/** The launchd label of the daemon's login agent. */
export const AGENT_LABEL = 'com.jafforge.jaffer.daemon';

/**
 * How the login agent that keeps the session running stands, as the daemon tells it (`service.status`, `service.install`,
 * `service.remove`): from launchd and the plist on disk, not from the switch alone.
 * - `not-installed`: no plist.
 * - `installed`: the files are in place and launchd is not running this daemon: it takes over at the next login, or the next time the
 *   session starts (the app or `jaffer` then loads the job and starts the daemon through launchd). What a daemon that was started
 *   detached says after the switch was turned on: launchd's own instance would have found the socket taken and stopped.
 * - `running`: launchd runs the daemon, with this pid.
 * - `not-loaded`: the plist is there but launchd runs nothing for it (from `LaunchAgent.status`; the daemon says `installed` instead
 *   when it is not launchd's own).
 * - `refused`: it cannot be here, and why (not macOS, not the person's own `~/.jaffer`, an app run from a disk image).
 * `note`: something the person should know about what was just done (for example that turning it off ends the session now).
 */
export type AgentStatus = ({ state: 'not-installed' } | { state: 'installed' } | { state: 'running'; pid: number } | { state: 'not-loaded' } | { state: 'refused'; reason: string }) & { note?: string };

/**
 * What the app asks before the switch is turned off while launchd runs the session (`service.status` is `running`): taking the agent
 * away stops the daemon launchd runs, and the shell with it. Plain text for a native dialog (Cancel first: the default and Escape), and
 * what `jaffer service remove` prints before it does it. Turned off while Jaffer itself runs the session, nothing ends and nothing is asked.
 */
export function keepRunningOffText(): { message: string; detail: string; buttons: [string, string] } {
  return {
    message: 'Turn off keeping your session running?',
    detail:
      'This ends your terminal session now: your shell and anything running in it stop (a Claude Code conversation can be resumed afterwards). ' +
      'macOS is running your session at the moment, and turning this off stops it; a new one starts in the same folder.',
    buttons: ['Cancel', 'Turn off and end the session'],
  };
}

/**
 * Settings' switch turned off, as the main process does it (and the bridge of the UI tests): every switch-off comes here. The daemon is
 * asked how it stands now, not what the window saw when Settings opened (a daemon that died meanwhile and came back through launchd, a
 * launchd job whose print shows no pid), and the person is asked first when launchd runs the session, because taking the agent away
 * ends it. A no changes nothing.
 */
export async function turnKeepRunningOff(d: { status(): Promise<AgentStatus>; ask(): Promise<boolean>; remove(): Promise<AgentStatus> }): Promise<{ cancelled: boolean; status?: AgentStatus }> {
  if ((await d.status()).state === 'running' && !(await d.ask())) return { cancelled: true };
  return { cancelled: false, status: await d.remove() };
}

/**
 * What the person is told when the session daemon is older than the app (from before 0.5: an app updated by dragging it in keeps the old
 * daemon until the session is restarted) and does not know what was asked: the words Settings uses, in the CLI and the window alike.
 */
export const OLD_DAEMON_TEXT = 'Restart your session to use this';

/** What 0.5 added that an older daemon answers with "unknown method": the login agent's requests. */
const ADDED_IN_05 = /unknown method: service\./;

/** The error is an older daemon not knowing one of those (also as the app hands it to the window: "Error invoking remote method …"). */
export function isOldDaemonError(e: unknown): boolean {
  return ADDED_IN_05.test(e instanceof Error ? e.message : String(e));
}

/** An error in the person's words: `OLD_DAEMON_TEXT` for an older daemon, otherwise its own message. */
export function errorText(e: unknown): string {
  return isOldDaemonError(e) ? OLD_DAEMON_TEXT : e instanceof Error ? e.message : String(e);
}

/** The state in words, as `jaffer service status` prints it and Settings shows it. */
export function agentStatusText(s: AgentStatus): string {
  switch (s.state) {
    case 'not-installed':
      return 'not installed';
    case 'installed':
      return 'installed, active from the next login or restart';
    case 'running':
      return `running (pid ${s.pid})`;
    case 'not-loaded':
      return 'installed but not loaded';
    case 'refused':
      return `refused: ${s.reason}`;
  }
}
