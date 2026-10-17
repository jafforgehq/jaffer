import fs from 'node:fs';
import path from 'node:path';
import { tildeOf } from '../../shared/history-label';
import { COMMAND_HEAD } from '../../shared/process-badge';
import { redactText } from '../../shared/redact';

/**
 * (1.4.0) What Claude Code is set up with in a folder, for the side panel's Setup list: from its files only (no process runs). Skills
 * (`<claudeDir>/skills/<n>/SKILL.md`, `<cwd>/.claude/skills/<n>/SKILL.md`: the frontmatter's name and description, the state from
 * `skillOverrides`), plugins (`<claudeDir>/plugins/installed_plugins.json` and `enabledPlugins`), the CLAUDE.md files and rules Claude reads
 * there (path, size, scoped by `paths:`), subagents (their names), hooks (event names and counts: never a command) and the server names of
 * `<cwd>/.mcp.json` (never a command, an argument or a URL). Read only and bounded: the head of a file (256 KB, 1 MB for JSON), at most 500
 * entries a folder; a link counts only while it stays inside the folder it was found in; `.claude.json` (Claude's login) is never opened,
 * whatever leads to it. Everything shown is cleaned and redacted; nothing throws and nothing is kept.
 */
export type SkillState = 'on' | 'name-only' | 'user-invocable-only' | 'off';
export interface SetupInfo {
  skills: { name: string; description?: string; scope: 'user' | 'project'; state: SkillState }[];
  plugins: { id: string; version?: string; enabled: boolean }[];
  rules: { path: string; kind: 'user' | 'project' | 'local' | 'managed' | 'rule'; bytes: number; scoped: boolean }[];
  agents: { name: string; scope: 'user' | 'project' }[];
  hooks: { event: string; count: number }[];
  mcpFile: { name: string; scope: 'project' }[];
}

const HEAD = 256 * 1024;
const JSON_MAX = 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_ITEMS = 200;
const MAX_RULES = 50;
/** The most names the `rules` folders' walk looks at, in all. */
const MAX_WALK = 2000;
const MAX_UP = 12;
const STATES: readonly string[] = ['on', 'name-only', 'user-invocable-only', 'off'];
export const MANAGED_DIR = '/Library/Application Support/ClaudeCode';
/** The newest read: an older one still walking the rules returns early with what it has (the panel only wants the newest). */
let newest = 0;

export async function readSetup(o: { home: string; claudeDir: string; cwd: string; managedDir?: string }): Promise<SetupInfo> {
  const mine = ++newest;
  const stale = () => mine !== newest;
  const { home, claudeDir, cwd } = o;
  const dot = path.join(cwd, '.claude');
  // the folder is the home folder: its .claude is the user's, listed once
  const same = (await real(dot)) !== undefined && (await real(dot)) === (await real(claudeDir));
  const settings: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const [base, file] of [
    [claudeDir, path.join(claudeDir, 'settings.json')],
    [cwd, path.join(dot, 'settings.json')],
    [cwd, path.join(dot, 'settings.local.json')],
  ] as const) {
    const r = await within(base, file);
    if (!r || seen.has(r)) continue;
    seen.add(r);
    const j = await readJson(base, file);
    if (j) settings.push(j);
  }
  // later files win (user, project, local)
  const merged = (key: string) => Object.assign({}, ...settings.map((s) => (isObj(s[key]) ? s[key] : {}))) as Record<string, unknown>;

  // the user's folder, then the project's (none when they are the same)
  const scopes = (sub: string): ['user' | 'project', string, string][] => [['user', claudeDir, path.join(claudeDir, sub)], ...(same ? [] : [['project', cwd, path.join(dot, sub)] as ['project', string, string]])];
  const overrides = merged('skillOverrides');
  const skills: SetupInfo['skills'] = [];
  for (const [scope, base, dir] of scopes('skills')) {
    for (const n of await list(base, dir)) {
      if (skills.length >= MAX_ITEMS) break;
      if (!(await isDir(base, path.join(dir, n)))) continue;
      const f = await readHead(base, path.join(dir, n, 'SKILL.md'), HEAD);
      if (!f) continue;
      const fm = frontmatter(f.text);
      const name = cleanLine(fm.name, 64) ?? cleanLine(n, 64);
      if (!name) continue;
      const description = cleanLine(fm.description, 160);
      const st = overrides[fm.name ?? n] ?? overrides[n];
      skills.push({ name, ...(description ? { description } : {}), scope, state: (typeof st === 'string' && STATES.includes(st) ? st : 'on') as SkillState });
    }
  }

  const enabled = merged('enabledPlugins');
  const installed = await readJson(claudeDir, path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const pl = isObj(installed?.plugins) ? (installed.plugins as Record<string, unknown>) : {};
  const plugins: SetupInfo['plugins'] = [];
  for (const id of [...new Set([...Object.keys(pl), ...Object.keys(enabled)])].sort().slice(0, MAX_ITEMS)) {
    const name = cleanLine(id, 100);
    if (!name) continue;
    const e = Array.isArray(pl[id]) ? (pl[id] as unknown[])[0] : pl[id];
    const version = isObj(e) && typeof e.version === 'string' ? cleanLine(e.version, 32) : undefined;
    plugins.push({ id: name, ...(version ? { version } : {}), enabled: enabled[id] === true });
  }

  const rules: SetupInfo['rules'] = [];
  const ruleSeen = new Set<string>();
  const addRule = async (base: string, file: string, kind: SetupInfo['rules'][number]['kind'], wantFm = false) => {
    const r = await within(base, file);
    if (!r || ruleSeen.has(r) || rules.length >= MAX_ITEMS) return;
    const f = await readHead(base, file, wantFm ? HEAD : 0);
    if (!f) return;
    ruleSeen.add(r);
    const shown = cleanLine(tildeOf(file, home), 512);
    if (shown) rules.push({ path: shown, kind, bytes: f.size, scoped: wantFm && frontmatter(f.text).paths !== undefined });
  };
  await addRule(claudeDir, path.join(claudeDir, 'CLAUDE.md'), 'user');
  const managed = o.managedDir ?? MANAGED_DIR;
  await addRule(managed, path.join(managed, 'CLAUDE.md'), 'managed');
  // the folder and its parents up to the home folder (at most 12 up); a folder outside the home folder: its own files only
  for (let d = cwd, i = 0; i <= MAX_UP; i++) {
    await addRule(d, path.join(d, 'CLAUDE.md'), 'project');
    await addRule(d, path.join(d, '.claude', 'CLAUDE.md'), 'project');
    await addRule(d, path.join(d, 'CLAUDE.local.md'), 'local');
    const up = path.dirname(d);
    // under the home folder: up to it; elsewhere: the folder's own files only
    if (d === home || up === d || !(cwd === home || cwd.startsWith(home + path.sep))) break;
    d = up;
  }
  let ruleFiles = 0;
  let walked = 0;
  const visited = new Set<string>();
  // confined to the rules folder itself (a link inside it to the project, or above, is not walked), each real folder once (no cycle),
  // 2000 names in all
  const walkRules = async (base: string, dir: string, depth: number): Promise<void> => {
    const r = await real(dir);
    if (!r || visited.has(r)) return;
    visited.add(r);
    for (const n of await list(base, dir)) {
      if (ruleFiles >= MAX_RULES || ++walked > MAX_WALK || stale()) return;
      const p = path.join(dir, n);
      if (n.endsWith('.md')) {
        ruleFiles++;
        await addRule(base, p, 'rule', true);
      } else if (depth < 8 && (await isDir(base, p))) await walkRules(base, p, depth + 1);
    }
  };
  const rulesOf = async (base: string, dir: string) => {
    const r = await within(base, dir); // (the rules folder itself must be inside its folder)
    if (r) await walkRules(r, dir, 0);
  };
  if (!same) await rulesOf(cwd, path.join(dot, 'rules'));
  await rulesOf(claudeDir, path.join(claudeDir, 'rules'));
  if (stale()) return { skills, plugins, rules, agents: [], hooks: [], mcpFile: [] };

  const agents: SetupInfo['agents'] = [];
  for (const [scope, base, dir] of scopes('agents')) {
    for (const n of await list(base, dir)) {
      if (agents.length >= MAX_ITEMS) break;
      if (!n.endsWith('.md')) continue;
      const f = await readHead(base, path.join(dir, n), HEAD);
      const name = f && (cleanLine(frontmatter(f.text).name, 64) ?? cleanLine(n.slice(0, -3), 64));
      if (name) agents.push({ name, scope });
    }
  }

  const counts = new Map<string, number>();
  for (const s of settings) {
    if (!isObj(s.hooks)) continue;
    for (const [event, groups] of Object.entries(s.hooks)) {
      if (!/^[A-Za-z]{1,64}$/.test(event) || !Array.isArray(groups)) continue;
      const n = groups.reduce((k: number, g) => k + (isObj(g) && Array.isArray(g.hooks) ? g.hooks.length : 0), 0);
      if (n) counts.set(event, (counts.get(event) ?? 0) + n);
    }
  }
  const hooks = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([event, count]) => ({ event, count }));

  const mcp = await readJson(cwd, path.join(cwd, '.mcp.json'));
  const mcpFile = (isObj(mcp?.mcpServers) ? Object.keys(mcp.mcpServers) : [])
    .slice(0, 100)
    .map((n) => cleanLine(n, 64))
    .filter((n): n is string => !!n)
    .sort()
    .map((name) => ({ name, scope: 'project' as const }));

  return { skills, plugins, rules, agents, hooks, mcpFile };
}

/** The `key: value` lines of a leading `---` block, from the head of the text; a value of `|`, `>` or nothing takes the indented lines (and `- ` items) after it. */
export function frontmatter(text: string): Record<string, string> {
  const head = text.slice(0, HEAD);
  if (!/^---\r?\n/.test(head)) return {};
  const end = head.search(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  let key: string | undefined;
  for (const raw of head.slice(head.indexOf('\n') + 1, end + 1).split(/\r?\n/)) {
    // (by hand, no regex over the value: a long run of spaces before a CR or a U+2028 would make a `(.*)$` pattern backtrack)
    const line = raw.slice(0, 4 * COMMAND_HEAD);
    const c = line.indexOf(':');
    const k = c > 0 && c <= 40 ? line.slice(0, c) : '';
    if (/^[A-Za-z_][\w-]*$/.test(k) && (c + 1 === line.length || line[c + 1] === ' ' || line[c + 1] === '\t')) {
      key = k;
      let v = line.slice(c + 1).trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
      out[key] = /^[|>][-+]?$/.test(v) ? '' : v;
    } else if (key && (line[0] === ' ' || line[0] === '\t' || line.startsWith('- '))) out[key] = `${out[key]} ${line.trim()}`.trim();
    else key = undefined;
  }
  return out;
}

/** One line to show: whitespace made spaces, control and format characters out, redacted, cut to `max`. */
export function cleanLine(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = redactText(
    s
      .slice(0, 4 * COMMAND_HEAD)
      .replace(/[\t\n\r]/g, ' ')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, max);
  return t || undefined;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

async function real(p: string): Promise<string | undefined> {
  return fs.promises.realpath(p).catch(() => undefined);
}

/** The real path of `p` when it stays inside `base` (links resolved) and is not Claude's login file; else undefined. */
async function within(base: string, p: string): Promise<string | undefined> {
  const [b, r] = [await real(base), await real(p)];
  if (!b || !r || (r !== b && !r.startsWith(b.endsWith(path.sep) ? b : b + path.sep))) return undefined;
  if (path.basename(r).toLowerCase().startsWith('.claude.json')) return undefined; // the login: never opened
  return r;
}

async function isDir(base: string, p: string): Promise<boolean> {
  const r = await within(base, p);
  return !!r && !!(await fs.promises.stat(r).catch(() => null))?.isDirectory();
}

/** At most 500 names of a folder inside `base`, sorted. */
async function list(base: string, dir: string): Promise<string[]> {
  const r = await within(base, dir);
  if (!r) return [];
  const out: string[] = [];
  try {
    const d = await fs.promises.opendir(r);
    for await (const e of d) {
      out.push(e.name);
      if (out.length >= MAX_ENTRIES) break; // (breaking out closes the folder)
    }
  } catch {
    /* not a folder, or gone */
  }
  return out.sort();
}

/** The first `max` bytes of a regular file inside `base`, and its size. */
async function readHead(base: string, p: string, max: number): Promise<{ text: string; size: number } | undefined> {
  const r = await within(base, p);
  if (!r) return undefined;
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(r, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const buf = Buffer.alloc(Math.min(max, st.size));
    const { bytesRead } = buf.length ? await fh.read(buf, 0, buf.length, 0) : { bytesRead: 0 };
    return { text: buf.subarray(0, bytesRead).toString('utf8'), size: st.size };
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function readJson(base: string, p: string): Promise<Record<string, any> | undefined> {
  const f = await readHead(base, p, JSON_MAX);
  if (!f || f.size > JSON_MAX) return undefined;
  try {
    const j = JSON.parse(f.text);
    return isObj(j) ? j : undefined;
  } catch {
    return undefined;
  }
}
