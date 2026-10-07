import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCliLlm } from '../src/core/agent/claude-cli';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let saved: string | undefined;
beforeEach(() => {
  env = makeEnv();
  saved = process.env.JAFFER_KEEP_ANTHROPIC_ENV;
  delete process.env.JAFFER_KEEP_ANTHROPIC_ENV;
});
afterEach(() => {
  if (saved === undefined) delete process.env.JAFFER_KEEP_ANTHROPIC_ENV;
  else process.env.JAFFER_KEEP_ANTHROPIC_ENV = saved;
  env.cleanup();
});

/** A `claude` that records which variables it was started with, and answers. */
function recorder(): { bin: string; seen: () => Record<string, string> } {
  const bin = path.join(env.root, 'claude');
  const out = path.join(env.root, 'env.txt');
  fs.writeFileSync(bin, `#!/bin/sh\nenv > ${JSON.stringify(out)}\ncat > /dev/null\necho '{"ops":[]}'\n`, { mode: 0o755 });
  return {
    bin,
    seen: () => Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
  };
}

describe('ClaudeCliLlm and the account it runs on', () => {
  it('runs on the person’s Claude login: an API key or token in its environment is not passed on, whoever built that environment', async () => {
    const r = recorder();
    const llm = new ClaudeCliLlm(r.bin, { PATH: process.env.PATH, HOME: env.userHome, ANTHROPIC_API_KEY: 'sk-ant-api03-notforyou', ANTHROPIC_AUTH_TOKEN: 'token-notforyou', SOME_OTHER: 'kept' });
    expect(await llm.complete({ system: 's', user: 'u' })).toContain('ops');
    const seen = r.seen();
    expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen.SOME_OTHER).toBe('kept');
    expect(seen.JAFFER_NO_HOOKS).toBe('1'); // and Jaffer's own hooks do not run inside it
    expect(seen.DISABLE_TELEMETRY).toBe('1');
  });

  it('keeps them only when told to (the tests that point it at a mock API)', async () => {
    process.env.JAFFER_KEEP_ANTHROPIC_ENV = '1';
    const r = recorder();
    await new ClaudeCliLlm(r.bin, { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-test-0000' }).complete({ system: 's', user: 'u' });
    expect(r.seen().ANTHROPIC_API_KEY).toBe('sk-ant-test-0000');
  });

  it('runs in a folder of its own that is gone afterwards', async () => {
    const r = recorder();
    await new ClaudeCliLlm(r.bin, { PATH: process.env.PATH }).complete({ system: 's', user: 'u' });
    expect(r.seen().PWD).toMatch(/jaffer-curate-/);
    expect(fs.existsSync(r.seen().PWD!)).toBe(false);
  });

  it('reports a failure with what it said, shortened', async () => {
    const bin = path.join(env.root, 'claude-broken');
    fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho "${'oops '.repeat(200)}" >&2\nexit 3\n`, { mode: 0o755 });
    const err = await new ClaudeCliLlm(bin, { PATH: process.env.PATH }).complete({ system: 's', user: 'u' }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited 3: oops/);
    expect((err as Error).message.length).toBeLessThan(400);
  });
});
