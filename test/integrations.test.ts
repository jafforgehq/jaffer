import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEngine, makeEnv, type TestEnv } from './helpers/env';
import { makeMemoryApi } from '../src/core/memory-api';
import { runMcpServer } from '../src/core/mcp/server';
import { claudeStatus, findClaude, hooksInstalled, installHooks, removeHooks, setupClaude, teardownClaude } from '../src/core/integrations/claude';
import { ClaudeIngestor, parseClaudeLine } from '../src/core/ingest/claude';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

function mcpSession(call: (m: string, p: any) => Promise<any>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  let buf = '';
  output.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const srv = runMcpServer({ call, version: 'test', cwd: env.userHome, input, output });
  const rpc = async (method: string, params?: unknown, id = lines.length + 100) => {
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 200; i++) {
      const hit = lines.find((l) => l.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('no response to ' + method);
  };
  return { rpc, input, close: () => srv.close(), lines };
}

describe('MCP server', () => {
  it('speaks the protocol and drives memory end to end', async () => {
    env.config.patch({ onboarded: true });
    const engine = makeEngine(env);
    const api = makeMemoryApi(engine);
    const s = mcpSession(async (m, p) => api[m]!(p));
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.serverInfo.name).toBe('jaffer');
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.instructions).toContain('jaffer_remember');
    s.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await s.rpc('tools/list');
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(['jaffer_context', 'jaffer_forget', 'jaffer_recall', 'jaffer_remember']);

    const rem = await s.rpc('tools/call', { name: 'jaffer_remember', arguments: { text: 'Integration tests must hit a real database, never mocks', kind: 'convention', scope: 'project' } });
    expect(rem.result.isError).toBeUndefined();
    expect(rem.result.content[0].text).toMatch(/Remembered \[m_/);
    expect(engine.store.listItems()[0]!.source).toBe('agent');

    const rec = await s.rpc('tools/call', { name: 'jaffer_recall', arguments: { query: 'database mocks integration tests' } });
    expect(rec.result.content[0].text).toContain('real database');

    const ctx = await s.rpc('tools/call', { name: 'jaffer_context', arguments: {} });
    expect(typeof ctx.result.content[0].text).toBe('string');

    const bad = await s.rpc('tools/call', { name: 'jaffer_remember', arguments: { text: 'my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    expect(bad.result.isError).toBe(true);

    const unknown = await s.rpc('tools/call', { name: 'nope', arguments: {} });
    expect(unknown.error.code).toBe(-32602);
    const ping = await s.rpc('ping');
    expect(ping.result).toEqual({});
    s.close();
  });
});

describe('Claude Code hooks', () => {
  it('merges into existing settings without disturbing the user\'s own hooks and removes cleanly', () => {
    const dir = path.join(env.userHome, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } }, null, 2));
    expect(installHooks('/Users/x/.jaffer/bin/jaffer', env.userHome).changed).toBe(true);
    expect(installHooks('/Users/x/.jaffer/bin/jaffer', env.userHome).changed).toBe(false); // idempotent
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0]).toEqual(mine);
    expect(s.hooks.SessionStart[0].hooks[0].command).toContain("'/Users/x/.jaffer/bin/jaffer' hook session-start");
    expect(hooksInstalled(env.userHome)).toBe(true);
    expect(removeHooks(env.userHome).changed).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(after).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } });
    expect(hooksInstalled(env.userHome)).toBe(false);
  });

  it('refuses to touch a settings file it cannot parse', () => {
    const dir = path.join(env.userHome, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ "model": "opus", // comment\n');
    const r = installHooks('/x/jaffer', env.userHome);
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/not valid JSON/);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toContain('// comment');
  });
});

describe('Claude Code transcript ingestion', () => {
  const line = (o: object) => JSON.stringify(o);

  it('keeps conversation turns and drops plumbing', () => {
    expect(parseClaudeLine(line({ type: 'user', message: { role: 'user', content: 'Please use pnpm here' }, cwd: '/w/app', timestamp: '2026-10-01T10:00:00Z' }))).toMatchObject({ role: 'user', text: 'Please use pnpm here', cwd: '/w/app' });
    expect(parseClaudeLine(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'Done.' }, { type: 'tool_use', name: 'Bash' }] } }))).toMatchObject({ role: 'assistant', text: 'Done.' });
    expect(parseClaudeLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }))).toBeNull();
    expect(parseClaudeLine(line({ type: 'user', isMeta: true, message: { role: 'user', content: 'injected' } }))).toBeNull();
    expect(parseClaudeLine(line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent' } }))).toBeNull();
    expect(parseClaudeLine(line({ type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }))).toBeNull();
    expect(parseClaudeLine(line({ type: 'ai-title', aiTitle: 'x' }))).toBeNull();
    expect(parseClaudeLine('not json')).toBeNull();
  });

  it('ingests incrementally, only complete lines, and never re-reads old history', () => {
    const proj = path.join(env.userHome, '.claude', 'projects', '-w-app');
    fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, 's1.jsonl');
    fs.writeFileSync(file, line({ type: 'user', message: { role: 'user', content: 'first message' }, cwd: '/w/app', timestamp: '2026-10-01T10:00:00Z' }) + '\n' + line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply one' }] }, cwd: '/w/app' }) + '\n{"type":"user","mess');
    const old = path.join(proj, 'ancient.jsonl');
    fs.writeFileSync(old, line({ type: 'user', message: { role: 'user', content: 'ancient history' }, cwd: '/w/app' }) + '\n');
    fs.utimesSync(old, new Date(Date.now() - 90 * 86_400_000), new Date(Date.now() - 90 * 86_400_000));

    const got: any[] = [];
    let offsets: Record<string, number> = {};
    const ing = new ClaudeIngestor({ home: env.userHome, backfillDays: 7, offsets, emit: (e) => got.push(e), save: (o) => (offsets = o) });
    expect(ing.scan().turns).toBe(2);
    expect(got.map((g) => g.text)).toEqual(['first message', 'reply one']);
    expect(got[0]).toMatchObject({ t: 'ext', agent: 'claude-code', role: 'user' });

    // the torn line is completed later and then picked up exactly once
    fs.appendFileSync(file, 'age":{"role":"user","content":"No, use yarn instead"},"cwd":"/w/app"}\n');
    expect(ing.scan().turns).toBe(1);
    expect(got[2]).toMatchObject({ text: 'No, use yarn instead', correction: true });
    expect(ing.scan().turns).toBe(0);
    expect(got.some((g) => g.text === 'ancient history')).toBe(false);
  });
});

// The real thing: register the MCP server with the actual Claude Code CLI (isolated HOME) and ask it to connect.
const CLAUDE_PATH = await findClaude().catch(() => null);
describe.skipIf(!CLAUDE_PATH)('Claude Code CLI wiring (real claude binary)', () => {
  it('registers the MCP server and Claude Code connects to it', async () => {
    const home = env.userHome;
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    // A tiny launcher standing in for ~/.jaffer/bin/jaffer: runs our MCP server from source via vite-node-free plain node.
    const bundle = path.join(env.root, 'mcp-launch.mjs');
    const esbuild = await import('esbuild');
    await esbuild.build({
      stdin: { contents: `import { runMcpServer } from ${JSON.stringify(path.resolve('src/core/mcp/server.ts'))};\nrunMcpServer({ version: 't', call: async (m) => (m === 'memory.context' ? 'ctx from fake daemon' : { items: [], skills: [] }) });`, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    const wrapper = path.join(env.root, 'jaffer');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(bundle)} "$@"\n`, { mode: 0o755 });
    const cenv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
    const res = await setupClaude(wrapper, { home, env: cenv });
    expect(res.messages.join('\n')).toMatch(/Registered the Jaffer MCP server/);
    expect(res.status.hooks).toBe(true);
    expect(res.status.mcp).toBe(true);
    const listed = execFileSync(CLAUDE_PATH!, ['mcp', 'list'], { env: cenv, encoding: 'utf8', timeout: 60_000 });
    expect(listed).toMatch(/jaffer.*(Connected|✓)/s);
    const down = await teardownClaude(home, cenv);
    expect(down.status.mcp).toBe(false);
    expect(down.status.hooks).toBe(false);
    void claudeStatus;
  }, 120_000);
});
