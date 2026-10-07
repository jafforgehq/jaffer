/** Pure rules for self-updates: what the prompt says, when to ask, and which builds may update themselves. */

export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error';
export interface UpdateState {
  status: UpdateStatus;
  /** The running version. */
  current: string;
  /** The version being downloaded or waiting to be installed. */
  version?: string;
  error?: string;
  /** Background checks are on (Settings → Updates). */
  auto: boolean;
}

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** The feed's version string, or null when it is not a plain version (it ends up in a dialog, so nothing else gets through). */
export function cleanVersion(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 40 && VERSION.test(v) ? v : null;
}

export function promptText(o: { version: string; claudeBusy: boolean }): { message: string; detail: string; buttons: [string, string] } {
  const lines = [
    'Updating restarts Jaffer and ends your terminal session: anything running in it stops. Your memory is kept, and the shell comes back in the same folder.',
  ];
  if (o.claudeBusy) lines.push('Claude is working right now; updating stops it.');
  lines.push('Choose Later to keep working. Jaffer will ask again the next time it starts.');
  return { message: `Jaffer ${o.version} is ready`, detail: lines.join('\n\n'), buttons: ['Update and restart', 'Later'] };
}

/** A background check does not nag about a version the user already put off; a manual check always answers. */
export function shouldAsk(o: { manual: boolean; declined: string | null; version: string }): boolean {
  return o.manual || o.declined !== o.version;
}

/** Reads `codesign -dvv` output. Only a Developer ID signature can be updated in place (Squirrel checks the next one against it). */
export function signerKind(codesignOutput: string): 'developer-id' | 'adhoc' | 'unsigned' {
  if (/^Authority=Developer ID Application:/m.test(codesignOutput)) return 'developer-id';
  if (/^Signature=adhoc/m.test(codesignOutput)) return 'adhoc';
  return 'unsigned';
}

/** True when `version` is a higher x.y.z than `current` (a dev build, or any text that is not a version, is never updated). */
export function isNewer(version: string, current: string): boolean {
  if (!cleanVersion(version) || !cleanVersion(current)) return false;
  const a = (version.split('-')[0] ?? '').split('.').map(Number);
  const b = (current.split('-')[0] ?? '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export const RELEASES_URL = 'https://github.com/jafforgehq/jaffer/releases/latest';

/** What the dialog after Check for Updates… says, or null when the update prompt itself is the answer. */
export function manualResult(s: UpdateState): { message: string; detail: string; releases: boolean } | null {
  switch (s.status) {
    case 'uptodate':
      return { message: 'Jaffer is up to date', detail: `You have ${s.current}, the latest version.`, releases: false };
    case 'downloading':
      return { message: `Downloading Jaffer ${s.version ?? 'update'}`, detail: 'Jaffer will ask when it is ready to install.', releases: false };
    case 'unavailable':
      return { message: 'Updates are off in this build', detail: 'Only the signed release downloaded from GitHub updates itself. The latest version is always on the releases page.', releases: true };
    case 'error':
      return { message: 'Could not check for updates', detail: s.error ?? 'Unknown error.', releases: true };
    default:
      return null;
  }
}
