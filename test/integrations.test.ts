import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEngine, makeEnv, type TestEnv } from './helpers/env';
import { makeMemoryApi } from '../src/core/memory-api';
import { runMcpServer } from '../src/core/mcp/server';
import { claudeStatus, findClaude, hooksConnected, hooksInstalled, installHooks, removeHooks, setupClaude, teardownClaude } from '../src/core/integrations/claude';
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

  const ALL_EVENTS: [string, string][] = [
    ['SessionStart', 'session-start'],
    ['Stop', 'stop'],
    ['UserPromptSubmit', 'user-prompt-submit'],
    ['PreToolUse', 'pre-tool-use'],
    ['PostToolUse', 'post-tool-use'],
    ['PostToolUseFailure', 'post-tool-use-failure'],
    ['SubagentStart', 'subagent-start'],
    ['SubagentStop', 'subagent-stop'],
    ['Notification', 'notification'],
    ['SessionEnd', 'session-end'],
  ];
  const settingsFile = () => path.join(env.userHome, '.claude', 'settings.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  const oldTwoHooks = (cli: string) => ({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `'${cli}' hook session-start # jaffer-managed`, timeout: 8 }] }], Stop: [{ hooks: [{ type: 'command', command: `'${cli}' hook stop # jaffer-managed`, timeout: 5 }] }] } });

  it('registers every event the companion needs, async for the new ones, keeping the user\'s own hooks', () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } }));
    expect(installHooks('/x/jaffer', env.userHome).changed).toBe(true);
    const s = readSettings();
    for (const [event, arg] of ALL_EVENTS) {
      const ours = (s.hooks[event] as any[]).filter((e) => e.hooks.some((h: any) => String(h.command).includes('# jaffer-managed')));
      expect(ours, event).toHaveLength(1);
      const hook = ours[0].hooks[0];
      expect(hook.command, event).toContain(`'/x/jaffer' hook ${arg} #`);
      if (event === 'SessionStart' || event === 'Stop') expect(hook.async, event).toBeUndefined(); // they feed memory: Claude Code waits for them
      else expect(hook.async, event).toBe(true); // everything else must never slow Claude Code down
    }
    expect(s.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [mine] });
    expect(installHooks('/x/jaffer', env.userHome).changed).toBe(false);
    expect(removeHooks(env.userHome).changed).toBe(true);
    expect(readSettings()).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } });
  });

  it('an install with only SessionStart and Stop gets the new events, and hooksInstalled turns true', () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(oldTwoHooks('/x/jaffer')));
    expect(hooksInstalled(env.userHome)).toBe(false); // the new events are missing
    expect(installHooks('/x/jaffer', env.userHome).changed).toBe(true);
    expect(hooksInstalled(env.userHome)).toBe(true);
    expect(Object.keys(readSettings().hooks).sort()).toEqual(ALL_EVENTS.map(([e]) => e).sort());
  });

  it('hooksConnected is true for an old two-hook install, and false for none or for the user\'s own hooks only', () => {
    expect(hooksConnected(env.userHome)).toBe(false); // no settings file
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    expect(hooksConnected(env.userHome)).toBe(false);
    fs.writeFileSync(settingsFile(), JSON.stringify(oldTwoHooks('/x/jaffer')));
    expect(hooksConnected(env.userHome)).toBe(true);
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
describe('findClaude', () => {
  it('picks the first claude on PATH, the one the user\'s own shell would run', async () => {
    const mk = (name: string) => {
      const dir = path.join(env.root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return dir;
    };
    const first = mk('first');
    const second = mk('second');
    expect(await findClaude({ HOME: env.userHome, PATH: `${first}:${second}` })).toBe(path.join(first, 'claude'));
    expect(await findClaude({ HOME: env.userHome, PATH: `${second}:${first}` })).toBe(path.join(second, 'claude'));
  });
});

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

// Memory curation through the user's own Claude Code login (no API key needed).
describe.skipIf(!CLAUDE_PATH)('ClaudeCliLlm (real claude -p against a mock API)', () => {
  it('returns the model text, sends the system+user prompt, and leaves no session files behind', async () => {
    const { MockAnthropic } = await import('./helpers/mock-anthropic');
    const { ClaudeCliLlm } = await import('../src/core/agent/claude-cli');
    const mock = new MockAnthropic();
    const url = await mock.listen();
    // Claude Code sends a couple of small preliminary requests first; answer everything with the same JSON
    for (let i = 0; i < 6; i++) mock.queue({ kind: 'text', text: '{"ops":[]}' });
    const home = env.userHome;
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const llm = new ClaudeCliLlm(CLAUDE_PATH!, { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' });
    const out = await llm.complete({ system: 'You are the curator. Reply with JSON only.', user: 'Digest: user ran pnpm test five times.' });
    expect(out).toContain('"ops"');
    const sent = JSON.stringify(mock.requests.map((r) => r.body));
    expect(sent).toContain('You are the curator');
    expect(sent).toContain('pnpm test five times');
    // nothing for transcript ingestion to pick up
    const projects = path.join(home, '.claude', 'projects');
    const files = fs.existsSync(projects) ? fs.readdirSync(projects, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')) : [];
    expect(files).toHaveLength(0);
    await mock.close();
  }, 90_000);
});
