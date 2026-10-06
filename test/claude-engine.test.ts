import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEngine, makeEnv, type TestEnv } from './helpers/env';
import { MockAnthropic } from './helpers/mock-anthropic';
import { ClaudeCodeEngine, normalizeClaudeTool } from '../src/core/agent/claude-engine';
import { findClaude } from '../src/core/integrations/claude';
import type { AgentEvent } from '../src/core/agent/types';
import { sleep } from '../src/shared/util';

/**
 * The agent panel running on a Claude Code login: the real `claude` binary, driven through its streaming protocol, against
 * a mock Messages API. Proves that Jaffer (not Claude Code's defaults) decides what may run, that the conversation is one
 * continuous session across restarts, and that cancelling really stops it.
 */
const CLAUDE = await findClaude().catch(() => null);

let env: TestEnv;
let mock: MockAnthropic;
let work: string;

function claudeEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) if (/^(CCR_|CLAUDE_CODE_|CLAUDECODE)/.test(k)) delete e[k];
  return {
    ...e,
    HOME: env.userHome,
    CLAUDE_CONFIG_DIR: path.join(env.userHome, '.claude'),
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    JAFFER_NO_HOOKS: '1',
  };
}

function makeClaude(): { engine: ClaudeCodeEngine; events: AgentEvent[] } {
  const engine = new ClaudeCodeEngine({ paths: env.paths, config: env.config, memory: makeEngine(env), terminal: () => ({ cwd: work }), claudePath: () => CLAUDE, mcp: () => null, env: claudeEnv });
  const events: AgentEvent[] = [];
  engine.events.on((e) => events.push(e));
  return { engine, events };
}

async function until(fn: () => boolean, ms = 60_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

/** Claude Code also sends small background requests; only the main one carries tools. */
const main = (b: any) => (b.tools?.length ?? 0) > 0;
const mainRequests = () => mock.requests.filter((r) => main(r.body));

beforeAll(async () => {
  if (!CLAUDE) return;
  mock = new MockAnthropic();
  await mock.listen();
}, 30_000);

afterAll(async () => {
  await mock?.close();
});

describe('normalizing Claude Code tool calls', () => {
  it('maps its tools onto the ones Jaffer shows and judges', () => {
    expect(normalizeClaudeTool('Write', { file_path: '/a/b.ts', content: 'x' })).toEqual({ name: 'write_file', input: { path: '/a/b.ts', content: 'x' } });
    expect(normalizeClaudeTool('Edit', { file_path: '/a', old_string: 'o', new_string: 'n' }).name).toBe('edit_file');
    expect(normalizeClaudeTool('Read', { file_path: '/a' }).input.path).toBe('/a');
    expect(normalizeClaudeTool('Bash', { command: 'ls' })).toEqual({ name: 'run_command', input: { command: 'ls', timeout_seconds: undefined } });
    expect(normalizeClaudeTool('mcp__jaffer-session__run_command', { command: 'pwd' })).toEqual({ name: 'run_command', input: { command: 'pwd' } });
    expect(normalizeClaudeTool('WebFetch', { url: 'https://x' }).name).toBe('WebFetch');
  });
});

describe.skipIf(!CLAUDE)('ClaudeCodeEngine (real claude + mock API)', () => {
  const engines: ClaudeCodeEngine[] = [];

  beforeAll(() => {
    env = makeEnv();
    work = path.join(env.userHome, 'proj');
    fs.mkdirSync(work, { recursive: true });
  });

  afterAll(async () => {
    await Promise.all(engines.map((e) => e.dispose())); // Claude Code writes into HOME until it exits
    env?.cleanup();
  });

  const start = () => {
    const c = makeClaude();
    engines.push(c.engine);
    return c;
  };
  const ended = (events: AgentEvent[], turnId: string) => events.some((e) => e.type === 'turn_end' && e.turnId === turnId);

  it('answers a message: streams text, reports usage, keeps the conversation', async () => {
    const { engine, events } = start();
    mock.reset().queue({ kind: 'text', text: 'Hello from Claude', when: main });
    const { turnId } = engine.send('hi there');
    await until(() => ended(events, turnId), 60_000, 'the first turn');
    const end = events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
    expect(end.error).toBeUndefined();
    expect(end.stopReason).toBe('end_turn');
    expect(events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Hello from Claude');
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    expect(engine.thread.items().map((i) => (i.kind === 'tool' ? 'tool' : `${i.kind}:${i.text}`))).toEqual(['user:hi there', 'assistant:Hello from Claude']);
    expect(JSON.parse(fs.readFileSync(env.paths.cliThread, 'utf8'))).toHaveLength(2); // saved for the next app launch
    expect(engine.status()).toMatchObject({ ready: true, engine: 'claude-code', busy: false });
    // the model was told where the user is
    expect(JSON.stringify(mainRequests().at(-1)!.body.messages)).toContain(`cwd: ${work}`);
  }, 90_000);

  it('asks Jaffer before writing a file, shows what it will do, and obeys Allow', async () => {
    const { engine, events } = start();
    const target = path.join(work, 'allowed.txt');
    mock.reset().queue({ kind: 'tool', id: 'toolu_w1', name: 'Write', input: { file_path: target, content: 'written by claude' }, when: main }, { kind: 'text', text: 'File written.', when: main });
    const { turnId } = engine.send('please write a file');
    await until(() => events.some((e) => e.type === 'approval_request'), 60_000, 'an approval request');
    const req = events.find((e) => e.type === 'approval_request') as Extract<AgentEvent, { type: 'approval_request' }>;
    expect(req.name).toBe('write_file'); // Jaffer's name for it, so the UI and policy treat it like its own agent's
    expect((req.input as any).path).toBe(target);
    expect(fs.existsSync(target)).toBe(false); // nothing happened before the user decided
    expect(events.findIndex((e) => e.type === 'tool_call')).toBeLessThan(events.findIndex((e) => e.type === 'approval_request'));
    expect(engine.status().pendingApprovals).toHaveLength(1);
    expect(engine.approve(req.callId, 'allow')).toBe(true);
    await until(() => ended(events, turnId), 60_000, 'the turn to finish');
    expect(fs.readFileSync(target, 'utf8')).toBe('written by claude');
    const result = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.isError).toBe(false);
    const row = engine.thread.items().find((i) => i.kind === 'tool')!;
    expect(row).toMatchObject({ kind: 'tool', name: 'write_file' });
    expect((row as { output?: string }).output).toBeTruthy();
  }, 90_000);

  it('honours Deny: nothing is written and Claude is told not to retry', async () => {
    const { engine, events } = start();
    const target = path.join(work, 'denied.txt');
    mock.reset().queue({ kind: 'tool', id: 'toolu_d1', name: 'Write', input: { file_path: target, content: 'nope' }, when: main }, { kind: 'text', text: 'Understood, I will not write it.', when: main });
    const { turnId } = engine.send('write denied.txt');
    await until(() => events.some((e) => e.type === 'approval_request'), 60_000, 'an approval request');
    engine.approve((events.find((e) => e.type === 'approval_request') as any).callId, 'deny');
    await until(() => ended(events, turnId), 60_000, 'the turn to finish');
    expect(fs.existsSync(target)).toBe(false);
    expect(JSON.stringify(mainRequests().at(-1)!.body.messages)).toContain('declined');
  }, 90_000);

  it('reads files without asking', async () => {
    const { engine, events } = start();
    const file = path.join(work, 'notes.txt');
    fs.writeFileSync(file, 'the secret ingredient is cardamom\n');
    mock.reset().queue({ kind: 'tool', id: 'toolu_r1', name: 'Read', input: { file_path: file }, when: main }, { kind: 'text', text: 'It is cardamom.', when: main });
    const { turnId } = engine.send('what is in notes.txt?');
    await until(() => ended(events, turnId), 60_000, 'the turn to finish');
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
    const result = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.output).toContain('cardamom');
  }, 90_000);

  it('is one continuous session: the same conversation survives a restart of Jaffer', async () => {
    const first = start();
    mock.reset().queue({ kind: 'text', text: 'Noted: teal.', when: main });
    const t1 = first.engine.send('my favourite colour is teal');
    await until(() => ended(first.events, t1.turnId), 60_000, 'the first turn');
    await first.engine.dispose(); // the daemon goes away; so does its Claude Code process

    const second = start(); // a fresh daemon: new engine, same files on disk
    expect(second.engine.thread.items().some((i) => i.kind === 'user' && i.text.includes('teal'))).toBe(true); // the panel shows it again
    mock.reset().queue({ kind: 'text', text: 'You told me teal.', when: main });
    const t2 = second.engine.send('what is my favourite colour?');
    await until(() => ended(second.events, t2.turnId), 60_000, 'the second turn');
    const end = second.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
    expect(end.error).toBeUndefined();
    expect(JSON.stringify(mainRequests().at(-1)!.body.messages)).toContain('my favourite colour is teal'); // Claude still had the earlier turn
  }, 150_000);

  it('cancelling stops the work: a pending approval is denied and the turn ends as cancelled', async () => {
    const { engine, events } = start();
    const target = path.join(work, 'cancelled.txt');
    mock.reset().queue({ kind: 'tool', id: 'toolu_c1', name: 'Write', input: { file_path: target, content: 'x' }, when: main }, { kind: 'text', text: 'ok', when: main });
    const { turnId } = engine.send('write cancelled.txt');
    await until(() => events.some((e) => e.type === 'approval_request'), 60_000, 'an approval request');
    engine.cancel();
    await until(() => ended(events, turnId), 30_000, 'the turn to end');
    const end = events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
    expect(end.stopReason).toBe('cancelled');
    expect(end.error).toBeUndefined();
    expect(fs.existsSync(target)).toBe(false);
    expect(engine.busy).toBe(false);
  }, 90_000);
});
