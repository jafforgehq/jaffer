import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseGitStatus, readGitStatus, repoFilters } from '../src/core/session/git-status';

describe('parseGitStatus: `git status --porcelain=v2 --branch`, counted', () => {
  it('counts what is staged, changed and untracked, and how far the branch is ahead and behind', () => {
    const text = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 abc abc src/staged.ts',
      '1 .M N... 100644 100644 100644 abc abc src/changed.ts',
      '1 MM N... 100644 100644 100644 abc abc src/both.ts',
      '1 A. N... 000000 100644 100644 000 abc src/added.ts',
      '1 .D N... 100644 100644 000000 abc abc src/deleted.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 src/new name.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 abc abc abc src/conflict.ts',
      '? notes.txt',
      '? build/',
      '! ignored.log',
      '',
    ].join('\n');
    expect(parseGitStatus(text)).toEqual({ staged: 5, changed: 4, untracked: 2, ahead: 2, behind: 1 });
  });

  it('a branch with no upstream, a clean tree, or nothing at all is all zeros', () => {
    const zero = { staged: 0, changed: 0, untracked: 0, ahead: 0, behind: 0 };
    expect(parseGitStatus('# branch.oid (initial)\n# branch.head main\n')).toEqual(zero);
    expect(parseGitStatus('')).toEqual(zero);
    expect(parseGitStatus('# branch.ab +x -1\n# branch.ab +99999999999 -1\n')).toEqual(zero); // (not git's own line)
  });

  it('reads only the first megabyte', () => {
    expect(parseGitStatus('? a\n'.repeat(1_000_000)).untracked).toBe((1 << 20) / 4);
  });

  const MB = 1_000_000;
  const crafted: Record<string, (bytes: number) => string> = {
    'one long line': (n) => '1 M. '.padEnd(n, 'a'),
    'a long ahead count': (n) => `# branch.ab +${'9'.repeat(n)}`,
    'many short lines': (n) => '? a\n'.repeat(n / 4),
    'no newline at all': (n) => '#'.repeat(n),
  };
  for (const size of [1, 8]) {
    for (const [what, make] of Object.entries(crafted)) {
      it(`stays fast on ${what} (${size} MB)`, () => {
        const text = make(size * MB);
        const t0 = performance.now();
        expect(() => parseGitStatus(text), what).not.toThrow();
        expect(performance.now() - t0, what).toBeLessThan(500); // milliseconds in practice; generous for CI
      });
    }
  }
});

describe('repoFilters: filter drivers a repository names itself (`git config --show-scope --get-regexp`)', () => {
  it('a filter from the system or the person\'s own global config is theirs; one from the repository (or any other scope) is not', () => {
    expect(repoFilters('')).toBe(false);
    expect(repoFilters('global\tfilter.lfs.clean git-lfs clean -- %f\nglobal\tfilter.lfs.process git-lfs filter-process\nsystem\tfilter.x.smudge cat\n')).toBe(false);
    expect(repoFilters('global\tfilter.lfs.clean git-lfs clean -- %f\nlocal\tfilter.x.clean touch /tmp/pwned\n')).toBe(true);
    for (const scope of ['local', 'worktree', 'command', 'unknown', '']) expect(repoFilters(`${scope}\tfilter.x.process run-me\n`), scope).toBe(true);
  });

  it('stays fast on 8 MB', () => {
    const t0 = performance.now();
    expect(repoFilters('global\tfilter.a.clean x\n'.repeat(400_000))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('readGitStatus: real git, in temporary repositories only', () => {
  let dir: string;
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  // the person's own git settings (say, status.showUntrackedFiles) must not change what these tests see
  const env = () => ({ ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), stdio: 'ignore' });

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-git-')));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('says nothing outside a repository, or for a folder that is not there', async () => {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    expect(await readGitStatus(plain)).toBeUndefined();
    expect(await readGitStatus(path.join(dir, 'missing'))).toBeUndefined();
  });

  it('counts a repository\'s staged, changed and untracked files, and ahead/behind against its upstream', async () => {
    const up = path.join(dir, 'up');
    fs.mkdirSync(up);
    git(up, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(up, 'a.txt'), 'a\n');
    git(up, 'add', 'a.txt');
    git(up, 'commit', '-q', '-m', 'one');
    const repo = path.join(dir, 'repo');
    git(dir, 'clone', '-q', up, repo);
    expect(await readGitStatus(repo)).toEqual({ staged: 0, changed: 0, untracked: 0, ahead: 0, behind: 0 });

    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', 'b.txt');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    expect(await readGitStatus(repo)).toEqual({ staged: 1, changed: 1, untracked: 1, ahead: 0, behind: 0 });

    git(repo, 'commit', '-q', '-m', 'mine');
    fs.writeFileSync(path.join(up, 'c.txt'), 'c\n');
    git(up, 'add', 'c.txt');
    git(up, 'commit', '-q', '-m', 'theirs');
    git(repo, 'fetch', '-q');
    expect(await readGitStatus(repo)).toEqual({ staged: 0, changed: 1, untracked: 1, ahead: 1, behind: 1 });
    expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
  });

  it('never runs a program the repository names: with a filter driver in its own config, there is no status at all', async () => {
    const repo = path.join(dir, 'filtered');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=x\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const marker = path.join(dir, 'filter-ran');
    git(repo, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(repo, 'a.txt'), later, later); // changed stat info: git status would clean the file again
    expect(await readGitStatus(repo)).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
    // (what it guards against: a plain `git status` here runs the repository's program)
    git(repo, 'status', '--porcelain');
    expect(fs.existsSync(marker)).toBe(true);
  });
});
