/**
 * When the terminal is somewhere a slip costs more than usual: on a branch that deserves care, or while an ssh session runs (the
 * easiest way to type a command into the wrong machine). The title bar tints for it; nothing else changes. Pure, so it is tested.
 */

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
  if (!branch) return false;
  const b = branch.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    return p !== '' && glob(p, b);
  });
}

/** ssh options that take the next word as their value (`-p 2222`). */
const VALUE_OPTIONS = new Set('BbcDEeFIiJLlmOopQRSWw'.split(''));
const MOSH_VALUE_OPTIONS = new Set(['--port', '--ssh', '--server', '--client', '--predict', '--bind-server', '--family']);
const WRAPPERS = new Set(['command', 'exec', 'time', 'sudo']);

/**
 * Where an `ssh` or `mosh` command line connects to: the host, without user, port or options. `null` when it is ssh but the
 * destination cannot be told (`ssh -v`), `undefined` when the line is not ssh at all (`ssh-keygen`, `echo ssh prod`).
 */
export function sshHost(cmd: string): string | null | undefined {
  const words = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // FOO=1 ssh …
  while (i < words.length && WRAPPERS.has(words[i]!)) {
    const sudo = words[i] === 'sudo';
    i++;
    while (i < words.length && words[i]!.startsWith('-')) i += sudo && /^-[ug]$/.test(words[i]!) ? 2 : 1; // sudo -u deploy ssh …
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
      if (w.length === 2 && VALUE_OPTIONS.has(w[1]!)) j++;
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

/** ssh outranks the branch: being on the wrong machine is the bigger mistake. */
export function dangerZone(o: { branch?: string | null; running?: string | null; patterns: string[] }): Danger | null {
  const host = o.running ? sshHost(o.running) : undefined;
  if (host !== undefined) return { kind: 'ssh', what: host ?? 'a remote machine' };
  if (o.branch && branchMatches(o.branch, o.patterns)) return { kind: 'branch', what: o.branch };
  return null;
}
