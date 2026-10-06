import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { MockAnthropic } from './helpers/mock-anthropic';
import { findClaude, installHooks } from '../src/core/integrations/claude';

/**
 * The real `claude` binary, pointed at a mock Messages API, in an isolated HOME. Proves that a genuine
 * Claude Code session (a) fires Jaffer's SessionStart hook and (b) hands the hook's output — Jaffer's memory —
 * to the model, with no involvement from us other than the settings entry `jaffer setup claude` writes.
 */
const CLAUDE = await findClaude().catch(() => null);
const root = path.resolve(__dirname, '..');

let env: TestEnv;
let mock: MockAnthropic;

beforeAll(async () => {
  if (!CLAUDE) return;
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only=cli'], { stdio: 'ignore' });
  env = makeEnv();
  mock = new MockAnthropic();
  await mock.listen();
}, 60_000);

afterAll(async () => {
  await mock?.close();
  env?.cleanup();
});

describe.skipIf(!CLAUDE)('Claude Code starts with Jaffer memory (real claude + mock API)', () => {
  it('SessionStart hook output reaches the model', async () => {
    const jhome = env.home;
    const cli = path.join(root, 'dist/cli/jaffer.cjs');
    // a jaffer launcher exactly like ~/.jaffer/bin/jaffer
    const wrapper = path.join(env.root, 'jaffer');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexport JAFFER_HOME=${JSON.stringify(jhome)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
    // teach it something, through the same CLI a user would use
    const remembered = spawnSync(wrapper, ['remember', 'The deploy script for this team is release.sh and it must never be run on Fridays', '--kind', 'convention'], { encoding: 'utf8' });
    expect(remembered.status, remembered.stderr).toBe(0);
    expect(installHooks(wrapper, env.userHome).changed).toBe(true);

    // async: the mock API lives in this process, so it must keep serving while claude runs
    const run = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const child = spawn(CLAUDE!, ['-p', 'say hello', '--output-format', 'json'], {
        cwd: env.userHome,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: env.userHome,
          CLAUDE_CONFIG_DIR: path.join(env.userHome, '.claude'),
          ANTHROPIC_BASE_URL: mock.url,
          ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const t = setTimeout(() => child.kill('SIGKILL'), 80_000);
      child.on('close', () => (clearTimeout(t), resolve({ stdout, stderr })));
    });
    const sent = JSON.stringify(mock.requests.map((r) => r.body));
    expect(mock.requests.length, `claude did not call the API. stdout=${run.stdout.slice(0, 400)} stderr=${run.stderr.slice(0, 400)}`).toBeGreaterThan(0);
    expect(sent).toContain('release.sh'); // the hook's stdout (Jaffer memory) was in the model's context
    expect(sent).toContain('Memory from Jaffer');
  }, 120_000);
});
