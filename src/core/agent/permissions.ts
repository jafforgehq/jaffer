import path from 'node:path';
import os from 'node:os';
/** What kind of action a tool call is, for the approval cards of a later release. */
export type Risk = 'read' | 'write' | 'command' | 'risky';

export interface Assessment {
  /** auto = run without asking (in the current mode); ask = needs user approval; deny = never. */
  verdict: 'auto' | 'ask' | 'deny';
  risk: Risk;
  reason: string;
}

// Absolute no-go, regardless of mode: these have no sane use from an automated agent.
const DENY: [RegExp, string][] = [
  [/\brm\s+(?:-[a-zA-Z]*\s+)*(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\/\*|~\/\*)\s*(?:$|[;&|])/, 'recursively deleting the filesystem root or home directory'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'a fork bomb'],
  [/\bmkfs(?:\.\w+)?\b/, 'formatting a filesystem'],
  [/\bdd\b[^|;&]*\bof=\/dev\/(?:sd|disk|nvme|hd)/, 'writing directly to a disk device'],
  [/>\s*\/dev\/(?:sd|disk|nvme|hd)\w*/, 'writing directly to a disk device'],
  [/\bdiskutil\s+(?:erase|partition|zero|secureErase)/i, 'erasing a disk'],
];

// Always needs a human in the loop, even in auto mode.
const RISKY: [RegExp, string][] = [
  [/\bsudo\b/, 'uses sudo'],
  [/\brm\s+(?:-\w+\s+)*-\w*[rRf]/, 'deletes files recursively or forcefully'],
  [/\bgit\s+push\b[^;&|]*(?:--force\b|-f\b|--force-with-lease)/, 'force-pushes'],
  [/\bgit\s+reset\s+--hard\b/, 'discards uncommitted work (git reset --hard)'],
  [/\bgit\s+clean\b[^;&|]*-\w*[fdx]/, 'deletes untracked files (git clean)'],
  [/\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, 'discards working-tree changes'],
  [/\bgit\s+branch\s+-D\b/, 'force-deletes a branch'],
  [/(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, 'pipes a download into a shell'],
  [/\b(?:chmod|chown)\s+(?:-\w*R\w*|--recursive)\b/, 'changes permissions recursively'],
  [/\b(?:kill|killall|pkill)\s+(?:-9|-KILL)\b/, 'force-kills processes'],
  [/\b(?:shutdown|reboot|halt|launchctl\s+(?:unload|remove|bootout))\b/, 'changes system state'],
  [/\bbrew\s+(?:uninstall|remove|cleanup)\b/, 'removes packages'],
  [/\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish|deprecate)\b/, 'publishes or unpublishes a package'],
  [/\b(?:drop\s+(?:database|table)|truncate\s+table)\b/i, 'drops database data'],
  [/\bdocker\s+(?:system\s+prune|volume\s+rm|rm\s+-f)\b/, 'removes docker data'],
  [/\bkubectl\s+(?:delete|apply|replace)\b/, 'changes a cluster'],
  [/\bterraform\s+(?:apply|destroy)\b/, 'changes infrastructure'],
  [/\bdefaults\s+(?:write|delete)\b/, 'changes macOS preferences'],
];

const READONLY_CMDS = new Set([
  'ls', 'll', 'la', 'pwd', 'cat', 'bat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'whereis', 'type', 'whoami', 'id', 'date', 'uname', 'hostname', 'file', 'stat', 'du', 'df', 'tree', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'ps', 'uptime', 'free', 'jq', 'yq', 'less', 'more', 'nl', 'tac', 'column', 'md5', 'md5sum', 'shasum', 'sha256sum', 'sw_vers', 'arch', 'nproc', 'true', 'test', '[', 'seq', 'sleep',
]);

const READONLY_SUBCOMMANDS: Record<string, RegExp> = {
  git: /^git(?:\s+-C\s+\S+)?\s+(?:status|log|diff|show|branch(?:\s+(?:-a|-r|-v|-vv|--list|--show-current))?|remote(?:\s+-v)?|rev-parse|rev-list|ls-files|ls-tree|blame|describe|tag(?:\s+-l|\s+--list)?|config\s+(?:--get|--list|-l)|shortlog|stash\s+list|reflog|grep|cat-file|name-rev|merge-base|worktree\s+list|diff-tree|show-ref|for-each-ref)\b/,
  npm: /^npm\s+(?:ls|list|view|info|outdated|root|prefix|-v|--version|config\s+get|run)\b(?!\s+(?:build|deploy|publish))/,
  pnpm: /^pnpm\s+(?:ls|list|why|outdated|root|-v|--version)\b/,
  yarn: /^yarn\s+(?:list|why|info|-v|--version)\b/,
  node: /^node\s+(?:-v|--version|-p\s+['"]process\.version['"])\s*$/,
  python: /^python3?\s+(?:-V|--version)\s*$/,
  pip: /^pip3?\s+(?:list|show|freeze|--version)\b/,
  cargo: /^cargo\s+(?:--version|-V|metadata|tree|search)\b/,
  go: /^go\s+(?:version|env|list)\b/,
  docker: /^docker\s+(?:ps|images|version|info|logs|inspect|stats\s+--no-stream)\b/,
  kubectl: /^kubectl\s+(?:get|describe|logs|config\s+(?:view|current-context)|version|top)\b(?![^|;&]*\bsecrets?\b)/,
  brew: /^brew\s+(?:list|info|--version|outdated|search|deps|leaves|--prefix)\b/,
  gh: /^gh\s+(?:pr|issue|repo|run|workflow)\s+(?:view|list|status|checks|diff)\b/,
  find: /^find\b(?![^|;&]*(?:-exec|-delete|-ok|-fprint|-fls))/,
  sed: /^sed\s+-n\b/,
  awk: /^awk\b(?![^|;&]*(?:system|>))/,
  env: /^env\s*$/,
};

/** Split a shell line into simple commands on ; && || | and newlines (quote-aware enough for classification). */
export function splitSimple(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      cur += ch;
      if (ch === q && line[i - 1] !== '\\') q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((ch === '|' || ch === '&') && line[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function unquotedHas(line: string, re: RegExp): boolean {
  // Strip quoted segments so `echo "a > b"` does not look like a redirect.
  const stripped = line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  return re.test(stripped);
}

export function isReadOnlyCommand(cmd: string): boolean {
  if (unquotedHas(cmd, /(?:^|[^<>&\d])>{1,2}(?!&)|\btee\b|`|\$\(|<\(|>\(/)) return false;
  const simple = splitSimple(cmd);
  if (simple.length === 0) return false;
  return simple.every((s) => {
    const words = s.replace(/^\s*(?:\w+=\S*\s+)+/, '').trim();
    const first = words.split(/\s+/)[0] ?? '';
    const base = path.basename(first);
    if (READONLY_CMDS.has(base)) return true;
    const re = READONLY_SUBCOMMANDS[base];
    return !!re && re.test(words.startsWith(first) ? words.replace(first, base) : words);
  });
}

export function assessCommand(cmd: string, mode: 'ask' | 'auto', allow: string[] = []): Assessment {
  for (const [re, why] of DENY) if (re.test(cmd)) return { verdict: 'deny', risk: 'risky', reason: `Blocked: ${why}.` };
  for (const [re, why] of RISKY) if (re.test(cmd)) return { verdict: 'ask', risk: 'risky', reason: `Needs your approval: ${why}.` };
  if (isReadOnlyCommand(cmd)) return { verdict: 'auto', risk: 'read', reason: 'read-only command' };
  if (matchesAllow(cmd, allow)) return { verdict: 'auto', risk: 'command', reason: 'previously approved' };
  if (mode === 'auto') return { verdict: 'auto', risk: 'command', reason: 'auto mode' };
  return { verdict: 'ask', risk: 'command', reason: 'runs a command in your shell' };
}

export function allowKeyForCommand(cmd: string): string {
  const first = splitSimple(cmd)[0] ?? cmd;
  const words = first.replace(/^\s*(?:\w+=\S*\s+)+/, '').split(/\s+/);
  return `run_command:${words.slice(0, words[0] === 'git' || words[0] === 'npm' || words[0] === 'pnpm' || words[0] === 'yarn' || words[0] === 'cargo' || words[0] === 'make' ? 2 : 1).join(' ')}`;
}

function matchesAllow(cmd: string, allow: string[]): boolean {
  const simple = splitSimple(cmd);
  if (simple.length === 0) return false;
  return simple.every((s) => allow.includes(allowKeyForCommand(s)) || isReadOnlyCommand(s));
}

// ------------------------------------------------------------------ file paths

const home = () => os.homedir();

export function isSensitivePath(p: string): boolean {
  const abs = path.resolve(p);
  const h = home();
  const rels = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.kube', '.docker/config.json', '.netrc', '.npmrc', '.pypirc', '.jaffer/secrets.json', 'Library/Keychains', '.config/gh/hosts.yml'];
  return rels.some((r) => abs === path.join(h, r) || abs.startsWith(path.join(h, r) + path.sep)) || /(^|\/)\.env(\.[\w.-]+)?$/.test(abs) || /(^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(abs);
}

export function isSystemPath(p: string): boolean {
  const abs = path.resolve(p);
  return ['/etc', '/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/var/root'].some((r) => abs === r || abs.startsWith(r + path.sep)) && !abs.startsWith('/usr/local/');
}

export function assessFileRead(p: string): Assessment {
  if (isSensitivePath(p)) return { verdict: 'ask', risk: 'risky', reason: 'This file may contain credentials.' };
  return { verdict: 'auto', risk: 'read', reason: 'read-only' };
}

export function assessFileWrite(p: string, mode: 'ask' | 'auto', allow: string[], tool: string): Assessment {
  if (isSensitivePath(p) || isSystemPath(p)) return { verdict: 'ask', risk: 'risky', reason: 'Writes to a sensitive or system location.' };
  if (allow.includes(`${tool}:*`)) return { verdict: 'auto', risk: 'write', reason: 'previously approved' };
  if (mode === 'auto') return { verdict: 'auto', risk: 'write', reason: 'auto mode' };
  return { verdict: 'ask', risk: 'write', reason: 'modifies a file' };
}
