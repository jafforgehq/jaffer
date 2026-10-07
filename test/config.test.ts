import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { ConfigStore, DEFAULT_CONFIG } from '../src/shared/config';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  fs.mkdirSync(env.home, { recursive: true });
});
afterEach(() => env.cleanup());

describe('ConfigStore', () => {
  it('drops export targets for agents Jaffer no longer supports, keeping Claude Code', () => {
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, export: { targets: ['claude-code', 'codex', 'gemini'], claudeSkills: true } }));
    const cfg = new ConfigStore(env.paths).get();
    expect(cfg.export.targets).toEqual(['claude-code']);
    expect(cfg.export.claudeSkills).toBe(true);
    expect(cfg.onboarded).toBe(true);
  });

  it('applies the same rule on reload and when a patch brings an old value back', () => {
    const store = new ConfigStore(env.paths);
    fs.writeFileSync(env.paths.config, JSON.stringify({ export: { targets: ['codex'] } }));
    store.reload();
    expect(store.get().export.targets).toEqual([]);
    store.patch({ export: { targets: ['claude-code', 'gemini'] as never } });
    expect(store.get().export.targets).toEqual(['claude-code']);
    expect(JSON.parse(fs.readFileSync(env.paths.config, 'utf8')).export.targets).toEqual(['claude-code']);
  });
});

describe('appearance.animations', () => {
  it('is on by default, also for a config file saved before the setting existed', () => {
    expect(DEFAULT_CONFIG.appearance.animations).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { theme: 'jaffer-light' } }));
    const cfg = new ConfigStore(env.paths).get();
    expect(cfg.appearance.theme).toBe('jaffer-light');
    expect(cfg.appearance.animations).toBe(true);
  });

  it('can be switched off and stays off', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ appearance: { animations: false } });
    expect(new ConfigStore(env.paths).get().appearance.animations).toBe(false);
  });
});
