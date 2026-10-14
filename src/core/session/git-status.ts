import { execFile } from 'node:child_process';

/** A repository's state, counted, for the folder pill: files staged, changed and untracked, and commits ahead and behind the upstream. */
export interface GitStatus {
  staged: number;
  changed: number;
  untracked: number;
  ahead: number;
  behind: number;
}

/** git's answer can be as long as a repository has files: only the first megabyte is read (it is also all `readGitStatus` takes). */
const MAX_TEXT = 1 << 20;

/** `git status --porcelain=v2 --branch`, counted. Pure; reads the first megabyte, a line at a time. */
export function parseGitStatus(text: string): GitStatus {
  const out: GitStatus = { staged: 0, changed: 0, untracked: 0, ahead: 0, behind: 0 };
  for (const line of text.slice(0, MAX_TEXT).split('\n')) {
    const kind = line[0];
    if (line[1] !== ' ') continue;
    if (kind === '1' || kind === '2' || kind === 'u') {
      // `1 XY ...`: X is the index, Y the work tree, '.' unchanged (a rename is a `2`, a conflict a `u`)
      if (line[2] !== '.') out.staged++;
      if (line[3] !== '.') out.changed++;
    } else if (kind === '?') out.untracked++;
    else if (kind === '#') {
      const ab = /^# branch\.ab \+(\d{1,9}) -(\d{1,9})$/.exec(line);
      if (ab) {
        out.ahead = Number(ab[1]);
        out.behind = Number(ab[2]);
      }
    }
  }
  return out;
}

/** On a Mac without the developer tools, /usr/bin/git is a stand-in that offers to install them (a dialog, every time): then git is missing. */
let usable: Promise<boolean> | undefined;
function gitUsable(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  usable ??= new Promise((resolve) => execFile('/usr/bin/xcode-select', ['-p'], { timeout: 1000, killSignal: 'SIGKILL' }, (err) => resolve(!err)));
  return usable;
}

/**
 * `git status` of the repository at `root`, counted. Undefined when git is missing, `root` is no repository, or git takes more than a
 * second or says more than a megabyte. It takes no lock (`GIT_OPTIONAL_LOCKS=0`): the person's own git commands never wait for it. `core.fsmonitor` is off: a repository's own config must not start a program on every prompt.
 */
export async function readGitStatus(root: string): Promise<GitStatus | undefined> {
  if (!(await gitUsable())) return undefined;
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch'], { cwd: root, timeout: 1000, killSignal: 'SIGKILL', maxBuffer: MAX_TEXT, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => resolve(err ? undefined : parseGitStatus(stdout)));
  });
}
