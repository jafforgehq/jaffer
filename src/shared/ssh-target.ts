import { COMMAND_HEAD } from './process-badge';

/** ssh options that take a value in the next word (so it is not the host). */
const WITH_VALUE = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
/** Host names that look like production: the terminal's outline turns red while one is connected. */
const PROD = /(^|[.\-_])(prod|production|prd|live)([.\-_\d]|$)/i;

export interface SshTarget {
  /** Looks like a production machine. */
  prod: boolean;
}

/**
 * (1.7.0) What a running command says about an ssh connection: `ssh [options] [user@]host [command]`, read from the command's head only.
 * It returns whether the host looks like production and never returns the host itself: nothing of it is shown or kept. Not ssh (or `ssh -V`,
 * which connects nowhere): null.
 */
export function sshTarget(cmd: string | null | undefined): SshTarget | null {
  if (typeof cmd !== 'string') return null;
  const words = cmd.slice(0, 4 * COMMAND_HEAD).trim().split(/\s+/);
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++; // (leading VAR=value words)
  if (words[i] === 'command' || words[i] === 'exec') i++;
  if (!/(^|\/)ssh$/.test(words[i] ?? '')) return null;
  i++;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (w === '-V') return null;
    if (WITH_VALUE.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith('-')) continue;
    const host = w.includes('@') ? w.slice(w.lastIndexOf('@') + 1) : w;
    return host ? { prod: PROD.test(host) } : null;
  }
  return null;
}
