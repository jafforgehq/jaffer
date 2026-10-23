import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { ensureDaemon, tryConnect, type Launcher } from '../src/core/daemon-client';
import type { RpcClient } from '../src/core/rpc';
import { sleep } from '../src/shared/util';

/** (voice) `claude.reply` on the built daemon: gated per call by permissions.voice, prose of the last answer only. */
const root = path.resolve(__dirname, '..');
let env: TestEnv;
let launcher: Launcher;
let c: RpcClient;
const ID = '00000001-1111-4222-8333-444455556666';

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only=daemon'], { stdio: 'ignore' });
  env = makeEnv();
  launcher = {
    execPath: process.execPath,
    daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
    cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
    env: { HOME: env.userHome, SHELL: '/bin/bash', PS1: '$ ', CLAUDE_CONFIG_DIR: path.join(env.userHome, '.claude'), DISABLE_AUTOUPDATER: '1' },
  };
  c = await ensureDaemon(env.paths, launcher);
}, 60_000);

afterAll(async () => {
  c?.close();
  const k = await tryConnect(env.paths);
  await k?.call('app.shutdown', {}).catch(() => undefined);
  await sleep(300);
  env.cleanup();
});

describe('claude.reply', () => {
  it('off -> off; unknown session -> no-reply; on -> the prose of the last answer, never tool use or thinking', async () => {
    const dir = path.join(env.userHome, '.claude', 'projects', '-w');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ID}.jsonl`);
    const line = (o: object) => JSON.stringify(o);
    fs.writeFileSync(file, [
      line({ type: 'user', message: { role: 'user', content: 'fix SECRET-PROMPT' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET-THINK' }, { type: 'text', text: 'I fixed the build.' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'SECRET-TOOL' } }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET-RESULT' }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Run the tests next.' }] } }),
    ].join('\n') + '\n');
    for (const hook_event_name of ['UserPromptSubmit', 'Stop']) await c.call('claude.event', { session_id: ID, hook_event_name, transcript_path: file, cwd: '/w' });
    expect(await c.call('claude.reply', { session: ID })).toEqual({ ok: false, reason: 'off' });
    expect(await c.call('claude.reply', {})).toEqual({ ok: false, reason: 'off' });
    await c.call('config.patch', { permissions: { voice: true } });
    try {
      expect(await c.call('claude.reply', { session: 'nope' })).toEqual({ ok: false, reason: 'no-reply' });
      expect(await c.call('claude.reply', { session: 5 })).toEqual({ ok: false, reason: 'no-reply' });
      const r: any = await c.call('claude.reply', { session: ID });
      expect(r.ok).toBe(true);
      expect(r.text).toContain('I fixed the build.');
      expect(r.text).toContain('Run the tests next.');
      expect(r.text).not.toMatch(/SECRET/);
    } finally {
      await c.call('config.patch', { permissions: { voice: false } });
      await c.call('claude.event', { session_id: ID, hook_event_name: 'SessionEnd' });
    }
  });
});
