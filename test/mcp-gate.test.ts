import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpGate } from '../src/shared/mcp-gate';
import { mcpGateFor } from '../src/core/claude/setup';
import { makeEnv, type TestEnv } from './helpers/env';

describe('mcpGate (1.4.1): do a folder\'s own settings pre-approve its .mcp.json servers?', () => {
  const on = (v: object) => JSON.stringify(v);
  it('no .mcp.json: never gated, whatever the settings say', () => {
    expect(mcpGate([on({ enableAllProjectMcpServers: true })], false)).toBe(false);
    expect(mcpGate([null], false)).toBe(false);
  });
  it('enableAllProjectMcpServers truthy or a non-empty enabledMcpjsonServers list gates; false, empty, a wrong kind or absent files do not', () => {
    expect(mcpGate([on({ enableAllProjectMcpServers: true })], true)).toBe(true);
    expect(mcpGate([undefined, on({ enabledMcpjsonServers: ['x'] })], true)).toBe(true);
    expect(mcpGate([on({ enableAllProjectMcpServers: false, enabledMcpjsonServers: [] })], true)).toBe(false);
    expect(mcpGate([on({ enabledMcpjsonServers: 'x' }), on({ hooks: {} }), on([])], true)).toBe(false);
    expect(mcpGate([undefined, undefined], true)).toBe(false);
    expect(mcpGate([], true)).toBe(false);
  });
  it('malformed JSON is ignored (Claude Code ignores invalid settings too); a file that could not be read (null) is a doubt and gates', () => {
    expect(mcpGate(['{"enableAllProjectMcpServers": tru', 'not json', ''], true)).toBe(false);
    expect(mcpGate(['not json', null], true)).toBe(true);
  });
});

describe('mcpGateFor (1.4.1): the folder\'s files, read bounded and confined', () => {
  let env: TestEnv;
  let proj: string;
  beforeEach(() => {
    env = makeEnv();
    proj = path.join(env.userHome, 'p');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  });
  afterEach(() => env.cleanup());
  const w = (rel: string, s: string) => fs.writeFileSync(path.join(proj, rel), s);

  it('.mcp.json plus a pre-approving settings.json or settings.local.json gates; either alone does not', async () => {
    expect(await mcpGateFor(proj)).toBe(false);
    w('.claude/settings.json', '{"enableAllProjectMcpServers":true}');
    expect(await mcpGateFor(proj)).toBe(false); // (no .mcp.json)
    w('.mcp.json', '{"mcpServers":{}}');
    expect(await mcpGateFor(proj)).toBe(true);
    fs.rmSync(path.join(proj, '.claude/settings.json'));
    expect(await mcpGateFor(proj)).toBe(false);
    w('.claude/settings.local.json', '{"enabledMcpjsonServers":["a"]}');
    expect(await mcpGateFor(proj)).toBe(true);
  });
  it('doubt gates: a settings file over 256 KB, a link out of the folder, a folder in its place', async () => {
    w('.mcp.json', '{}');
    w('.claude/settings.json', ' '.repeat(300 * 1024) + '{"enableAllProjectMcpServers":false}');
    expect(await mcpGateFor(proj)).toBe(true);
    fs.rmSync(path.join(proj, '.claude/settings.json'));
    fs.writeFileSync(path.join(env.root, 'outside.json'), '{}');
    fs.symlinkSync(path.join(env.root, 'outside.json'), path.join(proj, '.claude/settings.json'));
    expect(await mcpGateFor(proj)).toBe(true);
    fs.rmSync(path.join(proj, '.claude/settings.json'));
    fs.mkdirSync(path.join(proj, '.claude/settings.json'));
    expect(await mcpGateFor(proj)).toBe(true);
  });
  it('a malformed settings file is ignored', async () => {
    w('.mcp.json', '{}');
    w('.claude/settings.json', '{"enableAllProjectMcpServers": tru');
    expect(await mcpGateFor(proj)).toBe(false);
  });
});
