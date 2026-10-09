/**
 * When the terminal is somewhere a slip costs more than usual: on a branch that deserves care, or while an ssh session runs (the
 * easiest way to type a command into the wrong machine). The title bar tints for it; nothing else changes. Pure, so it is tested.
 */

import { isSensitiveCommand, redactText } from './redact';

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'production', 'prod', 'release/*'];

export interface Danger {
  kind: 'ssh' | 'branch';
  /** The host, or the branch. */
  what: string;
}

/** `*` matches any run of characters, everything else is itself, case does not matter. No regular expressions: a pattern is text. */
function glob(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

export function branchMatches(branch: string, patterns: string[]): boolean {
  if (!branch || !Array.isArray(patterns)) return false;
  const b = branch.toLowerCase();
  return patterns.some((raw) => {
    const p = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return p !== '' && glob(p, b);
  });
}

/** ssh options that take the next word as their value (`-p 2222`). */
const VALUE_OPTIONS = 'BbcDEeFIiJLlmOopQRSWw';
const MOSH_VALUE_OPTIONS = new Set(['--port', '--ssh', '--server', '--client', '--predict', '--bind-server', '--family']);
/**
 * Programs that run the next command: with the short options that take the next word as their value (`sudo -u deploy`, `nice -n 5`).
 * `isInteractiveCommand` (stay-awake) reads a command line through the same table.
 */
export const WRAPPER_OPTIONS: Readonly<Record<string, string>> = { command: '', exec: '', time: '', nohup: '', sudo: 'ugCDhpRrtTU', env: 'uSC', nice: 'n' };
/**
 * The long options of those programs that take the next word as their value (`sudo --user deploy`, `nice --adjustment 5`). The
 * `--user=deploy` form is one word and is not listed; neither are the long options that take no value (`--preserve-env`).
 */
export const WRAPPER_LONG_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from', '--command-timeout']),
  env: new Set(['--unset', '--chdir']),
  nice: new Set(['--adjustment']),
};
const isAssignment = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/**
 * Where `-vp 2222` or `-iu deploy` ends: a cluster of short options, of which the first that takes a value either has it attached
 * (`-p2222`) or, when it is the last one, takes the next word. A long option (`--user deploy`) takes the next word when `longValue`
 * lists it (`--user=deploy` and the ones that take no value are one word). Returns how many words the option uses.
 */
export function optionWords(w: string, takesValue: string, longValue?: ReadonlySet<string>): number {
  if (w.startsWith('--')) return longValue?.has(w) ? 2 : 1;
  for (let k = 1; k < w.length; k++) if (takesValue.includes(w[k]!)) return k === w.length - 1 ? 2 : 1;
  return 1;
}

/**
 * Where an `ssh` or `mosh` command line connects to: the host, without user, port or options. `null` when it is ssh but the
 * destination cannot be told (`ssh -v`), `undefined` when the line is not ssh at all (`ssh-keygen`, `echo ssh prod`).
 */
export function sshHost(cmd: string): string | null | undefined {
  const words = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let i = 0;
  while (i < words.length && isAssignment(words[i]!)) i++; // FOO=1 ssh …
  while (i < words.length && Object.hasOwn(WRAPPER_OPTIONS, words[i]!)) {
    const wrapper = words[i++]!;
    const takes = WRAPPER_OPTIONS[wrapper]!;
    const long = Object.hasOwn(WRAPPER_LONG_OPTIONS, wrapper) ? WRAPPER_LONG_OPTIONS[wrapper] : undefined;
    while (i < words.length) {
      const w = words[i]!;
      if (isAssignment(w)) i++; // env X=1 ssh …
      else if (w === '--') {
        i++;
        break;
      } else if (w.startsWith('-') && w.length > 1) i += optionWords(w, takes, long);
      else break;
    }
  }
  const program = (words[i] ?? '').split('/').pop();
  if (program !== 'ssh' && program !== 'mosh') return undefined;
  let dest: string | undefined;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j]!;
    if (w === '--') {
      dest = words[j + 1];
      break;
    }
    if (w.startsWith('--')) {
      if (!w.includes('=') && MOSH_VALUE_OPTIONS.has(w)) j++;
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      j += optionWords(w, VALUE_OPTIONS) - 1;
      continue;
    }
    dest = w;
    break;
  }
  if (!dest) return null;
  let host = dest.replace(/^['"]|['"]$/g, '').replace(/^ssh:\/\//, '').replace(/^.*@/, '');
  const v6 = /^\[([^\]]+)\]/.exec(host);
  if (v6) host = v6[1]!;
  else if ((host.match(/:/g) ?? []).length === 1) host = host.replace(/:\d*$/, '');
  host = host.slice(0, 60);
  return host || null;
}

/**
 * ssh outranks the branch: being on the wrong machine is the bigger mistake. The host goes to the window (a tooltip, a label), so
 * it is held to the same rule as the command beside it: a command the window hides as sensitive names no host, the rest is redacted.
 */
export function dangerZone(o: { branch?: string | null; running?: string | null; patterns: string[] }): Danger | null {
  const host = o.running ? sshHost(o.running) : undefined;
  if (host !== undefined) return { kind: 'ssh', what: host === null || isSensitiveCommand(o.running!) ? 'a remote machine' : redactText(host) };
  if (o.branch && branchMatches(o.branch, o.patterns)) return { kind: 'branch', what: o.branch };
  return null;
}
