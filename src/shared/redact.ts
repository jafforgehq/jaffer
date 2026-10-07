/**
 * Secret redaction. Everything that flows into memory (episodes, items, prompts to
 * the reflector) goes through here first. The bias is deliberately towards
 * over-redaction: losing a token from a note costs nothing, leaking one costs a lot.
 */

interface Rule {
  name: string;
  re: RegExp;
  /** Replacement. Functions keep the key name while masking the value. */
  replace: string | ((m: string, ...groups: string[]) => string);
}

const MASK = '[REDACTED]';

const RULES: Rule[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, replace: `${MASK}:private-key` },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: `${MASK}:anthropic-key` },
  { name: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g, replace: `${MASK}:api-key` },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, replace: `${MASK}:github-token` },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: `${MASK}:gitlab-token` },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, replace: `${MASK}:aws-key` },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: `${MASK}:slack-token` },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: `${MASK}:google-key` },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/g, replace: `${MASK}:stripe-key` },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}/g, replace: `${MASK}:npm-token` },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: `${MASK}:jwt` },
  { name: 'bearer', re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: (_m, scheme) => `${scheme} ${MASK}` },
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]{0,19}:\/\/)([^\s/:@]{1,128}):([^\s/@]{1,512})@/gi, replace: (_m, scheme, user) => `${scheme}${user}:${MASK}@` },
  {
    // --password=hunter2, --token abc, --api-key=..., --password "two words"
    name: 'cli-flag',
    re: /(--?(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|auth[-_]?token|client[-_]?secret))(?:=|\s+)(?!-)(?:"[^"\n]{1,256}"|'[^'\n]{1,256}'|[^\s'"]+)/gi,
    replace: (_m, flag) => `${flag}=${MASK}`,
  },
  {
    // mysql -u root -pHunter2, 7z a -pSecret x.7z: the value is glued to -p, so only for the programs that take it that way
    // (anywhere else, -p8080 or -pthread is a port or a compiler flag)
    name: 'attached-password-flag',
    re: /\b(mysql|mysqldump|mysqladmin|mysqlcheck|mariadb|mycli|7za?|7zz|unrar|rar)\b([^|;&\n]*?\s)(-p)(?!-)\S+/g,
    replace: (_m, cmd, mid, flag) => `${cmd}${mid}${flag}${MASK}`,
  },
  {
    // sshpass -p secret, docker login -u me -p secret
    name: 'password-flag-after-command',
    re: /\b(sshpass\s+(?:-e\s+)?-p\s*|docker\s+login\b[^|;&\n]*?\s-p\s+)(?!-)(['"]?)[^\s'"]+\2/g,
    replace: (_m, pre) => `${pre}${MASK}`,
  },
  {
    // curl -u user:password, wget --user=me ... (the password half of user:password)
    name: 'basic-auth-flag',
    re: /(\b(?:curl|wget|http|https|xh)\b[^|;&\n]*?\s(?:-u|--user|--proxy-user)(?:=|\s+)['"]?[^\s:'"]+:)[^\s'"]+/g,
    replace: (_m, pre) => `${pre}${MASK}`,
  },
  {
    // openssl rsa -passin pass:secret, -passout pass:secret (plain -pass is a cli-flag above)
    name: 'openssl-pass',
    re: /(-pass(?:in|out)\s+pass:)\S+/g,
    replace: (_m, pre) => `${pre}${MASK}`,
  },
  {
    // FOO_API_KEY=abc, password: "two words", export TOKEN='abc'. The key is bounded on both sides: an unbounded run of key
    // characters made this rule quadratic (seconds for a few KB of dots) on the daemon's main thread.
    name: 'assignment',
    re: /\b([A-Za-z0-9_.-]{0,64}(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization|auth[_-]?(?:token|key))[A-Za-z0-9_.-]{0,64})(["']?\s*[=:]\s*)(?:(")[^"\n]{1,256}"|(')[^'\n]{1,256}'|(?!(?:Bearer|Basic|Token)\b)[^\s'"]{4,})/gi,
    replace: (_m, key, sep, quote = '') => `${key}${sep}${quote}${MASK}${quote}`,
  },
  { name: 'aws-secret', re: /\b(aws_secret_access_key\s*[=:]\s*)['"]?[A-Za-z0-9/+=]{30,}['"]?/gi, replace: (_m, pre) => `${pre}${MASK}` },
];

/** High-entropy tokens that no named rule caught (long url-safe base64/hex-ish blobs). */
const ENTROPY_RE = /(?<![A-Za-z0-9_./-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_./-])/g;

function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface RedactResult {
  text: string;
  count: number;
  kinds: string[];
}

export function redact(input: string): RedactResult {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      const m = args[0] as string;
      // Don't re-mask something already masked by an earlier rule.
      if (m.includes(MASK) && rule.name !== 'private-key') return m;
      count++;
      kinds.add(rule.name);
      if (typeof rule.replace === 'string') return rule.replace;
      const groups = args.slice(1, -2).filter((g): g is string => typeof g === 'string');
      return rule.replace(m, ...groups);
    });
  }
  text = text.replace(ENTROPY_RE, (m) => {
    // Pure hex of git-sha length is common and harmless; everything else with high entropy is suspect.
    if (/^[0-9a-f]{40}$/i.test(m) || /^[0-9a-f]{64}$/i.test(m)) return m;
    if (shannon(m) < 4.2) return m;
    count++;
    kinds.add('high-entropy');
    return `${MASK}:high-entropy`;
  });
  return { text, count, kinds: [...kinds] };
}

export function redactText(input: string): string {
  return redact(input).text;
}

/**
 * Commands whose invocation or output should never reach memory at all.
 * (A leading space follows the HISTCONTROL=ignorespace convention.)
 */
const SENSITIVE_CMD: RegExp[] = [
  /^\s/,
  /^\s*(?:sudo\s+)?(?:printenv|env)\s*$/,
  /^\s*(?:sudo\s+)?printenv\s+\S/,
  /\b(?:cat|less|more|bat|head|tail|cp|scp|rsync|source)\b[^|;&\n]*(?:^|[\s/])\.env(?:\.[\w-]+)?(?=\s|$)/,
  /^\s*(?:sudo\s+)?security\s+(?:find|dump|export|import|add)-/,
  /\b(?:cat|less|more|bat|head|tail|cp|scp|rsync)\b[^|;&]*(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)?\/?\.(?:ssh|gnupg|aws|kube|docker\/config|netrc|npmrc|pypirc)\b/,
  /\bgpg2?\b.*--(?:export-secret|decrypt)/,
  /\b(?:op|bw|lpass|pass|vault|gopass|1password)\s+(?:read|get|show|item|kv|login|unlock)\b/,
  /\bkubectl\b.*\bget\s+secrets?\b/,
  /\baws\s+(?:configure|sts\s+get-session-token|secretsmanager\s+get-secret-value|ssm\s+get-parameter)/,
  /\bgcloud\b.*\bauth\b.*\b(?:print-access-token|print-identity-token)\b/,
  /\becho\s+\$\{?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Za-z0-9_]*\}?/i,
  /\bssh-keygen\b/,
  /\bgh\s+auth\s+token\b/,
];

export function isSensitiveCommand(cmd: string): boolean {
  return SENSITIVE_CMD.some((re) => re.test(cmd));
}
