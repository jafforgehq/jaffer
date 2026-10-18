import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_LABEL, mcpPath, parseMcpList, runMcpList, stopMcpChecks } from '../src/core/claude/mcp';
import { fakeClaude } from './helpers/fake-claude';
import { makeEnv, type TestEnv } from './helpers/env';

/** What `claude mcp list` prints (its words as documented; the commands, arguments and URLs must never come out). */
const SAMPLE = [
  'Checking MCP server health…',
  '',
  'github: npx -y @modelcontextprotocol/server-github --token ghp_SECRETSECRETSECRETSECRETSECRET12 - ✓ Connected',
  'linear: https://mcp.linear.app/sse?key=SECRET-URL (SSE) - ⚠ Needs authentication',
  'broken: node /Users/x/SECRET-PATH/server.js - ✗ Failed to connect',
  'flaky: python srv.py --password SECRET-PW - ✗ Connection error',
  'newone: npx thing - ⏸ Pending approval',
  'off: npx off-server - Disabled for this project',
  'plugin:context7:context7: npx -y @upstash/context7-mcp - ✓ Connected',
  'weird: something --flag - ? Some new state',
].join('\n');

describe('parseMcpList: the text of `claude mcp list`, line by line', () => {
  it('names and states only, by the documented words; the header and blank lines are skipped; never a command, an argument or a URL', () => {
    const r = parseMcpList(SAMPLE);
    expect(r.map((s) => [s.name, s.status])).toEqual([
      ['github', 'connected'],
      ['linear', 'needs-auth'],
      ['broken', 'failed'],
      ['flaky', 'failed'],
      ['newone', 'pending'],
      ['off', 'disabled'],
      ['plugin:context7:context7', 'connected'],
      ['weird', 'unknown'],
    ]);
    for (const s of r) expect(s.label).toBe(MCP_LABEL[s.status]);
    const all = JSON.stringify(r);
    for (const never of ['SECRET', 'npx', 'https', 'node', 'python', '--', 'ghp_', 'Checking']) expect(all, never).not.toContain(never);
  });

  it('ANSI colours and control characters are dropped; a secret in a name is redacted; names are cut to 64; at most 100 servers', () => {
    const r = parseMcpList(`\x1b[32mgithub\x1b[0m: npx x - \x1b[32m✓ Connected\x1b[0m\r\nsk-ant-api03-${'A'.repeat(30)}: npx - ✓ Connected\n${'n'.repeat(300)}: x - ✗ Failed to connect\n`);
    expect(r[0]).toMatchObject({ name: 'github', status: 'connected' });
    expect(r[1]!.name).not.toContain('AAAAAAAA');
    expect(r[2]!.name.length).toBe(64);
    expect(r[2]!.status).toBe('failed');
    const many = Array.from({ length: 300 }, (_, i) => `s${i}: x - ✓ Connected`).join('\n');
    expect(parseMcpList(many)).toHaveLength(100);
    expect(parseMcpList('')).toEqual([]);
    expect(parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.')).toEqual([]);
    expect(parseMcpList('Error: something went wrong')).toEqual([]); // (no state word and no " - ": not a server line)
  });

  it('OSC sequences (links, titles) are dropped with what they carry, as well as CSI colours; lines that start with Error are not servers', () => {
    const r = parseMcpList(
      [
        '\x1b]8;;https://example.com/SECRET-LINK\x07github\x1b]8;;\x07: npx - ✓ Connected',
        '\x1b]0;SECRET-TITLE\x1b\\docs: x - ⚠ Needs authentication',
        'Error: something - ✓ Connected',
        'Errors: x - ✗ Failed to connect',
      ].join('\n'),
    );
    expect(r.map((s) => [s.name, s.status])).toEqual([
      ['github', 'connected'],
      ['docs', 'needs-auth'],
    ]);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    const t = Date.now();
    parseMcpList(`\x1b]${'a'.repeat(1024 * 1024)}`);
    parseMcpList(`\x1b]${'\x1b]a'.repeat(300_000)}`);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('bounded: 1 MB and 8 MB lines (only the first 64 KB is read)', () => {
    for (const n of [1, 8]) {
      const big = 'a'.repeat(n * 1024 * 1024);
      for (const text of [`x: ${big} - ✓ Connected`, `${big}: npx - ✓ Connected`, `\x1b[${'1;'.repeat(n * 300_000)}`, big, `${'y: - '.repeat(n * 200_000)}`]) {
        const t = Date.now();
        const r = parseMcpList(text);
        expect(Date.now() - t, `${n} MB`).toBeLessThan(1000);
        expect(JSON.stringify(r)).not.toMatch(/a{65}/);
      }
    }
  });
});

describe('(1.4.2) parseMcpList: the real lines of `claude mcp list` (targets redacted), names with spaces and plugin names', () => {
  const REAL = [
    'Checking MCP server health…',
    '',
    'claude.ai Claude Docs: https://example.invalid/mcp - ✔ Connected',
    'plugin:context7:context7: https://example.invalid/mcp - ! Needs authentication',
    'godot: npx -y example-mcp - ✘ Failed to connect — ENOENT: Executable not found in $PATH: "npx"',
    'godot-ai: http://localhost:1234/mcp - ✘ Failed to connect — ECONNREFUSED: ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
    "isoforge: /Users/x/.venv/bin/python server.py - ✘ Failed to connect — ENOENT: ENOENT: no such file or directory, posix_spawn '/Users/x/.venv/bin/python'",
    'orbion: npx -y orbion-mcp - ✔ Connected',
    'claude.ai Google Drive: https://example.invalid/gdrive - ✔ Connected',
    'claude.ai Gmail: https://example.invalid/gmail - ! Needs authentication',
    'claude.ai Slack Tools: https://example.invalid/slack - ✘ Failed to connect',
    'Error: Some MCP server says: oops - ✔ Connected',
  ].join('\n');

  it('keeps the whole name before the target (a URL, a path or a command), with the states as before; never a target, a URL or an error text', () => {
    const r = parseMcpList(REAL);
    expect(r.map((s) => [s.name, s.status])).toEqual([
      ['claude.ai Claude Docs', 'connected'],
      ['plugin:context7:context7', 'needs-auth'],
      ['godot', 'failed'],
      ['godot-ai', 'failed'],
      ['isoforge', 'failed'],
      ['orbion', 'connected'],
      ['claude.ai Google Drive', 'connected'],
      ['claude.ai Gmail', 'needs-auth'],
      ['claude.ai Slack Tools', 'failed'],
    ]);
    for (const s of r) expect(s.label).toBe(MCP_LABEL[s.status]);
    const all = JSON.stringify(r);
    for (const never of ['example', 'http', 'npx', 'python', '/Users', 'ENOENT', 'ECONNREFUSED', 'PATH', 'Checking', 'oops']) expect(all, never).not.toContain(never);
  });

  it('a name with a space needs a URL or a path after it (prose with a colon is not a server); ANSI colours are dropped; a hostile 1 MB line is quick', () => {
    expect(parseMcpList('Note on servers: run them again - ✔ Connected')).toEqual([]);
    expect(parseMcpList('\x1b[1mclaude.ai Claude Docs\x1b[0m: https://example.invalid/mcp - \x1b[32m✔ Connected\x1b[0m')).toEqual([{ name: 'claude.ai Claude Docs', status: 'connected', label: 'Connected' }]);
    expect(parseMcpList('My Server: ~/bin/srv - ✔ Connected\nLocal Thing: ./srv.sh - ✘ Failed to connect')).toEqual([
      { name: 'My Server', status: 'connected', label: 'Connected' },
      { name: 'Local Thing', status: 'failed', label: 'Failed to connect' },
    ]);
    // the first ": " that a target follows ends the name
    expect(parseMcpList('claude.ai Tasks: Work: https://example.invalid/t - ✔ Connected').map((s) => s.name)).toEqual(['claude.ai Tasks: Work']);
    for (const text of [`${'a: '.repeat(350_000)}`, `claude.ai ${'x '.repeat(500_000)}: https://e - ✔ Connected`, `${'a b: '.repeat(200_000)}https://e - ✔ Connected`]) {
      const t = Date.now();
      const r = parseMcpList(text);
      expect(Date.now() - t).toBeLessThan(1000);
      expect(r.every((s) => s.name.length <= 64)).toBe(true);
    }
  });
});

describe('(1.4.2) mcpPath: the PATH `claude mcp list` runs with', () => {
  const home = '/Users/someone';
  const all = () => true;
  it('the focused shell\'s PATH when it reported one', () => {
    expect(mcpPath('/Users/someone/.nvm/bin:/usr/bin:/bin', '/usr/bin:/bin', home, all)).toBe('/Users/someone/.nvm/bin:/usr/bin:/bin');
  });
  it('otherwise the app\'s PATH with the usual tool folders added once each, in order, only when they exist', () => {
    expect(mcpPath(undefined, '/usr/bin:/bin:/usr/sbin:/sbin', home, all)).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/Users/someone/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin');
    expect(mcpPath(undefined, '/opt/homebrew/bin:/usr/bin', home, all)).toBe('/opt/homebrew/bin:/usr/bin:/Users/someone/.local/bin:/opt/homebrew/sbin:/usr/local/bin');
    expect(mcpPath(undefined, '/usr/bin:/bin', home, (d) => d === '/usr/local/bin')).toBe('/usr/bin:/bin:/usr/local/bin');
    expect(mcpPath(undefined, undefined, home, () => false)).toBe('');
    expect(mcpPath(undefined, '', home, (d) => d === '/opt/homebrew/bin')).toBe('/opt/homebrew/bin');
  });
  it('a shell PATH that is not usable (empty, control characters, past 8192 characters) falls back', () => {
    for (const bad of ['', '/a\nb', '/a\x1bb', '/a\x85b', '/a\x7fb', `/${'a'.repeat(8192)}`]) expect(mcpPath(bad, '/usr/bin', home, () => false), JSON.stringify(bad.slice(0, 9))).toBe('/usr/bin');
  });
});

describe('runMcpList: `claude mcp list` once, in a folder, bounded', () => {
  let env: TestEnv;
  let fake: ReturnType<typeof fakeClaude>;
  beforeEach(() => {
    env = makeEnv();
    fake = fakeClaude(path.join(env.root, 'bin'), { loggedIn: true });
  });
  afterEach(() => env.cleanup());

  it('runs `mcp list` (no shell) in the folder, without the Jaffer session variables, and parses what it prints', async () => {
    fake.setMcpList(SAMPLE);
    const dir = path.join(env.userHome, 'proj');
    fs.mkdirSync(dir);
    const r = await runMcpList(fake.bin, dir, { ...process.env, HOME: env.userHome, JAFFER_SESSION: '1', JAFFER_PANE: 'p2', JAFFER_OWNED: '1' });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.servers.map((s) => s.status)).toEqual(['connected', 'needs-auth', 'failed', 'failed', 'pending', 'disabled', 'connected', 'unknown']);
    expect(fake.calls().filter((l) => l.startsWith('mcp list'))).toHaveLength(1);
    expect(fake.read('mcp.cwd')).toBe(dir);
    expect(fake.read('mcp.env')).toBe('||');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('no claude, or a claude that is not there: no-claude; a failing one: error, with what it printed', async () => {
    expect(await runMcpList(null, env.userHome, process.env)).toEqual({ servers: [], ok: false, reason: 'no-claude' });
    expect(await runMcpList(path.join(env.root, 'nope', 'claude'), env.userHome, process.env)).toEqual({ servers: [], ok: false, reason: 'no-claude' });
    fake.setMcpList('a: x - ✓ Connected');
    fake.setMode('mcp-fail');
    const r = await runMcpList(fake.bin, env.userHome, process.env);
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(r.servers.map((s) => s.name)).toEqual(['a']);
  });

  it('a claude that hangs is stopped at the timeout, with the servers it started (its whole process group)', async () => {
    fake.setMode('mcp-hang');
    const t = Date.now();
    const r = await runMcpList(fake.bin, env.userHome, process.env, 800);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r).toEqual({ servers: [], ok: false, reason: 'timeout' });
    const child = Number(fake.read('mcp.child'));
    expect(child).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number) => {
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    return !alive(pid);
  };

  it('a claude that ends but leaves something it started running: its process group is ended too', async () => {
    fake.setMcpList('a: x - ✓ Connected');
    fake.setMode('mcp-orphan');
    const r = await runMcpList(fake.bin, env.userHome, process.env);
    expect(r).toMatchObject({ ok: true });
    const child = Number(fake.read('mcp.child'));
    expect(child).toBeGreaterThan(0);
    expect(await gone(child)).toBe(true);
  });

  it('stopMcpChecks (the daemon stopping) ends a check under way with its process group', async () => {
    fake.setMode('mcp-hang');
    const p = runMcpList(fake.bin, env.userHome, process.env);
    for (let i = 0; i < 100 && !fake.read('mcp.child'); i++) await new Promise((res) => setTimeout(res, 50));
    const child = Number(fake.read('mcp.child'));
    expect(child).toBeGreaterThan(0);
    const t = Date.now();
    stopMcpChecks();
    expect((await p).ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(await gone(child)).toBe(true);
  });

  it('more than 64 KB of output: the first 64 KB counts, it is not an error', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `server${i}: npx some-long-package-name --with args - ✓ Connected`).join('\n');
    expect(lines.length).toBeGreaterThan(200_000);
    fake.setMcpList(lines);
    const r = await runMcpList(fake.bin, env.userHome, process.env);
    expect(r.ok).toBe(true);
    expect(r.servers).toHaveLength(100);
  });
});
