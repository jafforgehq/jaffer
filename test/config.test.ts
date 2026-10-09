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
    expect(DEFAULT_CONFIG.session).toEqual({ restoreScreen: true, resumeClaude: true, keepRunning: false, stayAwake: true });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { restoreScreen: false } }));
    expect(new ConfigStore(env.paths).get().session).toEqual({ restoreScreen: false, resumeClaude: true, keepRunning: false, stayAwake: true });
  });
});

describe('session.keepRunning and session.stayAwake, and the autoResume an old config may still have', () => {
  it('autoResume is gone (0.5.1): not a setting and not a default; an old file that has it loads, keeps it after a patch of another key, and nothing reads it', () => {
    expect('autoResume' in DEFAULT_CONFIG.session).toBe(false);
    // @ts-expect-error resuming by itself is not a setting any more: no code can read it from the config's type
    void DEFAULT_CONFIG.session.autoResume;
    // what a 0.5.0 left behind, with resuming by itself on
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { restoreScreen: false, autoResume: true } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session).toMatchObject({ restoreScreen: false, resumeClaude: true, keepRunning: false, stayAwake: true });
    store.patch({ session: { stayAwake: false } });
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.session).toEqual({ restoreScreen: false, resumeClaude: true, keepRunning: false, stayAwake: false, autoResume: true }); // kept as it was, like any key a config does not know
    expect(new ConfigStore(env.paths).get().session.stayAwake).toBe(false);
  });

  it('keepRunning and stayAwake are off and on by default, also for a config file saved before they existed, and a choice is kept', () => {
    expect(DEFAULT_CONFIG.session.keepRunning).toBe(false);
    expect(DEFAULT_CONFIG.session.stayAwake).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { restoreScreen: false, resumeClaude: false } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session).toMatchObject({ keepRunning: false, stayAwake: true });
    store.patch({ session: { keepRunning: true, stayAwake: false } });
    expect(new ConfigStore(env.paths).get().session).toMatchObject({ keepRunning: true, stayAwake: false });
  });

  it('keep the default when the saved value is not a boolean (the switch stays a switch)', () => {
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { keepRunning: 1, stayAwake: null } }));
    expect(new ConfigStore(env.paths).get().session).toMatchObject({ keepRunning: false, stayAwake: true });
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


describe('a config file or patch with values of the wrong kind', () => {
  const load = (raw: unknown) => {
    fs.writeFileSync(env.paths.config, JSON.stringify(raw));
    return new ConfigStore(env.paths);
  };

  it('loads, with the default for what does not fit: a section that is not an object, a switch that is not a boolean, a list that is not a list of text', () => {
    const cfg = load({ session: null, safety: 'oops', notifications: 5, appearance: { pet: 'off', fontSize: '13' }, shell: { args: [1, 2] } }).get();
    expect(cfg.session).toEqual(DEFAULT_CONFIG.session);
    expect(cfg.safety).toEqual(DEFAULT_CONFIG.safety);
    expect(cfg.notifications).toEqual({ claudeFinished: true });
    expect(cfg.appearance.pet).toBe(true);
    expect(cfg.appearance.fontSize).toBe(13);
    expect(cfg.shell.args).toEqual([]);
  });

  it('keeps the default branch list when the saved one is a string ("main,prod" is what `jaffer config set` stores) or has anything but text in it', () => {
    expect(load({ safety: { protectedBranches: 'main,prod' } }).get().safety.protectedBranches).toEqual(DEFAULT_CONFIG.safety.protectedBranches);
    expect(load({ safety: { protectedBranches: ['wip', 3, null] } }).get().safety.protectedBranches).toEqual(DEFAULT_CONFIG.safety.protectedBranches);
    expect(load({ safety: { protectedBranches: ['wip', 'dev/*'] } }).get().safety.protectedBranches).toEqual(['wip', 'dev/*']);
  });

  it('refuses a patch of the wrong kind and keeps what was there, on disk too', () => {
    const store = load({});
    store.patch({ safety: { protectedBranches: ['wip'] } });
    store.patch({ safety: { protectedBranches: 'main,prod' as never }, session: { restoreScreen: 'off' as never } });
    expect(store.get().safety.protectedBranches).toEqual(['wip']);
    expect(store.get().session.restoreScreen).toBe(true);
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.safety.protectedBranches).toEqual(['wip']);
    expect(saved.session.restoreScreen).toBe(true);
    store.patch({ session: { restoreScreen: false } }); // a value of the right kind still goes through
    expect(store.get().session.restoreScreen).toBe(false);
  });

  it('keeps keys it does not know (a newer version wrote them) and bounds the branch list', () => {
    const store = load({ future: { x: 1 }, safety: { protectedBranches: Array.from({ length: 500 }, (_, i) => `b${i}`.padEnd(400, 'x')) } });
    expect((store.get() as any).future).toEqual({ x: 1 });
    expect(store.get().safety.protectedBranches).toHaveLength(100);
    expect(store.get().safety.protectedBranches.every((b) => b.length <= 200)).toBe(true);
  });
});
