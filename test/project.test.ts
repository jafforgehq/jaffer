import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveProject } from '../src/core/session/project';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

/** A directory (unique per test, because results are cached per folder for a while). */
const dir = (...parts: string[]): string => {
  const d = path.join(env.root, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const repo = (where: string, head = 'ref: refs/heads/main\n'): string => {
  fs.mkdirSync(path.join(where, '.git'), { recursive: true });
  fs.writeFileSync(path.join(where, '.git', 'HEAD'), head);
  return where;
};

describe('resolveProject', () => {
  it('knows nothing about no folder, or a folder outside any repository', () => {
    expect(resolveProject(undefined)).toEqual({ root: undefined, branch: undefined });
    expect(resolveProject(dir('plain', 'deeper'))).toEqual({ root: undefined, branch: undefined });
  });

  it('finds the repository above a folder, and its branch, with a slash in the name too', () => {
    const root = repo(dir('app'), 'ref: refs/heads/feature/login-form\n');
    expect(resolveProject(root)).toEqual({ root, branch: 'feature/login-form' });
    expect(resolveProject(dir('app', 'src', 'auth'))).toEqual({ root, branch: 'feature/login-form' });
  });

  it('shows a detached HEAD as the start of its commit id', () => {
    const root = repo(dir('detached'), '3f1c9a7be0d44c2ab9f1d2e3a4b5c6d7e8f90123\n');
    expect(resolveProject(root).branch).toBe('3f1c9a7b');
  });

  it('still finds a repository whose HEAD cannot be read, just without a branch', () => {
    const root = dir('nohead');
    fs.mkdirSync(path.join(root, '.git'));
    expect(resolveProject(root)).toEqual({ root, branch: undefined });
  });

  it('follows a worktree or submodule: .git is a file naming the real git directory, relative or absolute', () => {
    const real = repo(dir('main-checkout'));
    fs.mkdirSync(path.join(real, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(real, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/hotfix\n');
    const rel = dir('wt-relative');
    fs.writeFileSync(path.join(rel, '.git'), `gitdir: ${path.relative(rel, path.join(real, '.git', 'worktrees', 'wt'))}\n`);
    expect(resolveProject(rel)).toEqual({ root: rel, branch: 'hotfix' });
    const abs = dir('wt-absolute');
    fs.writeFileSync(path.join(abs, '.git'), `gitdir: ${path.join(real, '.git', 'worktrees', 'wt')}\n`);
    expect(resolveProject(abs)).toEqual({ root: abs, branch: 'hotfix' });
    const broken = dir('wt-broken');
    fs.writeFileSync(path.join(broken, '.git'), 'something else entirely\n');
    expect(resolveProject(broken)).toEqual({ root: broken, branch: undefined });
  });

  it('does not take a repository in the home folder (dotfiles) for the project of everything beneath it', () => {
    const home = repo(dir('home'));
    const sub = dir('home', 'notes');
    expect(resolveProject(sub, home)).toEqual({ root: undefined, branch: undefined });
    // but a repository of its own inside home is a project
    const own = repo(dir('home', 'code', 'api'));
    expect(resolveProject(path.join(own), home).root).toBe(own);
  });

  it('the nearest repository wins when they are nested', () => {
    const outer = repo(dir('outer'));
    const inner = repo(dir('outer', 'vendor', 'lib'), 'ref: refs/heads/trunk\n');
    expect(resolveProject(path.join(inner, 'src'))).toEqual({ root: inner, branch: 'trunk' });
    expect(resolveProject(dir('outer', 'docs')).root).toBe(outer);
  });

  it('remembers an answer for a folder for a little while, so the title bar does not hit the disk on every prompt', () => {
    const root = repo(dir('cached'), 'ref: refs/heads/before\n');
    expect(resolveProject(root).branch).toBe('before');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/after\n');
    expect(resolveProject(root).branch).toBe('before'); // still the remembered answer
    expect(resolveProject(dir('cached', 'sub')).branch).toBe('after'); // another folder is looked up fresh
  });
});
