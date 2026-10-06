import fs from 'node:fs';
import path from 'node:path';
import type { JafferPaths } from '../../shared/paths';
import { ensureDir, writeFileAtomic } from '../../shared/util';
import { SHELL_SCRIPTS } from '../../generated/shell-scripts';

/**
 * Shell integration: tiny scripts injected into the user's shell (without touching their
 * dotfiles) that emit standard terminal marks —
 *   OSC 133;A  prompt start      OSC 133;C  command output start      OSC 133;D;<exit>  command finished
 *   OSC 633;E;<cmd>  the command line      OSC 633;P;Cwd=<dir>  working directory
 * The session host turns them into command events for memory and lets the agent run
 * commands in the same shell the user is looking at.
 */

export interface ShellSpawn {
  file: string;
  args: string[];
  env: Record<string, string>;
  kind: 'zsh' | 'bash' | 'fish' | 'other';
}

export function shellKind(shellPath: string): ShellSpawn['kind'] {
  const base = path.basename(shellPath);
  if (base === 'zsh') return 'zsh';
  if (base === 'bash') return 'bash';
  if (base === 'fish') return 'fish';
  return 'other';
}

/** Write the integration scripts under ~/.jaffer/shell. Idempotent. */
export function installShellIntegration(paths: JafferPaths): void {
  ensureDir(paths.shellDir, 0o700);
  for (const [rel, content] of Object.entries(SHELL_SCRIPTS)) {
    const file = path.join(paths.shellDir, rel);
    ensureDir(path.dirname(file), 0o700);
    let cur = '';
    try {
      cur = fs.readFileSync(file, 'utf8');
    } catch {
      /* new */
    }
    if (cur !== content) writeFileAtomic(file, content, 0o644);
  }
}

/** Environment variables that must never leak from the daemon into the user's shell. */
const STRIP_ENV = [/^ELECTRON_/, /^NODE_OPTIONS$/, /^CLAUDECODE$/, /^CLAUDE_CODE_/, /^npm_lifecycle_/, /^npm_package_/, /^npm_command$/, /^npm_execpath$/, /^npm_node_execpath$/, /^INIT_CWD$/, /^JAFFER_USER_ZDOTDIR$/, /^_JAFFER_LOADED$/];

export interface SpawnOptions {
  shell: string;
  extraArgs?: string[];
  paths: JafferPaths;
  baseEnv: NodeJS.ProcessEnv;
  version: string;
  login?: boolean;
}

export function buildShellSpawn(o: SpawnOptions): ShellSpawn {
  const kind = shellKind(o.shell);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.baseEnv)) {
    if (v === undefined || STRIP_ENV.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Jaffer';
  env.TERM_PROGRAM_VERSION = o.version;
  if (!env.LANG || !/UTF-?8/i.test(env.LANG)) env.LANG = 'en_US.UTF-8';
  env.JAFFER_SESSION = '1';
  env.JAFFER_HOME = o.paths.home;
  env.JAFFER_SOCK = o.paths.socket;
  env.JAFFER_BIN = o.paths.binDir;
  env.JAFFER_SHELL_DIR = o.paths.shellDir;
  const login = o.login !== false;
  const extra = o.extraArgs ?? [];

  if (kind === 'zsh') {
    if (env.ZDOTDIR) env.JAFFER_USER_ZDOTDIR = env.ZDOTDIR;
    env.JAFFER_ZSH_DIR = path.join(o.paths.shellDir, 'zsh');
    env.ZDOTDIR = env.JAFFER_ZSH_DIR;
    return { file: o.shell, args: [...(login ? ['-l'] : []), '-i', ...extra], env, kind };
  }
  if (kind === 'bash') {
    env.JAFFER_LOGIN = login ? '1' : '0';
    return { file: o.shell, args: ['--init-file', path.join(o.paths.shellDir, 'jaffer-bash-init.sh'), '-i', ...extra], env, kind };
  }
  if (kind === 'fish') {
    return { file: o.shell, args: [...(login ? ['-l'] : []), '-i', '-C', `source ${JSON.stringify(path.join(o.paths.shellDir, 'jaffer-integration.fish'))}`, ...extra], env, kind };
  }
  return { file: o.shell, args: [...(login ? ['-l'] : []), ...extra], env, kind: 'other' };
}

export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.SHELL, process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/bash', '/bin/sh'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return '/bin/sh';
}
