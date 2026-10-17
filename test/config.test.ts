import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { ConfigStore, DEAD_KEYS, DEFAULT_CONFIG, pruneDeadKeys } from '../src/shared/config';

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

describe('updates.seenVersion', () => {
  it('is empty text by default (the window then decides what is unseen), also for a config file saved before the setting existed, and a number does not stick', () => {
    expect(DEFAULT_CONFIG.updates.seenVersion).toBe('');
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, updates: { auto: false } }));
    expect(new ConfigStore(env.paths).get().updates).toEqual({ auto: false, seenVersion: '' });
    const store = new ConfigStore(env.paths);
    store.patch({ updates: { seenVersion: '1.2.0' } });
    expect(new ConfigStore(env.paths).get().updates.seenVersion).toBe('1.2.0');
    store.patch({ updates: { seenVersion: 5 as unknown as string } });
    expect(store.get().updates.seenVersion).toBe('1.2.0');
  });
});

describe('history.names and history.pinned (1.2.0)', () => {
  const ID = '0f8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f';
  it('are empty lists by default, also for a config file saved before they existed; a list of text is kept, anything else is not', () => {
    expect(DEFAULT_CONFIG.history).toEqual({ names: [], pinned: [], tags: [], hidden: [] });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    expect(new ConfigStore(env.paths).get().history).toEqual({ names: [], pinned: [], tags: [], hidden: [] });
    const store = new ConfigStore(env.paths);
    store.patch({ history: { names: [`${ID} My name`], pinned: [ID], tags: [], hidden: [] } });
    expect(new ConfigStore(env.paths).get().history).toEqual({ names: [`${ID} My name`], pinned: [ID], tags: [], hidden: [] });
    store.patch({ history: { names: { [ID]: 'x' } as never, pinned: [5] as never } });
    expect(store.get().history).toEqual({ names: [`${ID} My name`], pinned: [ID], tags: [], hidden: [] });
    // (1.4.0) tags and hidden ids: lists of text, like the names
    store.patch({ history: { tags: [`${ID} work`], hidden: [ID] } });
    expect(new ConfigStore(env.paths).get().history).toMatchObject({ tags: [`${ID} work`], hidden: [ID] });
    store.patch({ history: { tags: 'work' as never, hidden: [{}] as never } });
    expect(store.get().history).toMatchObject({ tags: [`${ID} work`], hidden: [ID] });
  });
});

describe('claude.showCost', () => {
  it('is on by default, also for a config file saved before the setting existed', () => {
    expect(DEFAULT_CONFIG.claude.showCost).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, claude: { skipped: true } }));
    expect(new ConfigStore(env.paths).get().claude).toEqual({ ...DEFAULT_CONFIG.claude, skipped: true, showCost: true });
  });

  it('can be switched off and stays off, without touching the rest of claude', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ claude: { skipped: true } });
    store.patch({ claude: { showCost: false } });
    expect(new ConfigStore(env.paths).get().claude).toEqual({ ...DEFAULT_CONFIG.claude, skipped: true, showCost: false });
  });
});

describe('claude.liveCost, claude.dailyBudgetUsd and claude.typicalTurnMs', () => {
  it('have their defaults (live cost on, no budget, no typical turn yet), also for a config file saved before they existed', () => {
    expect(DEFAULT_CONFIG.claude).toMatchObject({ liveCost: true, dailyBudgetUsd: 0, typicalTurnMs: 0 });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, claude: { skipped: false, showCost: true } }));
    expect(new ConfigStore(env.paths).get().claude).toMatchObject({ liveCost: true, dailyBudgetUsd: 0, typicalTurnMs: 0 });
  });

  it('a choice is kept, and a value of the wrong kind leaves what was there', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ claude: { liveCost: false, dailyBudgetUsd: 5, typicalTurnMs: 42_000 } });
    expect(new ConfigStore(env.paths).get().claude).toMatchObject({ liveCost: false, dailyBudgetUsd: 5, typicalTurnMs: 42_000 });
    store.patch({ claude: { liveCost: 'yes', dailyBudgetUsd: '5', typicalTurnMs: null } as never });
    expect(new ConfigStore(env.paths).get().claude).toMatchObject({ liveCost: false, dailyBudgetUsd: 5, typicalTurnMs: 42_000 });
    fs.writeFileSync(env.paths.config, JSON.stringify({ claude: { liveCost: 1, dailyBudgetUsd: 'ten', typicalTurnMs: [] } }));
    expect(new ConfigStore(env.paths).get().claude).toMatchObject({ liveCost: true, dailyBudgetUsd: 0, typicalTurnMs: 0 });
  });
});

describe('claude.approvals (1.2.0)', () => {
  it('is off by default, also for a config file saved before it existed, and only true or false is kept', () => {
    expect(DEFAULT_CONFIG.claude.approvals).toBe(false);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, claude: { showCost: true } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().claude.approvals).toBe(false);
    store.patch({ claude: { approvals: 'yes' } } as never);
    expect(store.get().claude.approvals).toBe(false);
    store.patch({ claude: { approvals: true } });
    store.patch({ claude: { approvals: 1 } } as never);
    expect(new ConfigStore(env.paths).get().claude.approvals).toBe(true);
  });
});

describe('claude.toolStrip, claude.turnSummary, appearance.systemStats and appearance.glow', () => {
  it('have their defaults (strip, summary and glow on; system stats off), also for a config file saved before they existed', () => {
    expect(DEFAULT_CONFIG.claude).toMatchObject({ toolStrip: true, turnSummary: true });
    expect(DEFAULT_CONFIG.appearance).toMatchObject({ systemStats: false, glow: true });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, claude: { showCost: true }, appearance: { theme: 'jaffer-light' } }));
    const cfg = new ConfigStore(env.paths).get();
    expect(cfg.claude).toMatchObject({ toolStrip: true, turnSummary: true });
    expect(cfg.appearance).toMatchObject({ systemStats: false, glow: true });
  });

  it('a choice is kept, and a value of the wrong kind leaves what was there', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ claude: { toolStrip: false, turnSummary: false }, appearance: { systemStats: true, glow: false } });
    store.patch({ claude: { toolStrip: 'yes', turnSummary: 1 }, appearance: { systemStats: 'no', glow: null } } as never);
    const cfg = new ConfigStore(env.paths).get();
    expect(cfg.claude).toMatchObject({ toolStrip: false, turnSummary: false });
    expect(cfg.appearance).toMatchObject({ systemStats: true, glow: false });
  });
});

describe('appearance.seasonal', () => {
  it('is on by default, also for a config file saved before it existed; a choice is kept, a value of the wrong kind is not', () => {
    expect(DEFAULT_CONFIG.appearance.seasonal).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { theme: 'jaffer-light' } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().appearance.seasonal).toBe(true);
    store.patch({ appearance: { seasonal: false } });
    store.patch({ appearance: { seasonal: 'yes' } } as never);
    expect(new ConfigStore(env.paths).get().appearance.seasonal).toBe(false);
  });
});

describe('terminal.blocks', () => {
  it('is on by default, also for a config file saved before the terminal section existed; a choice is kept, a value of the wrong kind is not', () => {
    expect(DEFAULT_CONFIG.terminal).toEqual(TERMINAL_DEFAULTS);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    expect(new ConfigStore(env.paths).get().terminal).toEqual(TERMINAL_DEFAULTS);
    const store = new ConfigStore(env.paths);
    store.patch({ terminal: { blocks: false } });
    expect(new ConfigStore(env.paths).get().terminal.blocks).toBe(false);
    store.patch({ terminal: { blocks: 'on' } as never });
    expect(new ConfigStore(env.paths).get().terminal.blocks).toBe(false);
    fs.writeFileSync(env.paths.config, JSON.stringify({ terminal: 'blocks' }));
    expect(new ConfigStore(env.paths).get().terminal).toEqual(TERMINAL_DEFAULTS);
  });
});

const TERMINAL_DEFAULTS = { blocks: true, pasteGuard: true, ruler: 0, editorUrl: '', images: true, portLinks: true };

describe('terminal: paste guard, ruler, editor links, images, port links', () => {
  it('have their defaults, keep a choice, and refuse a value of the wrong kind', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ terminal: { pasteGuard: false, ruler: 100, editorUrl: 'vscode://file/{path}:{line}:{col}', images: false, portLinks: false } });
    expect(new ConfigStore(env.paths).get().terminal).toEqual({ blocks: true, pasteGuard: false, ruler: 100, editorUrl: 'vscode://file/{path}:{line}:{col}', images: false, portLinks: false });
    store.patch({ terminal: { pasteGuard: 'yes', ruler: '80', editorUrl: 7, images: 1, portLinks: null } as never });
    expect(new ConfigStore(env.paths).get().terminal).toEqual({ blocks: true, pasteGuard: false, ruler: 100, editorUrl: 'vscode://file/{path}:{line}:{col}', images: false, portLinks: false });
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
    expect(store.get().session).toMatchObject({ stayAwake: false });
    store.patch({ appearance: { fontSize: 15 } });
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.session).toEqual({ restoreScreen: false, stayAwake: false }); // kept as it was, like any key a config does not know
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
    expect(DEFAULT_CONFIG.session).toEqual({ stayAwake: true });
    // @ts-expect-error there is no Resume button any more: no code can read the switch from the config's type
    void DEFAULT_CONFIG.session.resumeClaude;
    // nor a login agent that keeps the session running (the switch was `session.keepRunning`)
    expect('keepRunning' in DEFAULT_CONFIG.session).toBe(false);
    // @ts-expect-error there is no login agent any more: no code can read the switch from the config's type
    void DEFAULT_CONFIG.session.keepRunning;
    // what 0.5.x left behind: the offer switched off, the agent switched on, and another choice beside them
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { resumeClaude: false, keepRunning: true, stayAwake: false } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session).toMatchObject({ stayAwake: false });
    store.patch({ appearance: { fontSize: 15 } });
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.session).toEqual({ resumeClaude: false, keepRunning: true, stayAwake: false }); // kept as it was, like any key a config does not know
  });
});

describe('session.stayAwake, and the autoResume an old config may still have', () => {
  it('autoResume is gone (0.5.1): not a setting and not a default; an old file that has it loads, keeps it after a patch of another key, and nothing reads it', () => {
    expect('autoResume' in DEFAULT_CONFIG.session).toBe(false);
    // @ts-expect-error resuming by itself is not a setting any more: no code can read it from the config's type
    void DEFAULT_CONFIG.session.autoResume;
    // what a 0.5.0 left behind, with resuming by itself on
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { resumeClaude: false, autoResume: true } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session).toMatchObject({ resumeClaude: false, stayAwake: true });
    store.patch({ session: { stayAwake: false } });
    const saved = JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
    expect(saved.session).toEqual({ resumeClaude: false, stayAwake: false, autoResume: true }); // kept as it was, like any key a config does not know
    expect(new ConfigStore(env.paths).get().session.stayAwake).toBe(false);
  });

  it('stayAwake is on by default, also for a config file saved before it existed, and a choice is kept', () => {
    expect(DEFAULT_CONFIG.session.stayAwake).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { resumeClaude: false } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().session).toMatchObject({ stayAwake: true });
    store.patch({ session: { stayAwake: false } });
    expect(new ConfigStore(env.paths).get().session).toMatchObject({ stayAwake: false });
  });

  it('keep the default when the saved value is not a boolean (the switch stays a switch)', () => {
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, session: { stayAwake: null } }));
    expect(new ConfigStore(env.paths).get().session).toMatchObject({ stayAwake: true });
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


describe('appearance.petSize', () => {
  it('is normal by default, also for a config file saved before it existed; a choice is kept and the value stays text', () => {
    expect(DEFAULT_CONFIG.appearance.petSize).toBe('normal');
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { pet: false } }));
    const store = new ConfigStore(env.paths);
    expect(store.get().appearance.petSize).toBe('normal');
    store.patch({ appearance: { petSize: 'huge' } });
    expect(new ConfigStore(env.paths).get().appearance.petSize).toBe('huge');
    store.patch({ appearance: { petSize: 5 as never } });
    expect(store.get().appearance.petSize).toBe('huge'); // a number is not a size: the previous value stays
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
    expect(cfg.notifications).toEqual({ claudeFinished: true, weeklyDigest: true }); // (the defaults, written out: 1.4.0 added weeklyDigest)
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

describe('migrated, and the settings 0.6.0 no longer has (the first start\'s clean-up prunes them once)', () => {
  it('migrated is 0 by default, also for a config file saved before it existed; a number stays a number, anything else is 0', () => {
    expect(DEFAULT_CONFIG.migrated).toBe(0);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    expect(new ConfigStore(env.paths).get().migrated).toBe(0);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, migrated: 1 }));
    const store = new ConfigStore(env.paths);
    expect(store.get().migrated).toBe(1);
    store.patch({ appearance: { fontSize: 15 } });
    expect(JSON.parse(fs.readFileSync(env.paths.config, 'utf8')).migrated).toBe(1); // a patch of another key keeps it
    fs.writeFileSync(env.paths.config, JSON.stringify({ migrated: 'yes' }));
    expect(new ConfigStore(env.paths).get().migrated).toBe(0);
  });

  it('pruneDeadKeys takes out exactly the settings that are gone, and leaves everything else as it was (claude.skipped, the other session keys, keys it does not know)', () => {
    expect([...DEAD_KEYS]).toEqual(['memory', 'ingest', 'export', 'safety', 'session.restoreScreen', 'session.resumeClaude', 'session.keepRunning', 'session.autoResume']);
    const old = {
      onboarded: true,
      appearance: { theme: 'jaffer-light' },
      claude: { skipped: true, showCost: false },
      session: { stayAwake: false, restoreScreen: false, resumeClaude: true, keepRunning: true, autoResume: true },
      memory: { enabled: true },
      ingest: { claudeCode: true },
      export: { targets: ['claude-code'] },
      safety: { dangerTint: true },
      future: { x: 1 },
    };
    const copy = structuredClone(old);
    expect(pruneDeadKeys(old)).toEqual({ onboarded: true, appearance: { theme: 'jaffer-light' }, claude: { skipped: true, showCost: false }, session: { stayAwake: false }, future: { x: 1 } });
    expect(old).toEqual(copy); // (what it was given is not changed)
    expect(pruneDeadKeys({ session: 'oops', memory: null })).toEqual({ session: 'oops' }); // a section of the wrong kind is not its to fix: the store does that
    expect(pruneDeadKeys({})).toEqual({});
  });
});

describe('appearance.autoTheme, appearance.lightTheme and appearance.blur', () => {
  it('default to off, jaffer-light and blur on, also for a config file saved before they existed', () => {
    expect(DEFAULT_CONFIG.appearance).toMatchObject({ autoTheme: 'off', lightTheme: 'jaffer-light', blur: true });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { theme: 'nord' } }));
    expect(new ConfigStore(env.paths).get().appearance).toMatchObject({ theme: 'nord', autoTheme: 'off', lightTheme: 'jaffer-light', blur: true });
  });

  it('a choice is kept, and a value of the wrong kind leaves what was there', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ appearance: { autoTheme: 'time', lightTheme: 'nord', blur: false } });
    store.patch({ appearance: { autoTheme: 3, lightTheme: null, blur: 'no' } } as never);
    expect(new ConfigStore(env.paths).get().appearance).toMatchObject({ autoTheme: 'time', lightTheme: 'nord', blur: false });
  });
});

describe('window: the close button and the menu bar item (1.0.1)', () => {
  const WINDOW_DEFAULTS = { closeAction: 'menubar', menuBar: true, menuBarOnly: false, menuBarTitle: 'off', hintShown: false, dropdown: false };

  it('defaults to hide to the menu bar, the item on, the Dock icon kept, no title text and no hint shown yet, also for a config file saved before it existed', () => {
    expect(DEFAULT_CONFIG.window).toEqual(WINDOW_DEFAULTS);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { theme: 'nord' } }));
    expect(new ConfigStore(env.paths).get().window).toEqual(WINDOW_DEFAULTS);
    fs.writeFileSync(env.paths.config, JSON.stringify({ window: 'menubar' }));
    expect(new ConfigStore(env.paths).get().window).toEqual(WINDOW_DEFAULTS);
  });

  it('a choice is kept, and a value of the wrong kind leaves what was there', () => {
    const store = new ConfigStore(env.paths);
    const chosen = { closeAction: 'ask', menuBar: false, menuBarOnly: true, menuBarTitle: 'today', hintShown: true, dropdown: true };
    store.patch({ window: chosen } as never);
    store.patch({ window: { closeAction: 1, menuBar: 'yes', menuBarOnly: null, menuBarTitle: false, hintShown: 0, dropdown: 'yes' } } as never);
    expect(new ConfigStore(env.paths).get().window).toEqual(chosen);
  });
});

describe('panel: the side panel (1.1.0)', () => {
  it('is open and 300 px wide by default, also for a config file saved before it existed', () => {
    expect(DEFAULT_CONFIG.panel).toEqual({ open: true, width: 300 });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { theme: 'nord' } }));
    expect(new ConfigStore(env.paths).get().panel).toEqual({ open: true, width: 300 });
    fs.writeFileSync(env.paths.config, JSON.stringify({ panel: 'open' }));
    expect(new ConfigStore(env.paths).get().panel).toEqual({ open: true, width: 300 });
  });

  it('a choice is kept, and a value of the wrong kind leaves what was there', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ panel: { open: false, width: 410 } });
    store.patch({ panel: { open: 'yes', width: '200' } } as never);
    expect(new ConfigStore(env.paths).get().panel).toEqual({ open: false, width: 410 });
  });
});

describe('permissions (1.4.0)', () => {
  it('has its defaults (explain and deepSearch off, resumeTyping and trash on), also for a config file saved before it existed', () => {
    expect(DEFAULT_CONFIG.permissions).toEqual({ explain: false, deepSearch: false, resumeTyping: true, trash: true });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, appearance: { theme: 'nord' } }));
    expect(new ConfigStore(env.paths).get().permissions).toEqual({ explain: false, deepSearch: false, resumeTyping: true, trash: true });
  });

  it('a choice is kept, and a value of the wrong kind (or a section that is no object) leaves what was there', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ permissions: { resumeTyping: false, explain: true } });
    store.patch({ permissions: { trash: 'no', deepSearch: 1 } } as never);
    expect(new ConfigStore(env.paths).get().permissions).toEqual({ explain: true, deepSearch: false, resumeTyping: false, trash: true });
    fs.writeFileSync(env.paths.config, JSON.stringify({ permissions: 'off' }));
    expect(new ConfigStore(env.paths).get().permissions).toEqual({ explain: false, deepSearch: false, resumeTyping: true, trash: true });
  });
});

describe('1.4.0: the work-time budget, project budgets, the weekly numbers and the weekly digest', () => {
  const week = { id: '', usd: 0, workMs: 0 };
  it('have their defaults (no budgets, empty weeks, the digest on), also for a config file saved before they existed', () => {
    expect(DEFAULT_CONFIG.claude).toMatchObject({ dailyWorkBudgetMin: 0, projectBudgets: [] });
    expect(DEFAULT_CONFIG.usage).toEqual({ week, lastWeek: week, digestWeek: '' });
    expect(DEFAULT_CONFIG.notifications.weeklyDigest).toBe(true);
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, claude: { showCost: true }, notifications: { claudeFinished: false } }));
    const c = new ConfigStore(env.paths).get();
    expect(c.claude).toMatchObject({ dailyWorkBudgetMin: 0, projectBudgets: [] });
    expect(c.usage).toEqual({ week, lastWeek: week, digestWeek: '' });
    expect(c.notifications).toEqual({ claudeFinished: false, weeklyDigest: true });
  });

  it('a choice is kept; a value of the wrong kind (or a week that is no object) leaves what was there: numbers and ids only', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ claude: { dailyWorkBudgetMin: 180, projectBudgets: ['/work/api=20'] }, usage: { week: { id: '2026-W42', usd: 1.5, workMs: 60_000 }, digestWeek: '2026-W41' }, notifications: { weeklyDigest: false } });
    store.patch({ claude: { dailyWorkBudgetMin: '60', projectBudgets: [1] }, usage: { week: { usd: 'lots' }, lastWeek: 'x', digestWeek: 7 }, notifications: { weeklyDigest: 'no' } } as never);
    const c = new ConfigStore(env.paths).get();
    expect(c.claude).toMatchObject({ dailyWorkBudgetMin: 180, projectBudgets: ['/work/api=20'] });
    expect(c.usage).toEqual({ week: { id: '2026-W42', usd: 1.5, workMs: 60_000 }, lastWeek: week, digestWeek: '2026-W41' });
    expect(c.notifications.weeklyDigest).toBe(false);
    fs.writeFileSync(env.paths.config, JSON.stringify({ usage: { week: 5, lastWeek: { id: 3, usd: 2 } } }));
    expect(new ConfigStore(env.paths).get().usage).toEqual({ week, lastWeek: { id: '', usd: 2, workMs: 0 }, digestWeek: '' });
  });
});

describe('1.4.0: tour.done, tips.enabled and tips.seen', () => {
  it('have their defaults (the tour not done, tips on, none seen), also for a config file saved before they existed', () => {
    expect(DEFAULT_CONFIG.tour).toEqual({ done: false });
    expect(DEFAULT_CONFIG.tips).toEqual({ enabled: true, seen: [] });
    fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true }));
    const c = new ConfigStore(env.paths).get();
    expect(c.tour).toEqual({ done: false });
    expect(c.tips).toEqual({ enabled: true, seen: [] });
  });

  it('a choice is kept; a value of the wrong kind leaves what was there (a switch stays a boolean, the seen ids a list of text)', () => {
    const store = new ConfigStore(env.paths);
    store.patch({ tour: { done: true }, tips: { enabled: false, seen: ['compaction'] } });
    store.patch({ tour: { done: 'yes' }, tips: { enabled: 0, seen: 'compaction' } } as never);
    expect(new ConfigStore(env.paths).get()).toMatchObject({ tour: { done: true }, tips: { enabled: false, seen: ['compaction'] } });
    fs.writeFileSync(env.paths.config, JSON.stringify({ tips: 'off', tour: [] }));
    expect(new ConfigStore(env.paths).get()).toMatchObject({ tour: { done: false }, tips: { enabled: true, seen: [] } });
  });
});
