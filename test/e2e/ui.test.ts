import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../helpers/env';
import { MockAnthropic } from '../helpers/mock-anthropic';
import { fakeClaude } from '../helpers/fake-claude';
import { ensureDaemon, tryConnect } from '../../src/core/daemon-client';
import { findClaude } from '../../src/core/integrations/claude';

/**
 * Drives the real renderer in headless Chromium against the real daemon (through the dev bridge),
 * with a mock Anthropic API behind it. Screenshots land in $JAFFER_SHOTS (default: a temp dir).
 */
const CLAUDE = await findClaude().catch(() => null);
const root = path.resolve(__dirname, '../..');
const shots = process.env.JAFFER_SHOTS ?? path.join(process.env.TMPDIR ?? '/tmp', 'jaffer-shots');
const CHROME = [process.env.JAFFER_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => p && fs.existsSync(p));

let env: TestEnv;
let fake: ReturnType<typeof fakeClaude>;
let mock: MockAnthropic;
let bridge: ChildProcess;
let browser: Browser;
let page: Page;
let url = '';

async function termText(): Promise<string> {
  return page.evaluate(() => {
    const t = (window as any).__jaffer.terminals.get('main').term;
    const b = t.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)!.translateToString(true));
    return out.join('\n');
  });
}

async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 15_000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Claude Code hook event, as `jaffer hook` would deliver it from inside Jaffer's terminal. */
const sendHook = (name: string, over: Record<string, unknown> = {}) => page.evaluate((p) => window.jaffer.call('claude.event', p), { session_id: 'live-1', hook_event_name: name, cwd: '/work/app', ...over });

async function shot(name: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

beforeAll(async () => {
  expect(CHROME, 'a Chromium binary is required (set JAFFER_CHROME)').toBeTruthy();
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'ignore' });
  env = makeEnv();
  fs.writeFileSync(path.join(env.userHome, '.bashrc'), "PS1='\\[\\e[32m\\]\\w\\[\\e[0m\\] ❯ '\n");
  fs.writeFileSync(path.join(env.userHome, '.zshenv'), 'skip_global_compinit=1\n');
  fs.writeFileSync(path.join(env.userHome, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n'); // login shells read this, as on a real Mac
  // Other agents' config folders exist on this Mac; Jaffer is Claude Code only and must not offer to write to them.
  fs.mkdirSync(path.join(env.userHome, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(env.userHome, '.gemini'), { recursive: true });
  // `claude` as the app finds it: signed out at first, and the real binary for everything except `claude auth`.
  fake = fakeClaude(path.join(env.root, 'bin'), { loggedIn: false, passthrough: CLAUDE, interactive: 'stub' });
  mock = new MockAnthropic();
  const mockUrl = await mock.listen();
  bridge = spawn(process.execPath, [path.join(root, 'dist/dev/bridge.cjs')], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, JAFFER_HOME: env.home, HOME: env.userHome, SHELL: '/bin/bash', ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000', ANTHROPIC_BASE_URL: mockUrl, JAFFER_BRIDGE_TOKEN: 'tok', CLAUDE_CONFIG_DIR: path.join(env.userHome, '.claude'), JAFFER_KEEP_ANTHROPIC_ENV: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge did not start')), 20_000);
    bridge.stdout!.on('data', (d) => {
      const m = /BRIDGE (\S+)/.exec(d.toString());
      if (m) (clearTimeout(t), resolve(m[1]!));
    });
  });
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
}, 90_000);

afterAll(async () => {
  await browser?.close();
  bridge?.kill();
  const c = await tryConnect(env.paths);
  await c?.call('app.shutdown', {}).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  await mock?.close();
  env?.cleanup();
});

describe('Jaffer UI end to end', () => {
  it('first run: sign in to Claude comes first and gates everything, then consent, then the terminal', async () => {
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.onboard[data-step="signin"]', { timeout: 20_000 });
    // signed out: the screen says so, offers the sign-in, and offers nothing else
    await until(async () => (await page.locator('.ob-checks li[data-state="ok"]').count()) >= 1, 15_000, 'Claude Code to be detected');
    const text = (await page.textContent('.onboard')) ?? '';
    expect(text).toContain('Sign in with Claude');
    expect(text).toMatch(/plain terminal/i); // Claude is optional: a way past the sign-in is offered, in plain words
    expect(text).not.toMatch(/api key|console/i); // subscriptions only: no key, no pay-per-use account
    expect(await page.locator('.onboard .choices').count()).toBe(0);
    expect(await page.getByText('Get started').count()).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('.onboard').count()).toBe(1); // it cannot be dismissed
    await shot('01a-onboarding-signin');

    // signing in (the stand-in `claude auth login` signs in a moment after it starts) moves on to the consent choices
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard[data-step="choices"]', { timeout: 20_000 });
    const choices = (await page.textContent('.onboard')) ?? '';
    expect(choices).not.toMatch(/codex|gemini|other agents|api key/i);
    expect(choices).toMatch(/hooks/i); // what connecting Claude Code does is said plainly: the hooks see its prompts and tool calls
    expect(choices).toMatch(/your prompts, its tool calls and replies/i);
    expect(choices).not.toMatch(/MCP/); // the memory tools are Settings → Claude Code, not a first-run decision
    // starting Claude Code is a choice too, on by default, and it says who answers Claude Code's own questions
    const startBox = page.locator('.onboard .choices label', { hasText: 'Start Claude Code in the terminal now' }).locator('input[type=checkbox]');
    expect(await startBox.count()).toBe(1);
    expect(await startBox.isChecked()).toBe(true);
    expect(choices).toMatch(/Jaffer never answers them for you/i);
    const noArgCalls = () => fake.calls().filter((l) => l.startsWith(' HOME=')).length; // `claude` typed with nothing after it
    expect(choices).toContain('Get started');
    // the way forward is always in view, however short the window: Get started stays inside the dialog without scrolling
    for (const height of [860, 640]) {
      await page.setViewportSize({ width: 1360, height });
      await sleep(150);
      const dialog = (await page.locator('.onboard').boundingBox())!;
      const btn = (await page.locator('.onboard .btn.primary').boundingBox())!;
      expect(btn.y + btn.height, `Get started inside the dialog at ${height}px high`).toBeLessThanOrEqual(dialog.y + dialog.height + 0.5);
      if (height >= 800) {
        // at an ordinary window height every choice is readable without scrolling: nothing sits behind the button
        const last = (await page.locator('.onboard .choices label').last().boundingBox())!;
        expect(last.y + last.height, `the last choice clear of Get started at ${height}px high`).toBeLessThanOrEqual(btn.y + 0.5);
      }
    }
    await page.setViewportSize({ width: 1360, height: 860 });
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).onboarded).toBe(false); // not done until they say so
    await shot('01-onboarding');

    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard', { state: 'detached' });
    await page.waitForSelector('.term .xterm');
    const cfg = await page.evaluate(() => window.jaffer.call('config.get'));
    expect(cfg.onboarded).toBe(true);
    expect(cfg.memory.enabled).toBe(true);
    expect(cfg.export.targets).not.toContain('codex');
    expect(fake.calls().some((l) => l.startsWith('auth login '))).toBe(true);
    expect(fake.calls().some((l) => l.startsWith('mcp add'))).toBe(false); // Get started connects the hooks for the panel, not the MCP server
    await until(async () => noArgCalls() === 1, 15_000, 'Get started to start Claude Code in the terminal'); // typed for the person, once
    await until(async () => /fake claude: interactive session/.test(await termText()), 10_000, 'Claude Code to answer in the terminal')
    // Jaffer drove the sign-in itself: nothing was typed into the user's shell
    await until(async () => /❯/.test(await termText()), 20_000, 'the shell prompt');
    expect(await termText()).not.toMatch(/auth login/);
    // a calm window: the terminal, a title bar, and the mole
    expect(await page.locator('.rail, .statusbar, .agent, .panel-head').count()).toBe(0);
    await page.waitForSelector('.pet-corner .pet');
  }, 90_000);

  it('a calm window: only the terminal, the title bar and the mole, whatever keys are pressed', async () => {
    for (const k of ['Meta+b', 'Meta+j']) await page.keyboard.press(k); // the sidebar and the Claude panel are gone
    await sleep(300);
    expect(await page.locator('.rail, .statusbar, .agent, .panel-head, .side').count()).toBe(0);
    expect(await page.locator('.titlebar .seg-btn', { hasText: 'Memory' }).count()).toBe(1); // memory is the one drawer, one click away
    expect(await page.locator('.titlebar .seg-btn', { hasText: 'Claude' }).count()).toBe(0);
    const term = (await page.locator('.terminal-area').boundingBox())!;
    const pet = (await page.locator('.pet-corner').boundingBox())!;
    expect(pet.x + pet.width).toBeLessThanOrEqual(term.x + term.width + 0.5); // the mole sits inside a corner of the terminal
    expect(pet.y + pet.height).toBeLessThanOrEqual(term.y + term.height + 0.5);
    expect(await page.$eval('.pet-corner', (el) => getComputedStyle(el).pointerEvents)).toBe('none'); // and never takes a click or a selection
    await shot('02a-calm-window');
  });


  it('first run without Claude: "plain terminal" passes the sign-in, offers no Claude switches, and installs and starts nothing', async () => {
    const noArgCalls = () => fake.calls().filter((l) => l.startsWith(' HOME=')).length;
    const before = noArgCalls();
    await page.evaluate(() => window.jaffer.call('setup.claude.remove', {})); // a Mac where Claude Code is not connected
    fake.setLoggedIn(false);
    await page.evaluate(() => window.jaffer.call('config.patch', { onboarded: false }));
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.onboard[data-step="signin"]', { timeout: 20_000 });
    await page.locator('.onboard button', { hasText: 'plain terminal' }).click();
    await page.waitForSelector('.onboard[data-step="choices"]');
    const text = (await page.textContent('.onboard')) ?? '';
    expect(text).toContain('Learn from my sessions');
    expect(text).not.toMatch(/Start Claude Code|Show what Claude is doing|curate memory/i);
    expect(text).toMatch(/Settings → Claude Code/i); // and how to add Claude later
    await shot('01b-onboarding-plain-terminal');
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard', { state: 'detached' });
    await page.waitForSelector('.term .xterm');
    const cfg = await page.evaluate(() => window.jaffer.call('config.get'));
    expect(cfg).toMatchObject({ onboarded: true, claude: { skipped: true }, ingest: { claudeCode: false }, memory: { llm: 'off' } }); // nothing is sent to Claude unless they switch it on later
    expect((await page.evaluate(() => window.jaffer.call('setup.claude.status'))).hooks).toBe(false);
    await sleep(1_800);
    expect(noArgCalls()).toBe(before); // no `claude` was typed
    // adopting Claude later, from the panel: signed in and connected, and "skipped" is gone
    fake.setLoggedIn(true);
    await page.evaluate(() => window.jaffer.call('setup.claude.install', { mcp: false }));
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).claude.skipped).toBe(false);
    await page.evaluate(() => window.jaffer.call('config.patch', { memory: { llm: 'auto' }, ingest: { claudeCode: true } }));
  }, 60_000);

  it('first run with "Start Claude Code" switched off: Get started types nothing into the terminal', async () => {
    const noArgCalls = () => fake.calls().filter((l) => l.startsWith(' HOME=')).length;
    const before = noArgCalls();
    await page.evaluate(() => window.jaffer.call('config.patch', { onboarded: false }));
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.onboard[data-step="choices"]', { timeout: 20_000 }); // already signed in: straight to the choices
    await page.locator('.onboard .choices label', { hasText: 'Start Claude Code in the terminal now' }).locator('.switch').click();
    expect(await page.locator('.onboard .choices label', { hasText: 'Start Claude Code in the terminal now' }).locator('input[type=checkbox]').isChecked()).toBe(false);
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard', { state: 'detached' });
    await page.waitForSelector('.term .xterm');
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).onboarded === true, 8_000, 'onboarding to finish');
    await sleep(2_500); // long enough for a typed command to have run
    expect(noArgCalls()).toBe(before);
  }, 60_000);
  it('hosts a working shell: type, run, see output; colours and prompt render', async () => {
    await until(async () => /❯/.test(await termText()), 20_000, 'the shell prompt');
    await page.click('.term');
    await page.keyboard.type('echo hello-from-the-ui', { delay: 8 });
    await page.keyboard.press('Enter');
    await until(async () => (await termText()).split('\n').filter((l) => l.includes('hello-from-the-ui')).length >= 2, 10_000, 'command output');
    await page.keyboard.type("printf '\\033[31mred\\033[0m \\033[38;2;255;138;76mtruecolor\\033[0m\\n'");
    await page.keyboard.press('Enter');
    await until(async () => /red truecolor/.test(await termText()), 10_000, 'colour output');
    await shot('02-terminal');
  }, 40_000);

  it('the title bar follows the shell (cwd)', async () => {
    await page.keyboard.type('cd /tmp');
    await page.keyboard.press('Enter');
    await until(async () => (await page.textContent('.session-pill .cwd'))?.includes('/tmp'), 10_000, 'cwd in the title bar');
  });

  it('Settings → Updates: the version, the automatic-checks switch, Check now, and what a ready update looks like', async () => {
    const send = (state: object) => page.evaluate((st) => (window as any).__event('update.state', st), state);
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Updates' }).click();
    expect(await page.textContent('[data-upd-status]')).toContain(`Jaffer ${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`); // the version this build reports
    // the switch is the setting
    await page.locator('label.field', { hasText: 'Check automatically' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).updates.auto === false, 8_000, 'automatic checks to be switched off');
    await page.locator('label.field', { hasText: 'Check automatically' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).updates.auto === true, 8_000, 'automatic checks to be switched on again');
    // Check now answers
    await page.locator('button', { hasText: 'Check now' }).click();
    await until(async () => /Up to date/.test((await page.textContent('[data-upd-status]')) ?? ''), 8_000, 'the answer to Check now');
    // a downloaded update: named, with a button that asks (the real prompt is a native dialog)
    await send({ status: 'downloading', current: '0.1.1', version: '0.2.0', auto: true });
    await until(async () => /Downloading 0\.2\.0/.test((await page.textContent('[data-upd-status]')) ?? ''), 8_000, 'the download to show');
    await send({ status: 'ready', current: '0.1.1', version: '0.2.0', auto: true });
    await until(async () => /0\.2\.0 is ready/.test((await page.textContent('[data-upd-status]')) ?? ''), 8_000, 'the ready update to show');
    expect(await page.locator('button', { hasText: 'Install 0.2.0' }).count()).toBe(1);
    await shot('13-updates');
    // an unsigned build says why there is nothing to check, and offers no button that cannot work
    await send({ status: 'unavailable', current: '0.1.1', auto: true });
    await until(async () => /only the signed release/i.test((await page.textContent('[data-upd-status]')) ?? ''), 8_000, 'the unavailable text');
    expect(await page.locator('button', { hasText: 'Check now' }).count()).toBe(0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  });

  it('the running-process spinner: an ordinary command spins, Claude Code spins only while it works, and Animations off stops it', async () => {
    const cs = (sel: string, prop: string) => page.$eval(sel, (el, p) => (getComputedStyle(el) as any)[p as string], prop);
    const bar = '.session-pill .running';
    await page.click('.term');
    // an ordinary command is working until it ends: it spins
    await page.keyboard.type('sleep 40', { delay: 4 });
    await page.keyboard.press('Enter');
    await page.waitForSelector(`${bar} .spinner`);
    expect(await cs(`${bar} .spinner`, 'animationName')).toContain('spin');
    await page.keyboard.press('Control+c');
    await until(async () => !(await page.$(bar)), 10_000, 'the command to end');
    // Claude Code is a program you sit in: running is not working. (A command line that names claude stands in for it.)
    await page.keyboard.type('sleep 40 # claude', { delay: 4 });
    await page.keyboard.press('Enter');
    await page.waitForSelector(`${bar}[data-kind="claude"]`);
    expect(await page.locator(`${bar} .spinner`).count()).toBe(0);
    expect(await page.locator(`${bar} .run-dot`).count()).toBe(1);
    // it starts working: now it moves
    await sendHook('UserPromptSubmit', { session_id: 'spin-1', prompt: 'go' });
    await page.waitForSelector(`${bar} .spinner`);
    expect(await cs(`${bar} .spinner`, 'animationName')).toContain('spin');
    // Animations off: the ring stands still, still visible
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: false } }));
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
    expect(await cs(`${bar} .spinner`, 'animationName')).toBe('none');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: true } }));
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'on', 8_000, 'motion to be on again');
    // the turn ends: calm again, though the program is still running
    await sendHook('Stop', { session_id: 'spin-1', last_assistant_message: 'done' });
    await until(async () => (await page.locator(`${bar} .spinner`).count()) === 0, 8_000, 'the spinner to stop');
    expect(await page.locator(`${bar} .run-dot`).count()).toBe(1);
    await page.keyboard.press('Control+c');
    await until(async () => !(await page.$(bar)), 10_000, 'the command to end');
    await sendHook('SessionEnd', { session_id: 'spin-1' });
  }, 60_000);

  it('Settings → Reset: says what it does, and only asks the app (which asks the person) before anything is touched', async () => {
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Reset' }).click();
    const text = (await page.textContent('.settings')) ?? '';
    expect(text).toMatch(/Claude Code itself/i); // what is NOT touched is said too
    expect(text).toMatch(/backup/i);
    await page.locator('button', { hasText: 'Reset…' }).click();
    await until(async () => (await page.evaluate(() => (window as any).__resetCalled)) === 1, 5_000, 'the app to be asked to reset');
    // the stand-in app answers "cancelled": nothing changed
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).onboarded).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  });

  it('the pet: asleep when nothing runs, digging while something does, up when Claude needs you, cheering after a turn, gone when switched off', async () => {
    const pet = '.pet-corner .pet';
    const mood = () => page.getAttribute(pet, 'data-mood');
    const arm = `${pet} .pet-arm-l`;
    const cs = (sel: string, prop: string) => page.$eval(sel, (el, p) => (getComputedStyle(el) as any)[p as string], prop);
    await page.waitForSelector(pet);
    // a clean slate: earlier tests left Claude sessions behind, and an open Claude Code (even idle) is not sleep
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    await until(async () => (await mood()) === 'sleep', 8_000, 'the pet to be asleep');
    await shot('14a-pet-sleep');
    // something runs: it digs, and the claws move
    await page.click('.term');
    await page.keyboard.type('sleep 40', { delay: 4 });
    await page.keyboard.press('Enter');
    await until(async () => (await mood()) === 'dig', 8_000, 'the pet to dig');
    expect(await cs(arm, 'animationName')).toContain('pet-dig');
    await sleep(250);
    await shot('14b-pet-dig');
    // Claude needs the person: it pops up
    const bash = { session_id: 'pet-1', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'p1' };
    await sendHook('PreToolUse', bash);
    await sendHook('Notification', { session_id: 'pet-1', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    await until(async () => (await mood()) === 'alert', 8_000, 'the pet to pop up');
    await sleep(250);
    await shot('14c-pet-alert');
    // answered, works, finishes: it cheers for a moment, then goes back to what is still running
    await sendHook('PostToolUse', bash);
    await sendHook('Stop', { session_id: 'pet-1', last_assistant_message: 'done' });
    await until(async () => (await mood()) === 'cheer', 8_000, 'the pet to cheer');
    await sleep(150);
    await shot('14d-pet-cheer');
    await until(async () => (await mood()) === 'dig', 8_000, 'the pet to go back to digging (the command still runs)');
    // macOS "Reduce motion": the claws stand still even though the setting is on
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(parseFloat(String(await cs(arm, 'animationDuration')))).toBeLessThan(0.001);
    await page.emulateMedia({ reducedMotion: null });
    // Animations off: same pose, nothing moves
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: false } }));
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
    expect(await mood()).toBe('dig');
    expect(await cs(arm, 'animationName')).toBe('none');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: true } }));
    await page.keyboard.press('Control+c');
    await until(async () => (await mood()) === 'rest', 8_000, 'the pet to rest (Claude is open and idle)');
    await shot('14e-pet-rest');
    await sendHook('SessionEnd', { session_id: 'pet-1' });
    await until(async () => (await mood()) === 'sleep', 8_000, 'the pet to sleep again');
    // switched off in Settings: gone
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { pet: false } }));
    await until(async () => (await page.locator(pet).count()) === 0, 8_000, 'the pet to leave');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { pet: true } }));
    await page.waitForSelector(pet);
  }, 90_000);

  it('the crew: a helper mole for every background agent, they outlive the main turn, cheer when done, and leave with the session', async () => {
    const helpers = '.pet-corner .pet-helper';
    const count = () => page.locator(helpers).count();
    const moods = () => page.$$eval(helpers, (els) => els.map((e) => (e as HTMLElement).dataset.mood));
    const cs = (sel: string, prop: string) => page.$eval(sel, (el, p) => (getComputedStyle(el) as any)[p as string], prop);
    const hook = (name: string, over: Record<string, unknown> = {}) => sendHook(name, { session_id: 'crew-1', ...over });
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    await until(async () => (await count()) === 0, 8_000, 'no helpers to start with');
    await hook('SessionStart');
    await hook('UserPromptSubmit', { prompt: 'research three things' });
    await hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
    await hook('SubagentStart', { agent_id: 'a2', agent_type: 'general-purpose' });
    await until(async () => (await count()) === 2, 8_000, 'two helper moles');
    expect(await moods()).toEqual(['dig', 'dig']);
    expect(await cs(`${helpers} .pet-body`, 'animationName')).toContain('pet-bob');
    expect(await page.textContent('.pet-corner .pet[data-role="main"] title')).toMatch(/2 background agents working/); // said in words too, for anyone who cannot see it
    await sleep(600); // past the moment they pop out of their molehills
    await shot('14f-pet-crew');
    // the main turn ends, the agents go on: background agents outlive the turn that started them
    await hook('Stop', { last_assistant_message: 'two agents are on it' });
    await sleep(400);
    expect(await count()).toBe(2);
    expect(await moods()).toEqual(['dig', 'dig']);
    // one agent finishes: its mole cheers, then leaves
    await hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' });
    await until(async () => (await moods()).join() === 'dig,cheer', 5_000, 'one helper to cheer');
    await until(async () => (await count()) === 1, 6_000, 'the finished helper to leave');
    // a crowd is capped
    for (const id of ['a3', 'a4', 'a5']) await hook('SubagentStart', { agent_id: id, agent_type: 'Explore' });
    await until(async () => (await count()) === 3, 8_000, 'the crew capped at three');
    const card = (await page.locator('.terminal-area').boundingBox())!;
    const corner = (await page.locator('.pet-corner').boundingBox())!;
    expect(corner.x).toBeGreaterThanOrEqual(card.x);
    expect(corner.x + corner.width).toBeLessThanOrEqual(card.x + card.width);
    // Animations off: the crew is still there, standing still
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: false } }));
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
    expect(await count()).toBe(3);
    expect(await cs(`${helpers} .pet-body`, 'animationName')).toBe('none');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: true } }));
    // the session ends: no agent is running any more
    await hook('SessionEnd');
    await until(async () => (await count()) === 0, 8_000, 'the crew to leave with the session');
  }, 90_000);

  it('shows memory being learned, lets you pin and forget, and logs every change', async () => {
    await page.keyboard.press('Meta+Shift+M');
    await page.waitForSelector('.memory');
    // an explicit memory from the CLI shows up live, with an undo toast
    await page.evaluate(() => window.jaffer.call('memory.remember', { text: 'Prefer pnpm over npm in every JavaScript project', kind: 'preference' }));
    await page.waitForSelector('.mem');
    await page.waitForSelector('.toast.learn');
    expect(await page.textContent('.mem-list')).toContain('Prefer pnpm over npm');
    await shot('05-memory');
    await page.click('.mem .icon-btn[title^="Pin"]');
    await page.waitForSelector('.mem.pinned');
    await page.click('.tabs button:has-text("Activity")');
    await page.waitForSelector('.run');
    expect(await page.textContent('.mem-list')).toContain('add');
    await page.click('.tabs button:has-text("Learned")');
    await page.click('.mem .icon-btn[title="Forget"]');
    await until(async () => !(await page.$('.mem')), 8000, 'memory to disappear');
  }, 40_000);

  it('command palette runs actions', async () => {
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    // there is one Claude and it lives in the terminal: the palette has no "ask Claude" and no chat commands
    expect(await page.getAttribute('.palette input', 'placeholder')).not.toMatch(/ask claude/i);
    await page.keyboard.type('claude');
    const found = (await page.textContent('.palette-list')) ?? '';
    expect(found).toContain('Run Claude Code in the terminal');
    expect(found).not.toMatch(/Ask Claude|compact the conversation/i);
    expect(await page.locator('.pal-row.ask').count()).toBe(0);
    await page.fill('.palette input', '');
    await page.keyboard.type('tokyo');
    await shot('06-palette');
    await page.keyboard.press('Enter');
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).appearance.theme === 'tokyo-night', 8000, 'theme change');
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-solid').trim());
    expect(bg).toBe('#1a1b26');
    await shot('07-tokyo-night');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-light' } }));
    await until(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-solid').trim())) === '#fdfcfa', 8000, 'light theme');
    await shot('07b-light');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'tokyo-night' } }));
  }, 30_000);

  it('settings dialog opens and reflects the configuration', async () => {
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    expect(await page.textContent('.settings')).toContain('Claude Code');
    await shot('08-settings');
    // only the sections that still mean something: the panel's own settings (approvals, where commands run, model) went with its chat
    expect(await page.$$eval('.settings-nav button', (b) => b.map((x) => x.textContent?.trim()))).toEqual(['Appearance', 'Memory', 'Claude Code', 'Updates', 'Reset']);
    // Jaffer runs on a Claude subscription: no API key to enter and no engine to pick, in any section
    for (const section of ['Memory', 'Claude Code']) {
      await page.click(`.settings-nav button:has-text("${section}")`);
      const body = (await page.textContent('.settings')) ?? '';
      expect(body, `Settings > ${section}`).not.toMatch(/api key|Anthropic key|sk-ant/i);
      expect(await page.locator('.settings input[type="password"]').count(), `Settings > ${section}`).toBe(0);
    }
    await page.click('.settings-nav button:has-text("Claude Code")');
    expect((await page.textContent('.settings')) ?? '').toMatch(/Claude Code is installed/); // install and sign-in help live here now
    expect(await page.textContent('.settings')).not.toMatch(/Runs on|Automatic \(|Approvals|Run commands|Always-allowed/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  });

  it('there is exactly one session: no split controls, the shortcuts do nothing, and the daemon refuses to open another', async () => {
    await page.keyboard.press('Escape');
    expect(await page.$('button[title^="Split"]')).toBeNull();
    await page.evaluate(() => (window as any).__menu('split-right')); // what ⌘D used to do
    await page.evaluate(() => (window as any).__menu('split-down'));
    await sleep(500);
    expect(await page.$$('.term .xterm')).toHaveLength(1);
    expect(await page.$('.divider, .pane-head')).toBeNull();
    await expect(page.evaluate(() => window.jaffer.call('pane.split'))).rejects.toThrow(/unknown method/);
    expect(await page.evaluate(() => window.jaffer.call('pane.list'))).toHaveLength(1);
    // the one terminal fills its area (no leftover bands above or below)
    const box = await page.evaluate(() => {
      const pane = document.querySelector('.pane') as HTMLElement;
      const screen = pane.querySelector('.xterm-screen') as HTMLElement;
      return { pane: pane.getBoundingClientRect().height, screen: screen.getBoundingClientRect().height };
    });
    expect(box.pane).toBeGreaterThan(600);
    expect(box.screen).toBeGreaterThan(box.pane - 60);
  }, 30_000);

  it('reconnecting the page restores the same session (nothing was lost)', async () => {
    const before = await page.evaluate(() => window.jaffer.call('pane.list'));
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.term .xterm');
    await until(async () => /hello-from-the-ui/.test(await termText()), 15_000, 'restored screen');
    const after = await page.evaluate(() => window.jaffer.call('pane.list'));
    expect(after.map((p: any) => p.pid)).toEqual(before.map((p: any) => p.pid));
    await shot('10-restored');
  }, 40_000);

  it('the layout lines up at any window size: the title bar shares one centre line, the card has even margins, the drawer matches the card, the mole sits inside, nothing overflows', async () => {
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const cy = (b: { y: number; height: number }) => b.y + b.height / 2;
    const cx = (b: { x: number; width: number }) => b.x + b.width / 2;
    const measure = async (w: number, h: number, drawer: boolean) => {
      const bar = await box('.titlebar');
      const pill = await box('.session-pill');
      const mem = await box('.titlebar .seg');
      const card = await box('.terminal-area');
      const pet = await box('.pet-corner');
      const where = `${w}x${h}${drawer ? ' with the memory drawer' : ''}`;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5), `no sideways scroll at ${where}`).toBe(true);
      expect(Math.abs(cy(pill) - cy(bar)), `pill centred in the title bar at ${where}`).toBeLessThan(1.5);
      expect(Math.abs(cy(mem) - cy(bar)), `Memory button centred in the title bar at ${where}`).toBeLessThan(1.5);
      expect(Math.abs(cx(pill) - w / 2), `pill centred on the window at ${where}`).toBeLessThan(2);
      const left = card.x;
      const bottom = h - (card.y + card.height);
      expect(Math.abs(left - bottom), `card margins even (left ${left}, bottom ${bottom}) at ${where}`).toBeLessThan(1.5);
      expect(pet.x + pet.width, `mole inside the card at ${where}`).toBeLessThanOrEqual(card.x + card.width);
      expect(pet.y + pet.height, `mole inside the card at ${where}`).toBeLessThanOrEqual(card.y + card.height);
      if (drawer) {
        const side = await box('.side');
        expect(Math.abs(side.y - card.y), `drawer top meets the card top at ${where}`).toBeLessThan(1);
        expect(Math.abs(side.height - card.height), `drawer as tall as the card at ${where}`).toBeLessThan(1);
        if (w > 760) expect(Math.abs(side.x - (card.x + card.width) - left), `gap between card and drawer equals the margin at ${where}`).toBeLessThan(1.5); // a narrow window lets the drawer lie over the terminal instead
        expect(Math.abs(w - (side.x + side.width) - left), `right margin equals the left one at ${where}`).toBeLessThan(1.5);
      } else {
        expect(Math.abs(w - (card.x + card.width) - left), `right margin equals the left one at ${where}`).toBeLessThan(1.5);
      }
    };
    if (await page.$('.side')) await page.keyboard.press('Meta+Shift+M'); // start with the drawer closed
    await page.waitForSelector('.side', { state: 'detached' });
    for (const [w, h] of [[1360, 860], [900, 640], [660, 520]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(200);
      await measure(w, h, false);
      await page.keyboard.press('Meta+Shift+M');
      await page.waitForSelector('.side');
      await sleep(200);
      await measure(w, h, true);
      if (w < 1000) await shot(`15-layout-${w}`);
      await page.keyboard.press('Meta+Shift+M');
      await page.waitForSelector('.side', { state: 'detached' });
    }
    await page.setViewportSize({ width: 1360, height: 860 });
  });

  it('Shift+Enter inserts a newline for multi-line input (as Claude Code expects)', async () => {
    await page.click('.term');
    await page.keyboard.type('cat <<EOF');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    // bash receives ESC+CR; the raw input is visible on the screen as a continued line or ^[ — either way the command was not submitted
    await new Promise((r) => setTimeout(r, 300));
    expect(await termText()).not.toMatch(/cat <<EOF\n.*\$ /);
    await page.keyboard.press('Control+c');
  });

});

void ensureDaemon;
