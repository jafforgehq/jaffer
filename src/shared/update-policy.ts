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

export interface PromptText {
  message: string;
  detail: string;
  buttons: [string, string];
  /** Return and Esc both mean Later: someone typing in the terminal when the prompt appears must not accept it by accident. */
  defaultId: number;
  cancelId: number;
}

export function promptText(o: { version: string; claudeBusy: boolean }): PromptText {
  const lines = [
    'Updating restarts Jaffer and ends your terminal session: anything running in it stops. Your memory is kept, and the shell comes back in the same folder.',
  ];
  if (o.claudeBusy) lines.push('Claude is working or waiting for you right now; updating stops it.');
  lines.push('Choose Later to keep working. Jaffer will ask again the next time it starts.');
  return { message: `Jaffer ${o.version} is ready`, detail: lines.join('\n\n'), buttons: ['Update and restart', 'Later'], defaultId: 1, cancelId: 1 };
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
      return { message: 'Updates are off in this build', detail: s.error ?? 'Only the signed release downloaded from GitHub updates itself. The latest version is always on the releases page.', releases: true };
    case 'error':
      return { message: 'Could not check for updates', detail: s.error ?? 'Unknown error.', releases: true };
    default:
      return null;
  }
}

/** The test-only feed override (JAFFER_UPDATE_URL): https anywhere, plain http only to this machine. */
export function isAllowedFeedUrl(u: string): boolean {
  return /^https:\/\/\S+$/i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/\S*)?$/i.test(u);
}

/** Why an app that cannot replace itself should not check for updates (null when it can). The install would fail after the session had ended. */
export function bundleProblem(bundlePath: string, writableParent: boolean): string | null {
  if (bundlePath.includes('/AppTranslocation/')) return 'Jaffer is running from a temporary location. Move it to your Applications folder and open it again to turn updates on.';
  if (!writableParent) return 'Jaffer cannot replace itself where it is installed (a disk image, or a folder you cannot write to). Copy it to your Applications folder to turn updates on.';
  return null;
}
