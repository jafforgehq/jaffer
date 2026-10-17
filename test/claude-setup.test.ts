import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frontmatter, readSetup } from '../src/core/claude/setup';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let home: string;
let claudeDir: string;
let proj: string;
let managedDir: string;
beforeEach(() => {
  env = makeEnv();
  home = env.userHome;
  claudeDir = path.join(home, '.claude');
  proj = path.join(home, 'work', 'app');
  managedDir = path.join(env.root, 'managed');
  fs.mkdirSync(proj, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.cleanup();
});

const w = (p: string, s: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const json = (p: string, v: unknown) => w(p, JSON.stringify(v));
const read = (cwd = proj) => readSetup({ home, claudeDir, cwd, managedDir });

describe('readSetup: what Claude Code is set up with, from its files only', () => {
  it('lists skills (with their override state), plugins, rules and memory, subagents, hooks (counts only) and the names in .mcp.json', async () => {
    w(path.join(claudeDir, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: "Does alpha things"\n---\nThe body is never read.\n');
    w(path.join(claudeDir, 'skills/beta/SKILL.md'), 'No frontmatter at all.\n');
    fs.mkdirSync(path.join(claudeDir, 'skills/gamma'), { recursive: true }); // no SKILL.md: not a skill
    w(path.join(claudeDir, 'skills/loose.md'), '---\nname: loose\n---\n'); // a file, not a skill folder
    w(path.join(proj, '.claude/skills/delta/SKILL.md'), `---\nname: delta\ndescription: >\n  ${'word '.repeat(80)}\n---\n`);
    json(path.join(claudeDir, 'settings.json'), {
      skillOverrides: { alpha: 'off', beta: 'name-only', nonsense: 'maybe' },
      enabledPlugins: { 'p1@m': true, 'p2@m': false },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo SECRET-HOOK-CMD' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] },
    });
    json(path.join(proj, '.claude/settings.json'), { skillOverrides: { delta: 'user-invocable-only' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] } });
    json(path.join(proj, '.claude/settings.local.json'), { enabledPlugins: { 'p2@m': true } });
    json(path.join(claudeDir, 'plugins/installed_plugins.json'), { version: 2, plugins: { 'p1@m': [{ scope: 'user', version: '1.2.0', installPath: '/secret/path' }], 'p2@m': [{ version: '0.1' }], 'p3@m': { version: '3' } } });
    w(path.join(claudeDir, 'CLAUDE.md'), 'user memory\n');
    w(path.join(env.root, 'CLAUDE.md'), 'above the home folder: not walked\n');
    w(path.join(home, 'CLAUDE.md'), 'home\n');
    w(path.join(home, 'work/CLAUDE.md'), 'work\n');
    w(path.join(proj, 'CLAUDE.md'), 'project rules\n');
    w(path.join(proj, '.claude/CLAUDE.md'), 'p2\n');
    w(path.join(proj, 'CLAUDE.local.md'), 'mine\n');
    w(path.join(managedDir, 'CLAUDE.md'), 'org\n');
    w(path.join(proj, '.claude/rules/api.md'), '---\npaths:\n  - "src/api/**/*.ts"\n---\nAPI rules\n');
    w(path.join(proj, '.claude/rules/sub/style.md'), 'Style rules\n');
    w(path.join(proj, '.claude/rules/notes.txt'), 'not a rule\n');
    w(path.join(claudeDir, 'rules/mine.md'), 'u\n');
    w(path.join(proj, '.claude/agents/reviewer.md'), '---\nname: code-reviewer\ndescription: reviews\n---\n');
    w(path.join(claudeDir, 'agents/helper.md'), 'no frontmatter\n');
    w(path.join(claudeDir, 'agents/notes.txt'), 'not an agent\n');
    json(path.join(proj, '.mcp.json'), { mcpServers: { github: { command: 'npx', args: ['--token', 'SECRET-MCP-ARG'] }, docs: { type: 'http', url: 'https://example.com/SECRET-URL' } } });
    json(path.join(home, 'work/.mcp.json'), { mcpServers: { parentsrv: { command: 'x' } } }); // a parent's is not read

    const s = await read();
    expect(s.skills).toEqual([
      { name: 'alpha', description: 'Does alpha things', scope: 'user', state: 'off' },
      { name: 'beta', scope: 'user', state: 'name-only' },
      { name: 'delta', description: expect.any(String), scope: 'project', state: 'user-invocable-only' },
    ]);
    expect(s.skills[2]!.description!.length).toBe(160);
    expect(s.skills[2]!.description!.startsWith('word word')).toBe(true);
    expect(s.plugins).toEqual([
      { id: 'p1@m', version: '1.2.0', enabled: true },
      { id: 'p2@m', version: '0.1', enabled: true }, // (the local settings win)
      { id: 'p3@m', version: '3', enabled: false },
    ]);
    const size = (p: string) => fs.statSync(p).size;
    expect(s.rules).toEqual([
      { path: '~/.claude/CLAUDE.md', kind: 'user', bytes: size(path.join(claudeDir, 'CLAUDE.md')), scoped: false },
      { path: path.join(managedDir, 'CLAUDE.md'), kind: 'managed', bytes: 4, scoped: false },
      { path: '~/work/app/CLAUDE.md', kind: 'project', bytes: 14, scoped: false },
      { path: '~/work/app/.claude/CLAUDE.md', kind: 'project', bytes: 3, scoped: false },
      { path: '~/work/app/CLAUDE.local.md', kind: 'local', bytes: 5, scoped: false },
      { path: '~/work/CLAUDE.md', kind: 'project', bytes: 5, scoped: false },
      { path: '~/CLAUDE.md', kind: 'project', bytes: 5, scoped: false },
      { path: '~/work/app/.claude/rules/api.md', kind: 'rule', bytes: size(path.join(proj, '.claude/rules/api.md')), scoped: true },
      { path: '~/work/app/.claude/rules/sub/style.md', kind: 'rule', bytes: 12, scoped: false },
      { path: '~/.claude/rules/mine.md', kind: 'rule', bytes: 2, scoped: false },
    ]);
    expect(s.agents).toEqual([
      { name: 'helper', scope: 'user' },
      { name: 'code-reviewer', scope: 'project' },
    ]);
    expect(s.hooks).toEqual([
      { event: 'PreToolUse', count: 2 },
      { event: 'Stop', count: 2 },
    ]);
    expect(s.mcpFile).toEqual([
      { name: 'docs', scope: 'project' },
      { name: 'github', scope: 'project' },
    ]);
    const all = JSON.stringify(s);
    for (const never of ['SECRET', 'npx', 'echo', 'https', 'installPath', '/secret/path', 'body is never read', 'parentsrv', 'above the home']) expect(all, never).not.toContain(never);
  });

  it('never opens ~/.claude.json (the login), not even through a link that stays inside a folder it reads', async () => {
    const secret = '{"oauthAccount":{"emailAddress":"SECRET-OAUTH@example.com"},"primaryApiKey":"SECRET-OAUTH-KEY"}';
    w(path.join(home, '.claude.json'), secret);
    w(path.join(home, '.claude.json.backup'), secret);
    w(path.join(claudeDir, '.claude.json'), secret); // where CLAUDE_CONFIG_DIR puts it
    fs.mkdirSync(path.join(claudeDir, 'skills/evil'), { recursive: true });
    fs.symlinkSync(path.join(home, '.claude.json'), path.join(home, 'CLAUDE.md')); // inside the home folder: refused by its name
    fs.symlinkSync(path.join(claudeDir, '.claude.json'), path.join(claudeDir, 'CLAUDE.md'));
    fs.symlinkSync(path.join(home, '.claude.json'), path.join(claudeDir, 'skills/evil/SKILL.md'));
    fs.symlinkSync(path.join(home, '.claude.json.backup'), path.join(proj, 'CLAUDE.local.md'));
    fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
    fs.symlinkSync(path.join(claudeDir, '.claude.json'), path.join(claudeDir, 'agents/x.md'));
    fs.symlinkSync(path.join(claudeDir, '.claude.json'), path.join(claudeDir, 'settings.json'));
    w(path.join(proj, 'CLAUDE.md'), 'fine\n'); // (one ordinary file, so the spies are seen to work)
    const opened: string[] = [];
    const real = (p: unknown) => {
      try {
        return fs.realpathSync(String(p));
      } catch {
        return String(p);
      }
    };
    for (const fn of ['open', 'readFile'] as const) {
      const orig = fs.promises[fn] as (...a: unknown[]) => unknown;
      vi.spyOn(fs.promises, fn).mockImplementation(((p: unknown, ...rest: unknown[]) => (opened.push(real(p)), orig.call(fs.promises, p, ...rest))) as never);
    }
    for (const fn of ['openSync', 'readFileSync'] as const) {
      const orig = fs[fn] as (...a: unknown[]) => unknown;
      vi.spyOn(fs, fn).mockImplementation(((p: unknown, ...rest: unknown[]) => (opened.push(real(p)), orig.call(fs, p, ...rest))) as never);
    }
    const s = await read();
    vi.restoreAllMocks();
    expect(opened.length).toBeGreaterThan(0); // (the spies see the reader's opens)
    expect(opened.filter((p) => path.basename(p).startsWith('.claude.json'))).toEqual([]);
    expect(JSON.stringify(s)).not.toContain('SECRET');
    expect(s.rules).toEqual([{ path: '~/work/app/CLAUDE.md', kind: 'project', bytes: 5, scoped: false }]);
    expect(s.skills).toEqual([]);
    expect(s.agents).toEqual([]);
  });

  it('(1.4.1) a FIFO where a settings, .mcp.json or CLAUDE.md file would be is not waited on (opening one would block a thread for ever)', async () => {
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    for (const f of ['.mcp.json', 'CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json']) execFileSync('mkfifo', [path.join(proj, f)]);
    const r = await Promise.race([read(), new Promise<'hung'>((res) => setTimeout(() => res('hung'), 3_000))]);
    expect(r).not.toBe('hung');
  });

  it('follows a link only while it stays inside the folder it was found in', async () => {
    w(path.join(env.root, 'elsewhere/skill/SKILL.md'), '---\nname: outside\n---\n');
    w(path.join(env.root, 'elsewhere/CLAUDE.md'), 'outside rules\n');
    fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(env.root, 'elsewhere/skill'), path.join(claudeDir, 'skills/escaped'));
    fs.symlinkSync(path.join(env.root, 'elsewhere/CLAUDE.md'), path.join(proj, 'CLAUDE.md'));
    w(path.join(claudeDir, 'skills/.store/real/SKILL.md'), '---\nname: kept\n---\n');
    fs.symlinkSync(path.join(claudeDir, 'skills/.store/real'), path.join(claudeDir, 'skills/linked'));
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(env.root, 'elsewhere'), path.join(proj, '.claude/rules'));
    const s = await read();
    expect(s.skills.map((k) => k.name)).toEqual(['kept']);
    expect(s.rules).toEqual([]);
  });

  it('the rules walk stays in the rules folder: a link inside it to the project (a big node_modules) is not walked, a cycle ends, 5000 entries stay bounded', async () => {
    w(path.join(proj, '.claude/rules/a.md'), 'a\n');
    for (let i = 0; i < 30; i++) w(path.join(proj, `node_modules/pkg${i}/README.md`), 'readme\n');
    fs.symlinkSync(proj, path.join(proj, '.claude/rules/up'));
    fs.symlinkSync(path.join(proj, '.claude/rules'), path.join(proj, '.claude/rules/loop'));
    fs.symlinkSync(path.join(proj, '.claude/rules'), path.join(proj, '.claude/rules/loop2'));
    let s = await read();
    expect(s.rules.filter((r) => r.kind === 'rule').map((r) => r.path)).toEqual(['~/work/app/.claude/rules/a.md']);
    // 10 folders of 500 entries: the walk stops at 2000 entries in all (the last folder's rule is not reached)
    for (let d = 0; d < 10; d++) for (let k = 0; k < 500; k++) w(path.join(proj, `.claude/rules/d${d}/x${k}.txt`), '');
    w(path.join(proj, '.claude/rules/zz/late.md'), 'late\n');
    const t = Date.now();
    s = await read();
    expect(Date.now() - t).toBeLessThan(3000);
    expect(s.rules.some((r) => r.path.endsWith('late.md'))).toBe(false);
  }, 30_000);

  it('a newer read supersedes an older one still walking: the older returns early with what it has', async () => {
    for (let d = 0; d < 4; d++) for (let k = 0; k < 20; k++) w(path.join(proj, `.claude/rules/d${d}/r${k}.md`), 'r\n');
    const older = read();
    const newer = read();
    const [o, n] = await Promise.all([older, newer]);
    expect(n.rules.filter((r) => r.kind === 'rule').length).toBe(50);
    expect(o.rules.filter((r) => r.kind === 'rule').length).toBeLessThan(50);
  });

  it('the folder is the home folder: what is both user and project is listed once, as the user’s', async () => {
    w(path.join(claudeDir, 'CLAUDE.md'), 'u\n');
    w(path.join(claudeDir, 'skills/one/SKILL.md'), '---\nname: one\n---\n');
    w(path.join(claudeDir, 'agents/a.md'), '---\nname: a\n---\n');
    json(path.join(claudeDir, 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    const s = await read(home);
    expect(s.rules).toEqual([{ path: '~/.claude/CLAUDE.md', kind: 'user', bytes: 2, scoped: false }]);
    expect(s.skills).toEqual([{ name: 'one', scope: 'user', state: 'on' }]);
    expect(s.agents).toEqual([{ name: 'a', scope: 'user' }]);
    expect(s.hooks).toEqual([{ event: 'Stop', count: 1 }]);
  });

  it('walks at most 12 folders up, and stops at the home folder', async () => {
    const deep = path.join(home, ...Array.from({ length: 14 }, (_, i) => `d${i}`));
    fs.mkdirSync(deep, { recursive: true });
    w(path.join(home, 'CLAUDE.md'), 'too far\n');
    w(path.join(home, 'd0/d1/CLAUDE.md'), 'level 12\n'); // deep is d13: d1 is 12 folders above it
    w(path.join(home, 'd0/CLAUDE.md'), 'level 13\n');
    const s = await read(deep);
    expect(s.rules.map((r) => r.path)).toEqual(['~/d0/d1/CLAUDE.md']);
  });

  it('hostile files: a 5 MB SKILL.md, frontmatter with control characters and a secret, bad JSON, odd kinds, 2000 entries, a missing folder: bounded, and nothing throws', async () => {
    w(path.join(claudeDir, 'skills/huge/SKILL.md'), '---\nname: ' + 'n'.repeat(5 * 1024 * 1024));
    w(path.join(claudeDir, 'skills/odd/SKILL.md'), `---\nname: "${'x'.repeat(1000)}"\ndescription: "a\x1b[31m red\x07 ‮flip token sk-ant-api03-${'A'.repeat(40)} end"\n---\n`);
    w(path.join(claudeDir, 'settings.json'), '{ not json');
    w(path.join(proj, '.claude/settings.json'), '[1,2,3]');
    json(path.join(proj, '.claude/settings.local.json'), { hooks: { Stop: 'nope', ['E'.repeat(500)]: [{ hooks: [{}] }], Notification: [{ hooks: 'x' }, 7] }, skillOverrides: ['off'], enabledPlugins: 'all' });
    w(path.join(claudeDir, 'plugins/installed_plugins.json'), '{"plugins": {"a@b": 5, "c@d": [null], "": [{"version": 9}]}}');
    w(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { ['s'.repeat(300)]: {}, 'tok sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB': {} } }));
    fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(claudeDir, 'agents', `a${i}.md`), '');
    const t = Date.now();
    const s = await read();
    expect(Date.now() - t).toBeLessThan(3000);
    const huge = s.skills.find((k) => k.name === 'huge');
    expect(huge).toEqual({ name: 'huge', scope: 'user', state: 'on' }); // no end of its frontmatter in the head: the folder's name
    const odd = s.skills.find((k) => k.scope === 'user' && k.name.startsWith('x'))!;
    expect(odd.name.length).toBeLessThanOrEqual(64);
    expect(odd.description).toMatch(/^a\[31m red flip token .*end$/);
    expect(odd.description).not.toMatch(/[\x00-\x1f‮]/);
    expect(JSON.stringify(s)).not.toContain('AAAAAAAAAA');
    expect(s.agents.length).toBeLessThanOrEqual(200);
    expect(s.hooks.every((h) => h.event.length <= 64)).toBe(true);
    expect(s.plugins.map((p) => p.id)).toEqual(['a@b', 'c@d']);
    expect(s.mcpFile.every((m) => m.name.length <= 64)).toBe(true);
    expect(JSON.stringify(s.mcpFile)).not.toContain('BBBBBBBBBB');
    // a folder that is not there: nothing of the project, no throw
    const gone = await read(path.join(home, 'no/such/folder'));
    expect(gone.mcpFile).toEqual([]);
  });

  it('frontmatter lines of spaces that end in CR, LF, U+2028 or U+2029 (240 KB) are quick through readSetup: a skill, an agent and a rule', async () => {
    for (const end of ['\r', '\n', ' ', ' ']) {
      const text = `---\n${`a:${' '.repeat(16_300)}${end}`.repeat(15)}\n---\n`;
      expect(text.length).toBeGreaterThan(240_000);
      w(path.join(claudeDir, 'skills/slow/SKILL.md'), text);
      w(path.join(claudeDir, 'agents/slow.md'), text);
      w(path.join(proj, '.claude/rules/slow.md'), text);
      const t = Date.now();
      const s = await read();
      expect(Date.now() - t, JSON.stringify(end)).toBeLessThanOrEqual(1500);
      expect(s.skills.map((k) => k.name)).toEqual(['slow']);
      const t2 = Date.now();
      frontmatter(text);
      expect(Date.now() - t2, JSON.stringify(end)).toBeLessThanOrEqual(1500);
    }
  });

  it('outside the home folder only the folder\'s own CLAUDE.md files are read, not its parents\'', async () => {
    const out = path.join(env.root, 'outside', 'proj');
    w(path.join(env.root, 'outside', 'CLAUDE.md'), 'parent\n');
    w(path.join(env.root, 'CLAUDE.md'), 'root\n');
    w(path.join(out, 'CLAUDE.md'), 'own\n');
    w(path.join(out, 'CLAUDE.local.md'), 'mine\n');
    const s = await read(out);
    expect(s.rules.map((r) => r.path)).toEqual([path.join(out, 'CLAUDE.md'), path.join(out, 'CLAUDE.local.md')]);
  });

  it('frontmatter reads the head only: 1 MB and 8 MB lines are quick', () => {
    for (const n of [1, 8]) {
      const big = 'k'.repeat(n * 1024 * 1024);
      for (const text of [`---\nname: ${big}`, `---\n${big}:x\n---\n`, `---\n${big}`, `${big}\n---\nname: x\n---\n`, `---\n${'a: b\n'.repeat(n * 200_000)}---\n`]) {
        const t = Date.now();
        frontmatter(text);
        expect(Date.now() - t, `${n} MB`).toBeLessThan(1000);
      }
    }
    expect(frontmatter('---\nname: x\ndescription: |\n  two\n  lines\npaths:\n  - a\n---\nbody')).toEqual({ name: 'x', description: 'two lines', paths: '- a' });
    expect(frontmatter('no frontmatter')).toEqual({});
  });
});
