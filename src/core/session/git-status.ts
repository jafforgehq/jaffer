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

/**
 * Whether `git config --show-scope --get-regexp '^filter\..*\.(clean|process|smudge)$'` names a filter driver from anywhere but the
 * system's or the person's own global config. A repository's own config (local, worktree, an include of either) may name any program as a
 * filter, and `git status` runs it on files whose stat info changed: such a repository gets no status. Pure; reads the first megabyte.
 */
export function repoFilters(text: string): boolean {
  for (const line of text.slice(0, MAX_TEXT).split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const scope = tab < 0 ? '' : line.slice(0, tab);
    if (scope !== 'system' && scope !== 'global') return true;
  }
  return false;
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
 * second or says more than a megabyte, and when the repository's own config names a filter driver (`repoFilters`). It takes no lock
 * (`GIT_OPTIONAL_LOCKS=0`): the person's own git commands never wait for it. `core.fsmonitor` is off and submodules are ignored: a
 * repository's own config must not start a program on every prompt.
 */
export async function readGitStatus(root: string): Promise<GitStatus | undefined> {
  if (!(await gitUsable())) return undefined;
  const opts = { cwd: root, timeout: 1000, killSignal: 'SIGKILL' as const, maxBuffer: MAX_TEXT, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  // reading the config runs nothing; it exits 1 when there is no filter at all
  const safe = await new Promise<boolean>((resolve) =>
    execFile('git', ['config', '--show-scope', '--get-regexp', '^filter\\..*\\.(clean|process|smudge)$'], opts, (err, stdout) =>
      resolve(err ? (err as { code?: unknown }).code === 1 : !repoFilters(stdout)),
    ),
  );
  if (!safe) return undefined;
  return new Promise((resolve) => {
    // submodules are not looked into (their own config could name a program too)
    execFile('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--ignore-submodules=all'], opts, (err, stdout) => resolve(err ? undefined : parseGitStatus(stdout)));
  });
}
