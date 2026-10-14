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
    expect(choices).not.toMatch(/MCP/); // Jaffer has no tools of its own for Claude Code: only the hooks
    expect(choices).not.toMatch(/memory|learn from my sessions|curate/i); // and no memory to switch on
    expect(choices).toMatch(/quitting Jaffer ends the shell/i); // the app owns its terminal: said plainly, and nothing promises it lives on
    expect(text + choices).not.toMatch(/never ends|same session|keeps running/i);
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
    for (const k of ['Meta+b', 'Meta+j', 'Meta+Shift+M']) await page.keyboard.press(k); // the sidebar, the Claude panel and the memory drawer are gone
    await sleep(300);
    expect(await page.locator('.rail, .statusbar, .agent, .panel-head, .side').count()).toBe(0);
    // 1.0.0 allows command blocks inside the card (gutter marks, the sticky command header, the gutter menu); still no sidebar, drawer, panel or tab
    expect(await page.locator('.sidebar, .drawer, .panel, .tabs, .tab').count()).toBe(0);
    expect(await page.$$eval('.terminal-area > *', (els) => els.map((e) => e.className).filter((c) => !/^(panes|pet-corner|sticky-cmd|findbar)\b/.test(c)))).toEqual([]);
    expect(await page.locator('.titlebar .seg-btn, .titlebar .seg').count()).toBe(0); // no buttons in the title bar: the folder, the branch, the ring, the cost
    expect(await page.locator('.titlebar', { hasText: /memory/i }).count()).toBe(0);
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
    // a shortcut must not replace the first-run screen: closing what replaced it would leave first run unfinished
    for (const k of ['Meta+p', 'Meta+,', 'Meta+f']) await page.keyboard.press(k);
    await sleep(300);
    expect(await page.locator('.palette, .settings, .findbar').count()).toBe(0);
    expect(await page.locator('.onboard').count()).toBe(1);
    await page.locator('.onboard button', { hasText: 'plain terminal' }).click();
    await page.waitForSelector('.onboard[data-step="choices"]');
    const text = (await page.textContent('.onboard')) ?? '';
    expect(text).not.toMatch(/Start Claude Code|Show what Claude is doing|curate memory|Learn from my sessions|memory/i);
    expect(text).toMatch(/Settings → Claude Code/i); // and how to add Claude later
    await shot('01b-onboarding-plain-terminal');
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard', { state: 'detached' });
    await page.waitForSelector('.term .xterm');
    const cfg = await page.evaluate(() => window.jaffer.call('config.get'));
    expect(cfg).toMatchObject({ onboarded: true, claude: { skipped: true } }); // nothing about Claude is on unless they switch it on later
    expect(cfg).not.toHaveProperty('memory');
    expect(cfg).not.toHaveProperty('ingest');
    expect((await page.evaluate(() => window.jaffer.call('setup.claude.status'))).hooks).toBe(false);
    await sleep(1_800);
    expect(noArgCalls()).toBe(before); // no `claude` was typed
    // adopting Claude later, from the panel: signed in and connected, and "skipped" is gone
    fake.setLoggedIn(true);
    await page.evaluate(() => window.jaffer.call('setup.claude.install', {}));
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).claude.skipped).toBe(false);
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

  it('the title bar shows the git branch of the folder, and nothing outside a repository', async () => {
    const dir = path.join(env.userHome, 'branch-pill', 'app');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/login\n');
    await page.click('.term');
    await page.keyboard.type(`cd ${dir}`);
    await page.keyboard.press('Enter');
    await until(async () => /feature\/login/.test((await page.textContent('.session-pill')) ?? ''), 10_000, 'the branch in the title bar');
    expect(await page.locator('.session-pill .branch').textContent()).toContain('feature/login');
    await page.keyboard.type('cd /tmp');
    await page.keyboard.press('Enter');
    await until(async () => (await page.locator('.session-pill .branch').count()) === 0, 10_000, 'the branch to leave the title bar outside a repository');
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
    // Claude Code is a program you sit in: running is not working. (A shell function called claude that sleeps stands in for it.)
    await page.keyboard.type('claude() { sleep 40; }', { delay: 4 });
    await page.keyboard.press('Enter');
    await sleep(300);
    await page.keyboard.type('claude', { delay: 4 });
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
    await page.keyboard.type('unset -f claude', { delay: 4 });
    await page.keyboard.press('Enter');
    await sleep(300);
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

  it('the longer an agent works, the harder its mole works: faster, sweating, a hard hat and a bigger pile', async () => {
    const main = '.pet-corner .pet[data-role="main"]';
    const helpers = '.pet-corner .pet-helper';
    const efforts = () => page.$$eval(helpers, (els) => els.map((e) => (e as HTMLElement).dataset.effort));
    const cs = (sel: string, prop: string) => page.$eval(sel, (el, p) => (getComputedStyle(el) as any)[p as string], prop);
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    await until(async () => (await page.locator(helpers).count()) === 0, 8_000, 'no helpers to start with');
    await sleep(500); // the daemon's own trailing push of those endings must not land on top of what is injected below
    // what the daemon would push: a turn working for six minutes and three agents of different ages
    const push = (turn: number, ages: number[]) =>
      page.evaluate(
        ([t, a]) => {
          const now = Date.now();
          (window as any).__event('claude.state', {
            sessions: [{ id: 'effort-1', state: 'working', since: now - (t as number), subagents: (a as number[]).map((age, i) => ({ id: `e${i}`, type: 'Explore', status: 'running', startedAt: now - age })) }],
          });
        },
        [turn, ages] as const,
      );
    await push(10_000, [5_000]);
    await until(async () => (await page.getAttribute(main, 'data-effort')) === '0', 8_000, 'a fresh turn to be at effort 0');
    expect(await cs(`${main} .pet-hat`, 'opacity')).toBe('0');
    const calm = parseFloat(String(await cs(`${main} .pet-body`, 'animationDuration')));
    await push(6 * 60_000, [6 * 60_000, 150_000, 45_000]);
    await until(async () => (await page.getAttribute(main, 'data-effort')) === '3', 8_000, 'a six-minute turn to be at effort 3');
    await until(async () => (await efforts()).join() === '3,2,1', 8_000, 'the helpers to be as tired as their agents are old');
    // the hat and the pile fade in over a moment
    await until(async () => (await cs(`${main} .pet-hat`, 'opacity')) === '1', 5_000, 'the hard hat');
    await until(async () => (await cs(`${main} .pet-pile`, 'opacity')) === '1', 5_000, 'the pile of dirt');
    expect(await cs(`${main} .pet-sweat`, 'opacity')).not.toBe('0');
    expect(parseFloat(String(await cs(`${main} .pet-body`, 'animationDuration')))).toBeLessThan(calm * 0.6); // it digs faster
    expect(parseFloat(String(await cs(`${helpers}:nth-of-type(4) .pet-body`, 'animationDuration')))).toBeGreaterThan(parseFloat(String(await cs(`${main} .pet-body`, 'animationDuration')))); // and the younger agent's mole is calmer
    expect(await page.textContent(`${main} title`)).toMatch(/working hard/);
    await sleep(500);
    await shot('14g-pet-effort');
    // Animations off: the hat and the pile still say how long it has been
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: false } }));
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
    await until(async () => (await cs(`${main} .pet-hat`, 'opacity')) === '1', 5_000, 'the hard hat to stay on');
    expect(await cs(`${main} .pet-body`, 'animationName')).toBe('none');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: true } }));
    // a new agent starts fresh
    await push(6 * 60_000, [6 * 60_000, 2_000]);
    await until(async () => (await efforts()).join() === '3,0', 8_000, 'a new agent to start at effort 0');
    // the turn is over: nothing is left running
    await sendHook('SessionStart', { session_id: 'effort-2' });
    await sendHook('SessionEnd', { session_id: 'effort-2' });
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    await until(async () => (await page.getAttribute(main, 'data-effort')) === '0', 8_000, 'the effort to reset when the work stops');
  }, 90_000);

  it('companions: Settings lists all six, choosing one swaps the corner, an unknown one is the mole, and the switch still turns it off', async () => {
    const setApp = (appearance: object) => page.evaluate((a) => window.jaffer.call('config.patch', { appearance: a }), appearance);
    const corner = (c: string) => `.pet-corner[data-companion='${c}']`;
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Appearance' }).click();
    const cards = page.locator('.companions .companion-card');
    expect(await cards.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual(['mole', 'matrix', 'agents', 'warp', 'radar', 'core']);
    expect(await page.getAttribute('.companions', 'role')).toBe('radiogroup');
    // the mole is the one in use, and every tile is a live specimen (a scene, or the mole and its helper)
    expect(await page.getAttribute('.companion-card[data-id="mole"]', 'aria-checked')).toBe('true');
    expect(await page.locator('.comp-prev .scene').count()).toBe(5);
    expect(await page.locator('.comp-prev .pet').count()).toBe(2);
    expect(await page.locator(corner('mole')).count()).toBe(1);
    // seven animations on the page at once (the corner and six previews): no id may exist twice (a clip path or a gradient would be the first one's)
    expect(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map((e) => e.id); return ids.filter((id, i) => ids.indexOf(id) !== i); })).toEqual([]);
    await page.locator('.companion-card[data-id="matrix"]').click();
    await page.waitForSelector(`${corner('matrix')} .scene[data-variant="matrix"]`);
    expect(await page.locator('.pet-corner .pet').count()).toBe(0); // the mole left
    expect(await page.getAttribute('.companion-card[data-id="matrix"]', 'aria-checked')).toBe('true');
    expect(await page.getAttribute('.companion-card[data-id="mole"]', 'aria-checked')).toBe('false');
    // the keyboard: arrows move through the group and choose
    await page.focus('.companion-card[data-id="matrix"]');
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector(`${corner('agents')} .scene[data-variant="agents"]`);
    await until(async () => page.evaluate(() => document.activeElement?.getAttribute('data-id') === 'agents'), 3_000, 'focus to follow the choice');
    await page.keyboard.press('ArrowLeft');
    await page.waitForSelector(`${corner('matrix')} .scene`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForSelector(`${corner('mole')} .pet`);
    await page.keyboard.press('ArrowLeft'); // and round the end of the list: the first one's neighbour is the last
    await page.waitForSelector(`${corner('core')} .scene`);
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector(`${corner('mole')} .pet`);
    await shot('15-companions');
    // quick repeats of an arrow key each take one step from where the focus is, not from the last render
    await page.focus('.companion-card[data-id="mole"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.waitForSelector(`${corner('warp')} .scene`); // mole, matrix, agents, warp
    await setApp({ companion: 'core' });
    await page.waitForSelector(`${corner('core')} .scene`);
    // a value this version does not know (a typo, a variant from a newer one) is the mole
    await setApp({ companion: 'hologram' });
    await page.waitForSelector(`${corner('mole')} .pet`);
    expect(await page.locator('.companion-card.on').count()).toBe(1);
    // the switch still turns the whole thing off, whatever is chosen
    await setApp({ companion: 'core' });
    await page.waitForSelector(`${corner('core')} .scene`);
    await page.locator('label.field', { hasText: 'Companion' }).locator('.switch').click();
    await until(async () => (await page.locator('.pet-corner').count()) === 0, 5_000, 'the companion to leave');
    expect(await page.getAttribute('.companions', 'data-off')).toBe('');
    await page.locator('label.field', { hasText: 'Companion' }).locator('.switch').click();
    await page.waitForSelector(`${corner('core')} .scene`);
    await setApp({ companion: 'mole' });
    await page.waitForSelector(`${corner('mole')} .pet`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  }, 60_000);

  it('the scenes: each one works while Claude works, shows an agent for every helper, stays in its corner, and stands still without motion', async () => {
    const setCompanion = (companion: string) => page.evaluate((c) => window.jaffer.call('config.patch', { appearance: { companion: c } }), companion);
    const cs = (sel: string, prop: string) => page.$eval(sel, (el, p) => (getComputedStyle(el) as any)[p as string], prop);
    const endAll = async () => {
      for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    };
    const push = (ages: number[]) =>
      page.evaluate((a) => {
        const now = Date.now();
        (window as any).__event('claude.state', {
          sessions: [{ id: 'scene-1', state: 'working', since: now - 10_000, subagents: (a as number[]).map((age, i) => ({ id: `s${i}`, type: 'Explore', status: 'running', startedAt: now - age })) }],
        });
      }, ages);
    // what moves while it digs, per scene
    const moving: Record<string, [string, string]> = {
      matrix: ['.mx-col', 'mx-fall'],
      agents: ['.ag-packet', 'ag-send'],
      warp: ['.ws-star', 'ws-fly'],
      radar: ['.rd-sweep', 'rd-spin'],
      core: ['.co-ring.outer', 'rd-spin'],
    };
    try {
      await endAll();
      await sleep(600);
      for (const [variant, [probe, keyframes]] of Object.entries(moving)) {
        await setCompanion(variant);
        const scene = `.pet-corner[data-companion='${variant}'] .scene`;
        await page.waitForSelector(scene);
        await until(async () => (await page.getAttribute(scene, 'data-mood')) === 'sleep', 8_000, `${variant}: asleep when nothing runs`);
        expect(await page.getAttribute(scene, 'data-agents')).toBe('0');
        // Claude works with two agents in the background
        await push([5_000, 90_000]);
        await until(async () => (await page.getAttribute(scene, 'data-mood')) === 'dig', 8_000, `${variant}: working`);
        await until(async () => (await page.getAttribute(scene, 'data-agents')) === '2', 8_000, `${variant}: an agent for each helper`);
        expect(await cs(probe, 'animationName'), variant).toContain(keyframes);
        expect(await page.textContent(`${scene} title`), variant).toMatch(/2 background agents working/); // said in words too
        // inside the terminal, and never in the way of a click
        const card = (await page.locator('.terminal-area').boundingBox())!;
        const box = (await page.locator('.pet-corner').boundingBox())!;
        expect(box.x, variant).toBeGreaterThanOrEqual(card.x);
        expect(box.x + box.width, variant).toBeLessThanOrEqual(card.x + card.width + 0.5);
        expect(box.y + box.height, variant).toBeLessThanOrEqual(card.y + card.height + 0.5);
        expect(await cs('.pet-corner', 'pointerEvents'), variant).toBe('none');
        await sleep(400);
        await shot(`15-scene-${variant}`);
        // macOS Reduce motion and the Animations switch: the same picture, standing still
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(parseFloat(String(await cs(probe, 'animationDuration'))), variant).toBeLessThan(0.001);
        await page.emulateMedia({ reducedMotion: null });
        await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: false } }));
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
        expect(await page.getAttribute(scene, 'data-mood'), variant).toBe('dig');
        expect(await cs(probe, 'animationName'), variant).toBe('none');
        await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: true } }));
        await endAll();
        await until(async () => (await page.getAttribute(scene, 'data-agents')) === '0', 8_000, `${variant}: the helpers to leave`);
        await sleep(300);
      }
    } finally {
      await page.emulateMedia({ reducedMotion: null });
      await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: true, companion: 'mole' } }));
    }
    await page.waitForSelector(".pet-corner[data-companion='mole'] .pet");
  }, 120_000);

  it('the scenes show it when Claude needs you and when a turn ends (the same moods as the mole)', async () => {
    const mood = () => page.getAttribute('.pet-corner .scene', 'data-mood');
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'agents' } }));
    try {
      await page.waitForSelector(".pet-corner[data-companion='agents'] .scene");
      await until(async () => (await mood()) === 'sleep', 8_000, 'asleep to start with');
      const bash = { session_id: 'scene-2', tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 's1' };
      await sendHook('PreToolUse', bash);
      await sendHook('Notification', { session_id: 'scene-2', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
      await until(async () => (await mood()) === 'alert', 8_000, 'the scene to ask for you');
      expect(await page.textContent('.pet-corner .scene title')).toMatch(/needs you/);
      await sleep(250);
      await shot('15-scene-alert');
      await sendHook('PostToolUse', bash);
      await sendHook('Stop', { session_id: 'scene-2', last_assistant_message: 'done' });
      await until(async () => (await mood()) === 'cheer', 8_000, 'the scene to celebrate');
      await sleep(150);
      await shot('15-scene-cheer');
      await sendHook('SessionEnd', { session_id: 'scene-2' });
      await until(async () => (await mood()) === 'sleep', 8_000, 'the scene to settle');
    } finally {
      await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole' } }));
    }
    await page.waitForSelector(".pet-corner[data-companion='mole'] .pet");
  }, 60_000);

  it('what each answer cost: a quiet figure in the title bar after every answer, with the session total, and Settings turns it off', async () => {
    fs.mkdirSync(shots, { recursive: true });
    const transcript = path.join(shots, 'cost-transcript.jsonl');
    const reply = (id: string, usage: object) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage } })}\n`;
    fs.writeFileSync(transcript, '');
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    const chip = '[data-cost-chip]';
    const answer = async (usage: object, id: string) => {
      const base = { session_id: 'cost-1', transcript_path: transcript };
      await sendHook('UserPromptSubmit', { ...base, prompt: 'go' });
      fs.appendFileSync(transcript, reply(id, usage));
      await sendHook('Stop', { ...base, last_assistant_message: 'done' });
    };
    expect(await page.locator(chip).count()).toBe(0); // nothing to say before the first answer
    // (1000 × 2 + 2000 × 10 + 100000 × 0.2) / 1e6 = $0.042
    await answer({ input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100_000 }, 'c1');
    await until(async () => /≈ \$0\.04/.test((await page.locator(chip).textContent()) ?? ''), 8_000, 'the cost of the first answer');
    let tip = (await page.locator(chip).getAttribute('title')) ?? '';
    expect(tip).toMatch(/This answer ≈ \$0\.04: 1k new in, 100k cached, 2k out/);
    expect(tip).toMatch(/This session ≈ \$0\.04 over 1 answer\b/);
    expect(tip).toMatch(/not billed per token/); // it says what the figure is, and what it is not
    expect(await page.locator(chip).evaluate((el) => getComputedStyle(el).animationName)).toContain('cost-flash'); // it lights up for a moment
    await sleep(900);
    await shot('14h-cost');
    // the next answer replaces the figure and adds to the session
    await answer({ input_tokens: 0, output_tokens: 100_000 }, 'c2'); // $1.00
    await until(async () => /≈ \$1\.00/.test((await page.locator(chip).textContent()) ?? ''), 8_000, 'the cost of the second answer');
    tip = (await page.locator(chip).getAttribute('title')) ?? '';
    expect(tip).toMatch(/This session ≈ \$1\.04 over 2 answers/);
    // the title bar stays aligned with the chip in it, at the narrowest window too
    for (const w of [1360, 660]) {
      await page.setViewportSize({ width: w, height: 860 });
      await sleep(250);
      const pill = (await page.locator('.session-pill').boundingBox())!;
      const right = (await page.locator('.tb-right').boundingBox())!;
      expect(pill.x + pill.width, `pill clear of the right side at ${w}px`).toBeLessThanOrEqual(right.x + 1);
      expect(right.x + right.width, `right side inside the window at ${w}px`).toBeLessThanOrEqual(w);
    }
    await page.setViewportSize({ width: 1360, height: 860 });
    // switched off in Settings: gone, and the next answer does not bring it back
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Claude Code' }).click();
    await page.locator('label.field', { hasText: 'Show what each answer cost' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).claude.showCost === false, 8_000, 'the cost to be switched off');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await until(async () => (await page.locator(chip).count()) === 0, 8_000, 'the figure to leave');
    await answer({ input_tokens: 10, output_tokens: 10 }, 'c3');
    await sleep(1000);
    expect(await page.locator(chip).count()).toBe(0);
    await page.evaluate(() => window.jaffer.call('config.patch', { claude: { showCost: true } }));
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
  }, 90_000);

  it('Settings: no label wraps a button, focus goes into the dialog and back, Open at login tells the truth, the colour scheme follows the theme', async () => {
    const dialogFocused = () => page.evaluate(() => !!document.activeElement?.closest('.modal'));
    const nav = (name: string) => page.locator('.settings-nav button', { hasText: name }).click();
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await until(dialogFocused, 3_000, 'the keyboard to move into the dialog'); // the terminal does not keep it behind the dialog
    for (const section of ['Appearance', 'Claude Code', 'Updates', 'Reset']) {
      await nav(section);
      // a <label> around a button forwards a click on its words to the button: "Reinstall" or "Reset…" by a stray click
      expect(await page.locator('label.field:has(button)').count(), section).toBe(0);
    }
    // "Claude finished" notifications are on until switched off (the notification itself is the main process's; the switch is the setting)
    await nav('Claude Code');
    const finishedSwitch = page.locator('label.field', { hasText: 'Tell me when Claude finishes' });
    const notif = async () => (await page.evaluate(() => window.jaffer.call('config.get'))).notifications.claudeFinished;
    expect(await finishedSwitch.locator('input').isChecked()).toBe(true);
    await finishedSwitch.locator('.switch').click();
    await until(async () => (await notif()) === false, 5_000, 'the finished notification to be switched off');
    await finishedSwitch.locator('.switch').click();
    await until(async () => (await notif()) === true, 5_000, 'and on again');
    await nav('Appearance');
    // there is no switch for keeping the screen: nothing of it is saved
    expect(await page.locator('label.field', { hasText: 'Keep the screen' }).count()).toBe(0);
    const login = () => page.locator('label.field', { hasText: 'Open at login' }).locator('input');
    expect(await login().isChecked()).toBe(false);
    await page.locator('label.field', { hasText: 'Open at login' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => (window as any).__loginItem)) === true, 5_000, 'the login item to be set');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await until(async () => page.evaluate(() => !!document.activeElement?.closest('.term')), 5_000, 'the keyboard to go back to the terminal');
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await until(async () => login().isChecked(), 5_000, 'the switch to show what is true after reopening');
    await page.locator('label.field', { hasText: 'Open at login' }).locator('.switch').click(); // back off
    await until(async () => (await page.evaluate(() => (window as any).__loginItem)) === false, 5_000, 'the login item to be cleared');
    // native controls follow the theme
    const scheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    expect(await scheme()).toBe('dark');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-light' } }));
    await until(async () => (await scheme()) === 'light', 5_000, 'the colour scheme to follow the light theme');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-dark' } }));
    await until(async () => (await scheme()) === 'dark', 5_000, 'and the dark one');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  }, 60_000);

  it('Settings: "Keep my Mac awake while Claude works" is on by default, writes session.stayAwake, sits after the global hotkey and says what it cannot do', async () => {
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Appearance' }).click();
    const awake = page.locator('label.field', { hasText: 'Keep my Mac awake while Claude works' });
    const stayAwake = async () => (await page.evaluate(() => window.jaffer.call('config.get'))).session.stayAwake;
    expect(await awake.count()).toBe(1);
    expect(await stayAwake()).toBe(true);
    expect(await awake.locator('input').isChecked()).toBe(true);
    // right after "Global hotkey" comes this one (there is no switch for keeping the session running in the background any more)
    const next = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('.settings .field')];
      return fields[fields.findIndex((f) => f.textContent?.includes('Global hotkey')) + 1]?.textContent ?? '';
    });
    expect(await page.locator('label.field', { hasText: 'Keep my session running in the background' }).count()).toBe(0);
    expect(next).toContain('Keep my Mac awake while Claude works');
    // the hint says what it does and what it does not do (a closed lid)
    const hint = (await awake.textContent()) ?? '';
    expect(hint).toContain('your Mac does not go to sleep on its own');
    expect(hint).toContain('the screen still can');
    expect(hint).toContain('closed-display');
    await awake.locator('.switch').click();
    await until(async () => (await stayAwake()) === false, 5_000, 'staying awake to be switched off');
    expect(await awake.locator('input').isChecked()).toBe(false);
    await awake.locator('.switch').click();
    await until(async () => (await stayAwake()) === true, 5_000, 'and on again');
    expect(await awake.locator('input').isChecked()).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  }, 60_000);

  it('a program in the terminal can put text on the clipboard (OSC 52) but never read what you copied', async () => {
    await page.evaluate(() => {
      const clip = { reads: 0, written: [] as string[] };
      (window as any).__clip = clip;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => (clip.reads++, 'SECRET-CLIPBOARD'), writeText: async (t: string) => void clip.written.push(t) } });
    });
    await page.click('.term');
    await page.keyboard.press('Control+c');
    // asking for the clipboard: the program gets nothing, and the page never reads it
    await page.keyboard.type("printf '\\033]52;c;?\\a'; echo ASKED");
    await page.keyboard.press('Enter');
    await until(async () => /^ASKED/m.test(await termText()), 8_000, 'the query to have been sent');
    await sleep(500);
    expect(await page.evaluate(() => (window as any).__clip.reads)).toBe(0);
    expect(await termText()).not.toContain('U0VDUkVULUNMSVBCT0FSRA'); // base64 of the secret, which the old provider typed back into the shell
    // putting text there works, as over ssh
    await page.keyboard.type("printf '\\033]52;c;%s\\a' \"$(printf 'copied by a script' | base64)\"; echo COPIED");
    await page.keyboard.press('Enter');
    await until(async () => (await page.evaluate(() => (window as any).__clip.written as string[])).includes('copied by a script'), 8_000, 'the text to reach the clipboard');
  }, 60_000);

  // Command blocks (spec features 7, 8, 22, 24, 26, 27): the renderer reads bash's real shell marks.
  const menu = (id: string) => page.evaluate((m) => (window as any).__menu(m), id);
  const enter = async (line: string) => {
    await page.keyboard.type(line, { delay: 4 });
    await page.keyboard.press('Enter');
  };
  type ShownBlock = { id: number; promptLine: number; outputStart?: number; outputEnd?: number; cmd?: string; exit?: number | null; endedAt?: number };
  const blocks = (): Promise<ShownBlock[]> => page.evaluate(() => (window as any).__jaffer.blocks());
  const ended = (cmd: string) => until(async () => (await blocks()).find((b) => b.cmd === cmd && b.endedAt !== undefined), 10_000, `the block of ${cmd}`);
  const markOf = async (cmd: string) => page.locator(`.xterm-decoration.gutter-mark[data-block="${(await ended(cmd)).id}"]`);
  const viewTop = () => page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.buffer.active.viewportY as number);
  const shownMarks = () => page.$$eval('.xterm-decoration.gutter-mark', (els) => els.filter((e) => (e as HTMLElement).style.display !== 'none').length);
  const toastSaid = (text: string) => until(async () => (await page.locator('.toast-text', { hasText: text }).count()) > 0, 5_000, `a toast saying ${text}`);

  it('command blocks: a mark beside every command (green when it worked, red when it failed), its times on hover, its output lit on hover and selected on a click', async () => {
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await enter('echo hi-block'); // (no clearing the screen first: a later test finds this session's earlier output after a reload)
    await ended('echo hi-block'); // (typed ahead, the next command would be echoed into this one's output)
    await enter('false');
    await until(async () => (await (await markOf('false')).count()) === 1, 10_000, 'a mark for the failed command');
    const ok = await markOf('echo hi-block');
    expect(await ok.getAttribute('data-state')).toBe('ok');
    expect(await (await markOf('false')).getAttribute('data-state')).toBe('fail');
    // hovering says when it started and how long it took, and never names the command
    const tip = (await ok.getAttribute('title')) ?? '';
    expect(tip).toMatch(/^Started \d\d:\d\d:\d\d · took \d+ ?(ms|s|min)$/);
    expect(tip).not.toContain('echo');
    // the mark sits in the gutter, left of the text
    const markBox = (await ok.boundingBox())!;
    const screenBox = (await page.locator('.term .xterm-screen').boundingBox())!;
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(screenBox.x + 0.5);
    expect(markBox.x).toBeGreaterThanOrEqual((await page.locator('.terminal-area').boundingBox())!.x);
    await ok.hover();
    await until(async () => (await page.locator('.xterm-decoration.block-hl').count()) === 1, 3_000, 'the output to light up');
    await shot('16-command-blocks');
    await page.mouse.move(700, 420);
    await until(async () => (await page.locator('.xterm-decoration.block-hl').count()) === 0, 3_000, 'the light to go');
    await ok.click();
    expect(await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.getSelection().trim())).toBe('hi-block');
  }, 40_000);

  it('the gutter menu: copy the command (never a sensitive one), copy the output, save it, copy it as Markdown; ⌥⌘C copies a selection fenced', async () => {
    await page.evaluate(() => {
      const clip = { written: [] as string[] };
      (window as any).__blockClip = clip;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t: string) => void clip.written.push(t) } });
    });
    const lastCopied = () => page.evaluate(() => ((window as any).__blockClip.written as string[]).at(-1));
    const pick = async (cmd: string, item: string) => {
      await (await markOf(cmd)).click({ button: 'right' });
      await page.waitForSelector('.ctx-menu');
      await page.locator('.ctx-menu button', { hasText: item }).click();
      await page.waitForSelector('.ctx-menu', { state: 'detached' });
    };
    await (await markOf('echo hi-block')).click({ button: 'right' });
    await page.waitForSelector('.ctx-menu');
    expect(await page.$$eval('.ctx-menu button', (b) => b.map((x) => x.textContent))).toEqual(['Copy command', 'Copy output', 'Save output…', 'Copy as Markdown']);
    await shot('17-gutter-menu');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ctx-menu', { state: 'detached' });

    await pick('echo hi-block', 'Copy command');
    await until(async () => (await lastCopied()) === 'echo hi-block', 3_000, 'the command on the clipboard');
    await toastSaid('Copied');
    await pick('echo hi-block', 'Copy output');
    await until(async () => (await lastCopied()) === 'hi-block', 3_000, 'the output on the clipboard');
    await pick('echo hi-block', 'Save output…');
    await until(async () => page.evaluate(() => (window as any).__saved?.length === 1), 3_000, 'the save');
    expect(await page.evaluate(() => (window as any).__saved[0])).toEqual({ text: 'hi-block', name: 'echo-output.txt' });
    await pick('echo hi-block', 'Copy as Markdown');
    await until(async () => (await lastCopied()) === '```\n$ echo hi-block\nhi-block\n```', 3_000, 'the Markdown on the clipboard');
    await toastSaid('Copied as Markdown');

    // a sensitive command is not offered for copying, and not named in the Markdown either
    await page.click('.term');
    await enter('echo $NO_SUCH_TOKEN');
    await (await markOf('echo $NO_SUCH_TOKEN')).click({ button: 'right' });
    await page.waitForSelector('.ctx-menu');
    expect(await page.$$eval('.ctx-menu button', (b) => b.map((x) => x.textContent))).toEqual(['Copy output', 'Save output…', 'Copy as Markdown']);
    await page.mouse.click(700, 420); // a click elsewhere closes it
    await page.waitForSelector('.ctx-menu', { state: 'detached' });
    await pick('echo $NO_SUCH_TOKEN', 'Copy as Markdown');
    await until(async () => (await lastCopied()) === '```\n\n```', 3_000, 'the Markdown without the command');

    // ⌥⌘C: a selection inside one block's output gets its command as the first line
    await (await markOf('echo hi-block')).click();
    await menu('copy-markdown');
    await until(async () => (await lastCopied()) === '```\n$ echo hi-block\nhi-block\n```', 3_000, 'the selection as Markdown');
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.clearSelection());
    await menu('copy-markdown');
    await toastSaid('Select something first');
  }, 60_000);

  it('⌘↑ / ⌘↓ jump between prompts; scrolled up into a long output, its command stays pinned on top, and a click goes to its prompt', async () => {
    await page.click('.term');
    await enter('seq 1 300');
    const seq = await ended('seq 1 300');
    const before = (await blocks()).filter((b) => b.promptLine < seq.promptLine).at(-1)!;
    expect(await page.locator('.sticky-cmd').count()).toBe(0); // at the bottom, nothing is pinned
    await menu('prompt-prev');
    expect(await viewTop()).toBe(seq.promptLine);
    await menu('prompt-prev');
    expect(await viewTop()).toBe(before.promptLine);
    await menu('prompt-next');
    expect(await viewTop()).toBe(seq.promptLine);
    await page.evaluate((line) => (window as any).__jaffer.terminals.get('main').term.scrollToLine(line), seq.outputStart! + 120);
    await page.waitForSelector('.sticky-cmd');
    expect(await page.textContent('.sticky-cmd')).toContain('seq 1 300');
    expect(await page.getAttribute('.sticky-cmd', 'data-state')).toBe('ok');
    await shot('18-sticky-header');
    await page.click('.sticky-cmd');
    expect(await viewTop()).toBe(seq.promptLine);
    await page.waitForSelector('.sticky-cmd', { state: 'detached' });
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.scrollToBottom());
    // the palette has them too
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('prompt');
    expect(await page.textContent('.palette-list')).toMatch(/Previous prompt[\s\S]*Next prompt|Next prompt[\s\S]*Previous prompt/);
    await page.keyboard.press('Escape');
  }, 40_000);

  it('command blocks stand aside in the alternate screen, and Settings → Terminal → Command blocks switches them all off and on', async () => {
    await page.click('.term');
    await enter('echo alt-before-80');
    await until(async () => (await shownMarks()) >= 1, 5_000, 'a mark on the screen');
    await enter("printf '\\033[?1049h'"); // a full-screen program (Claude Code, vim) takes the alternate screen
    await until(async () => (await shownMarks()) === 0, 5_000, 'the marks to stand aside');
    expect(await page.locator('.sticky-cmd').count()).toBe(0);
    await enter("printf '\\033[?1049l'");
    await until(async () => (await shownMarks()) >= 1, 5_000, 'the marks back');

    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Terminal' }).click();
    const field = page.locator('label.field', { hasText: 'Command blocks' });
    expect(await field.locator('input').isChecked()).toBe(true);
    await field.locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).terminal.blocks === false, 5_000, 'the switch to be saved');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await until(async () => (await page.locator('.xterm-decoration.gutter-mark').count()) === 0, 5_000, 'every mark gone');
    await page.click('.term');
    await enter('echo blocks-off-81');
    await until(async () => /^blocks-off-81/m.test(await termText()), 8_000, 'the output');
    await sleep(400);
    expect(await page.locator('.xterm-decoration.gutter-mark').count()).toBe(0);
    expect(await blocks()).toEqual([]);
    const top = await viewTop();
    await menu('prompt-prev');
    expect(await viewTop()).toBe(top);

    await page.evaluate(() => window.jaffer.call('config.patch', { terminal: { blocks: true } }));
    await sleep(300);
    await enter(''); // blocks start at the next prompt: the one already on the screen was printed while they were off
    await enter('echo blocks-on-82');
    expect(await (await markOf('echo blocks-on-82')).getAttribute('data-state')).toBe('ok');
  }, 60_000);

  it('Settings → Claude Code: the cost switch, and nothing about resuming or restarting Claude Code', async () => {
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    try {
      await page.locator('.settings-nav button', { hasText: 'Claude Code' }).click();
      await page.waitForSelector('.settings label.field >> text=Show what each answer cost');
      const fields = await page.evaluate(() => [...document.querySelectorAll('.settings .field')].map((f) => f.textContent ?? ''));
      // 0.6.0: no Resume button, so no switch for offering it, and no Restart Claude Code
      expect(fields.filter((t) => /resum|automatically|by itself|Restart Claude Code/i.test(t))).toEqual([]);
      expect(await page.locator('.settings button', { hasText: 'Restart Claude Code' }).count()).toBe(0);
      expect(await page.locator('label.field', { hasText: 'Show what each answer cost' }).count()).toBe(1);
      // the notification switch, then the cost
      const at = (s: string) => fields.findIndex((t) => t.includes(s));
      expect(at('Tell me when Claude finishes')).toBeGreaterThanOrEqual(0);
      expect(at('Show what each answer cost')).toBe(at('Tell me when Claude finishes') + 1);
    } finally {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.settings', { state: 'detached' });
    }
  }, 30_000);

  it('command palette runs actions', async () => {
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    // there is one Claude and it lives in the terminal: the palette has no "ask Claude" and no chat commands
    expect(await page.getAttribute('.palette input', 'placeholder')).not.toMatch(/ask claude/i);
    await page.keyboard.type('claude');
    const found = (await page.textContent('.palette-list')) ?? '';
    expect(found).toContain('Run Claude Code in the terminal');
    expect(found).not.toMatch(/Ask Claude|compact the conversation/i);
    expect(found).not.toMatch(/Resume|Restart Claude Code/i); // (0.6.0: the person runs `claude --resume` themselves)
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
    expect(await page.$$eval('.settings-nav button', (b) => b.map((x) => x.textContent?.trim()))).toEqual(['Appearance', 'Terminal', 'Claude Code', 'Updates', 'Reset']);
    // Jaffer runs on a Claude subscription: no API key to enter and no engine to pick, in any section
    for (const section of ['Appearance', 'Claude Code']) {
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

  // A shell that exits is replaced by a fresh one, and the window starts over with it. The fresh shell's output counts from 1 again: a
  // window that kept the old shell's count (this one re-attached after a lot of output, just above) would drop it and keep the old screen.
  // (Here it depends on running after the reload test above; the daemon test of the `pty.reset` after a replaced shell, in test/daemon.test.ts, is the reliable guard.)
  it('after `exit` the window shows the fresh shell: the old screen is gone, and what the new shell prints shows', async () => {
    // (typed as the window types, straight to the shell: a key pressed just after the page loaded can miss the terminal; Ctrl+U first
    // clears whatever an earlier test may have left on the line)
    const type = (text: string) => page.evaluate((data) => window.jaffer.call('pty.write', { data }), `\x15${text}\r`);
    await type('echo before-the-exit-71');
    await until(async () => /^before-the-exit-71/m.test(await termText()), 10_000, 'the marker');
    const before = (await page.evaluate(() => window.jaffer.call('pane.list')))[0].pid;
    await type('exit');
    await until(async () => {
      const p = (await page.evaluate(() => window.jaffer.call('pane.list')))[0];
      return p?.alive && p.pid !== before;
    }, 10_000, 'a fresh shell');
    await until(async () => !(await termText()).includes('before-the-exit-71'), 10_000, 'the old screen to go');
    await sleep(800);
    await type('echo after-the-exit-72');
    await until(async () => /^after-the-exit-72/m.test(await termText()), 10_000, 'the fresh shell to answer on the screen');
    expect(await termText()).not.toContain('before-the-exit-71');
  }, 40_000);

  it('the layout lines up at any window size: the pill is centred in the title bar and on the window, the card has even margins, the mole sits inside, nothing overflows', async () => {
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const cy = (b: { y: number; height: number }) => b.y + b.height / 2;
    const cx = (b: { x: number; width: number }) => b.x + b.width / 2;
    const measure = async (w: number, h: number) => {
      const bar = await box('.titlebar');
      const pill = await box('.session-pill');
      const card = await box('.terminal-area');
      const pet = await box('.pet-corner');
      const where = `${w}x${h}`;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5), `no sideways scroll at ${where}`).toBe(true);
      expect(Math.abs(cy(pill) - cy(bar)), `pill centred in the title bar at ${where}`).toBeLessThan(1.5);
      expect(Math.abs(cx(pill) - w / 2), `pill centred on the window at ${where}`).toBeLessThan(2);
      const left = card.x;
      const bottom = h - (card.y + card.height);
      expect(Math.abs(left - bottom), `card margins even (left ${left}, bottom ${bottom}) at ${where}`).toBeLessThan(1.5);
      expect(pet.x + pet.width, `mole inside the card at ${where}`).toBeLessThanOrEqual(card.x + card.width);
      expect(pet.y + pet.height, `mole inside the card at ${where}`).toBeLessThanOrEqual(card.y + card.height);
      expect(Math.abs(w - (card.x + card.width) - left), `right margin equals the left one at ${where}`).toBeLessThan(1.5);
    };
    for (const [w, h] of [[1360, 860], [900, 640], [660, 520]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(200);
      await measure(w, h);
      if (w < 1000) await shot(`15-layout-${w}`);
    }
    await page.setViewportSize({ width: 1360, height: 860 });
  });

  it('when the terminal stops the window says so (the app offers a fresh one or Quit), and a fresh terminal clears it', async () => {
    expect(await page.locator('.daemon-banner').count()).toBe(0);
    await page.evaluate(() => (window as any).__event('daemon.down', {}));
    await page.waitForSelector('.daemon-banner');
    expect(await page.textContent('.daemon-banner')).toBe('The terminal stopped.');
    expect(await page.textContent('.daemon-banner')).not.toMatch(/reconnect|session/i);
    await page.evaluate(() => (window as any).__event('daemon.up', {}));
    await page.waitForSelector('.daemon-banner', { state: 'detached' });
    await page.waitForSelector('.term .xterm');
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
