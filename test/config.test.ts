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

describe('session.restoreScreen, gone in 0.6.0', () => {
  it('is not a setting and not a default; an old file that has it loads, changes nothing, and keeps the key as it was after a patch of another key', () => {
    expect('restoreScreen' in DEFAULT_CONFIG.session).toBe(false);
    // @ts-expect-error the screen is no longer saved: no code can read the switch from the config's type
    void DEFAULT_CONFIG.session.restoreScreen;
    // what 0.5.x left behind: the screen switched off, and another choice beside it
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { restoreScreen: false, stayAwake: false } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().onboarded).toBe(true);
    expect(store.get().session).toMatchObject({ keepRunning: false, stayAwake: false });
    store.patch({ appearance: { fontSize: 15 } });
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.session).toEqual({ restoreScreen: false, keepRunning: false, stayAwake: false }); // kept as it was, like any key a config does not know
    expect(new ConfigStore(env.paths).get().appearance.fontSize).toBe(15);
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

describe('session.resumeClaude, gone in 0.6.0', () => {
  it('is not a setting and not a default; an old file that has it loads, changes nothing, and keeps the key as it was after a patch of another key', () => {
    expect(DEFAULT_CONFIG.session).toEqual({ keepRunning: false, stayAwake: true });
    // @ts-expect-error there is no Resume button any more: no code can read the switch from the config's type
    void DEFAULT_CONFIG.session.resumeClaude;
    // what 0.5.x left behind: the offer switched off, and another choice beside it
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { resumeClaude: false, stayAwake: false } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session).toMatchObject({ keepRunning: false, stayAwake: false });
    store.patch({ appearance: { fontSize: 15 } });
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.session).toEqual({ resumeClaude: false, keepRunning: false, stayAwake: false }); // kept as it was, like any key a config does not know
  });
});

describe('session.keepRunning and session.stayAwake, and the autoResume an old config may still have', () => {
  it('autoResume is gone (0.5.1): not a setting and not a default; an old file that has it loads, keeps it after a patch of another key, and nothing reads it', () => {
    expect('autoResume' in DEFAULT_CONFIG.session).toBe(false);
    // @ts-expect-error resuming by itself is not a setting any more: no code can read it from the config's type
    void DEFAULT_CONFIG.session.autoResume;
    // what a 0.5.0 left behind, with resuming by itself on
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { resumeClaude: false, autoResume: true } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session).toMatchObject({ resumeClaude: false, keepRunning: false, stayAwake: true });
    store.patch({ session: { stayAwake: false } });
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.session).toEqual({ resumeClaude: false, keepRunning: false, stayAwake: false, autoResume: true }); // kept as it was, like any key a config does not know
    expect(new ConfigStore(env.paths).get().session.stayAwake).toBe(false);
  });

  it('keepRunning and stayAwake are off and on by default, also for a config file saved before they existed, and a choice is kept', () => {
    expect(DEFAULT_CONFIG.session.keepRunning).toBe(false);
    expect(DEFAULT_CONFIG.session.stayAwake).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { resumeClaude: false } }));
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
    const cfg = load({ session: null, updates: 'oops', notifications: 5, appearance: { pet: 'off', fontSize: '13' }, shell: { args: [1, 2] } }).get();
    expect(cfg.session).toEqual(DEFAULT_CONFIG.session);
    expect(cfg.updates).toEqual(DEFAULT_CONFIG.updates);
    expect(cfg.notifications).toEqual({ claudeFinished: true });
    expect(cfg.appearance.pet).toBe(true);
    expect(cfg.appearance.fontSize).toBe(13);
    expect(cfg.shell.args).toEqual([]);
  });

  it('keeps the default list when the saved one is a string ("-l,-i" is what `jaffer config set` stores) or has anything but text in it', () => {
    expect(load({ shell: { args: '-l,-i' } }).get().shell.args).toEqual(DEFAULT_CONFIG.shell.args);
    expect(load({ shell: { args: ['-l', 3, null] } }).get().shell.args).toEqual(DEFAULT_CONFIG.shell.args);
    expect(load({ shell: { args: ['-l', '-i'] } }).get().shell.args).toEqual(['-l', '-i']);
  });

  it('refuses a patch of the wrong kind and keeps what was there, on disk too', () => {
    const store = load({});
    store.patch({ shell: { args: ['-l'] } });
    store.patch({ shell: { args: '-l,-i' as never }, session: { stayAwake: 'off' as never } });
    expect(store.get().shell.args).toEqual(['-l']);
    expect(store.get().session.stayAwake).toBe(true);
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.shell.args).toEqual(['-l']);
    expect(saved.session.stayAwake).toBe(true);
    store.patch({ session: { stayAwake: false } }); // a value of the right kind still goes through
    expect(store.get().session.stayAwake).toBe(false);
  });

  it('keeps keys it does not know (a newer version wrote them)', () => {
    const store = load({ future: { x: 1 } });
    expect((store.get() as any).future).toEqual({ x: 1 });
    store.patch({ session: { stayAwake: false } });
    expect(JSON.parse(fs.readFileSync(env.paths.config, 'utf8')).future).toEqual({ x: 1 });
  });

  it('an old config with a safety section (0.5.x: the title-bar tint and its branch list) loads: the key is kept as it was, nothing reads it any more', () => {
    expect('safety' in DEFAULT_CONFIG).toBe(false);
    // @ts-expect-error the title bar is not tinted any more: no code can read a safety section from the config's type
    void DEFAULT_CONFIG.safety;
    const old = { dangerTint: false, protectedBranches: ['staging', 'release/*'] };
    const store = load({ onboarded: true, safety: old });
    expect(store.get().onboarded).toBe(true);
    expect((store.get() as any).safety).toEqual(old);
    expect(load({ safety: 'oops' }).get().session).toEqual(DEFAULT_CONFIG.session); // even a section of the wrong kind does not stop it loading
    store.patch({ session: { stayAwake: false } });
    expect(JSON.parse(fs.readFileSync(env.paths.config, 'utf8')).safety).toEqual(old); // left as it was by a patch of another key
  });

  it('an old config with memory, ingest and export sections (0.5.x: the memory) loads: the keys are kept as they were, nothing reads them any more', () => {
    for (const key of ['memory', 'ingest', 'export']) expect(key in DEFAULT_CONFIG, key).toBe(false);
    // @ts-expect-error there is no memory: no code can read its sections from the config's type
    void DEFAULT_CONFIG.memory;
    const old = { memory: { enabled: true, llm: 'auto', retentionDays: 45 }, ingest: { claudeCode: true, backfillDays: 7 }, export: { targets: ['claude-code', 'codex'], claudeSkills: true } };
    const store = load({ onboarded: true, ...old });
    expect(store.get().onboarded).toBe(true);
    expect(store.get()).toMatchObject(old); // as they were: an old list of targets is not filtered any more either
    expect(load({ memory: 'oops', ingest: null, export: [] }).get().session).toEqual(DEFAULT_CONFIG.session); // even sections of the wrong kind do not stop it loading
    store.patch({ session: { stayAwake: false } });
    expect(JSON.parse(fs.readFileSync(env.paths.config, 'utf8'))).toMatchObject(old); // left as they were by a patch of another key
  });
});
