import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_LABEL, parseMcpList, runMcpList } from '../src/core/claude/mcp';
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

  it('bounded: 1 MB and 8 MB lines (only the first 64 KB is read)', () => {
    for (const n of [1, 8]) {
      const big = 'a'.repeat(n * 1024 * 1024);
      for (const text of [`x: ${big} - ✓ Connected`, `${big}: npx - ✓ Connected`, `\x1b[${'1;'.repeat(n * 300_000)}`, big, `${'y: - '.repeat(n * 200_000)}`]) {
        const t = Date.now();
        const r = parseMcpList(text);
        expect(Date.now() - t, `${n} MB`).toBeLessThan(250);
        expect(JSON.stringify(r)).not.toMatch(/a{65}/);
      }
    }
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

  it('more than 64 KB of output: the first 64 KB counts, it is not an error', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `server${i}: npx some-long-package-name --with args - ✓ Connected`).join('\n');
    expect(lines.length).toBeGreaterThan(200_000);
    fake.setMcpList(lines);
    const r = await runMcpList(fake.bin, env.userHome, process.env);
    expect(r.ok).toBe(true);
    expect(r.servers).toHaveLength(100);
  });
});
