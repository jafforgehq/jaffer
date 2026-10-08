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

  it('applies the same rule when the file is read and when a patch brings an old value back', () => {
    fs.writeFileSync(env.paths.config, JSON.stringify({ export: { targets: ['codex'] } }));
    const store = new ConfigStore(env.paths);
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

describe('appearance.pet', () => {
  it('is on by default, also for a config file saved before the pet existed', () => {
    expect(DEFAULT_CONFIG.appearance.pet).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { theme: 'jaffer-light' } }));
    expect(new ConfigStore(env.paths).get().appearance.pet).toBe(true);
  });
});

describe('claude.skipped', () => {
  it('is off by default (Claude is offered, not assumed), also for a config file saved before the setting existed', () => {
    expect(DEFAULT_CONFIG.claude.skipped).toBe(false);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    expect(new ConfigStore(env.paths).get().claude.skipped).toBe(false);
  });
});

describe('updates.auto', () => {
  it('is on by default, also for a config file saved before the setting existed', () => {
    expect(DEFAULT_CONFIG.updates.auto).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    expect(new ConfigStore(env.paths).get().updates.auto).toBe(true);
  });

  it('can be switched off and stays off', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ updates: { auto: false } });
    expect(new ConfigStore(env.paths).get().updates.auto).toBe(false);
  });
});

describe('claude.showCost', () => {
  it('is on by default, also for a config file saved before the setting existed', () => {
    expect(DEFAULT_CONFIG.claude.showCost).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, claude: { skipped: true } }));
    expect(new ConfigStore(env.paths).get().claude).toEqual({ skipped: true, showCost: true });
  });

  it('can be switched off and stays off, without touching the rest of claude', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ claude: { skipped: true } });
    store.patch({ claude: { showCost: false } });
    expect(new ConfigStore(env.paths).get().claude).toEqual({ skipped: true, showCost: false });
  });
});

describe('session.restoreScreen', () => {
  it('is on by default, also for a config file saved before the setting existed, and can be switched off and stays off', () => {
    expect(DEFAULT_CONFIG.session.restoreScreen).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session.restoreScreen).toBe(true);
    store.patch({ session: { restoreScreen: false } });
    expect(new ConfigStore(env.paths).get().session.restoreScreen).toBe(false);
  });
});

describe('safety', () => {
  it('marks risky places by default (main, master, production, prod, release/*), also for a config file saved before the setting existed', () => {
    expect(DEFAULT_CONFIG.safety).toEqual({ dangerTint: true, protectedBranches: ['main', 'master', 'production', 'prod', 'release/*'] });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    expect(new ConfigStore(env.paths).get().safety.dangerTint).toBe(true);
    expect(new ConfigStore(env.paths).get().safety.protectedBranches).toContain('production');
  });

  it('keeps the list a person set, whole (it replaces the default, it is not added to it), and the switch independently', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ safety: { protectedBranches: ['staging'] } });
    store.patch({ safety: { dangerTint: false } });
    const again = new ConfigStore(env.paths).get().safety;
    expect(again).toEqual({ dangerTint: false, protectedBranches: ['staging'] });
    store.patch({ safety: { protectedBranches: [] } });
    expect(new ConfigStore(env.paths).get().safety.protectedBranches).toEqual([]);
  });

  it('never shares the default list: changing one config does not change another', () => {
    const a = new ConfigStore(env.paths).get().safety.protectedBranches;
    a.push('mutated');
    expect(DEFAULT_CONFIG.safety.protectedBranches).not.toContain('mutated');
  });
});

describe('notifications.claudeFinished', () => {
  it('is on by default, also for a config file saved before the setting existed, and can be switched off and stays off', () => {
    expect(DEFAULT_CONFIG.notifications.claudeFinished).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    const store = new ConfigStore(env.paths);
    expect(store.get().notifications.claudeFinished).toBe(true);
    store.patch({ notifications: { claudeFinished: false } });
    expect(new ConfigStore(env.paths).get().notifications.claudeFinished).toBe(false);
  });
});

describe('session.resumeClaude', () => {
  it('is on by default, also for a config file saved before the setting existed (and the screen setting beside it is untouched)', () => {
    expect(DEFAULT_CONFIG.session).toEqual({ restoreScreen: true, resumeClaude: true });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { restoreScreen: false } }));
    expect(new ConfigStore(env.paths).get().session).toEqual({ restoreScreen: false, resumeClaude: true });
  });
});

describe('appearance.companion', () => {
  it('is the mole by default, also for a config file saved before companions existed, and a choice is kept', () => {
    expect(DEFAULT_CONFIG.appearance.companion).toBe('mole');
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { pet: false } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().appearance.companion).toBe('mole');
    expect(store.get().appearance.pet).toBe(false); // the old on/off switch is untouched
    store.patch({ appearance: { companion: 'matrix' } });
    expect(new ConfigStore(env.paths).get().appearance.companion).toBe('matrix');
  });
});

