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
    // 1.0.0 allows command blocks inside the card (gutter marks, the sticky command header, the gutter menu), up to three pinned lines and
    // the paste question; still no sidebar, drawer, panel or tab
    expect(await page.locator('.sidebar, .drawer, .panel, .tabs, .tab').count()).toBe(0);
    expect(await page.$$eval('.terminal-area > *', (els) => els.map((e) => e.className).filter((c) => !/^(panes|pet-corner|sticky-cmd|findbar|pins|paste-bar)\b/.test(c)))).toEqual([]);
    // and the 2 px tool strip under the title bar (feature 6): nothing else between the title bar and the card
    expect(await page.$$eval('.stage > *', (els) => els.map((e) => e.className).filter((c) => !/^(titlebar|tool-strip|daemon-banner|workspace)\b/.test(c)))).toEqual([]);
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
    let tip = (await page.locator('.cost-pop > div').allTextContents()).join('\n'); // (the hover card's lines, not a title attribute: it also carries today and the sparklines)
    expect(tip).toMatch(/This answer ≈ \$0\.04: 1k new in, 100k cached, 2k out/);
    expect(tip).toMatch(/This session ≈ \$0\.04 over 1 answer\b/);
    expect(tip).toMatch(/not billed per token/); // it says what the figure is, and what it is not
    expect(await page.locator(chip).evaluate((el) => getComputedStyle(el).animationName)).toContain('cost-flash'); // it lights up for a moment
    await sleep(900);
    await shot('14h-cost');
    // the next answer replaces the figure and adds to the session
    await answer({ input_tokens: 0, output_tokens: 100_000 }, 'c2'); // $1.00
    await until(async () => /≈ \$1\.00/.test((await page.locator(chip).textContent()) ?? ''), 8_000, 'the cost of the second answer');
    tip = (await page.locator('.cost-pop > div').allTextContents()).join('\n');
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

  // The title bar and Claude (spec features 2, 3, 6, 13–16, 18, 19, 29–33, 35, 36): what the daemon would push, injected.
  const cfgPatch = (p: object) => page.evaluate((x) => window.jaffer.call('config.patch', x), p);
  const endClaude = async () => {
    for (const s of (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions) await sendHook('SessionEnd', { session_id: s.id });
    await sleep(500); // the daemon's own trailing push of those endings must not land on top of what is injected next
  };
  /** A session as the daemon pushes it; times are relative to now (ms ago) where the key ends in `Ago`. */
  const inject = (sessions: Record<string, unknown>[], today?: object) =>
    page.evaluate(
      ([ss, t]) => {
        const now = Date.now();
        const at = (s: Record<string, any>) => {
          const o: Record<string, any> = { since: now, calls: [], counts: {}, files: [], subagents: [], turns: 1, startedAt: now - 60_000 };
          for (const [k, v] of Object.entries(s)) {
            if (k.endsWith('Ago')) o[k.slice(0, -3)] = v === undefined ? undefined : now - (v as number);
            else o[k] = v;
          }
          o.calls = (o.calls as Record<string, any>[]).map((c) => ({ name: c.name, category: c.category, failed: c.failed, startedAt: now - c.startAgo, endedAt: c.endAgo === undefined ? undefined : now - c.endAgo }));
          o.subagents = (o.subagents as Record<string, any>[]).map((a) => ({ id: a.id, status: a.status, startedAt: now - a.startAgo, tool: a.tool }));
          if (o.cost) o.cost = { last: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, usd: o.cost.usd }, totalUsd: o.cost.total ?? o.cost.usd, answers: 1, partial: false, at: o.cost.at };
          return o;
        };
        (window as any).__event('claude.state', { sessions: (ss as Record<string, any>[]).map(at), today: t });
      },
      [sessions, today] as const,
    );
  const token = (name: string) =>
    page.evaluate((n) => {
      const d = document.createElement('div');
      d.style.color = `var(${n})`;
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    }, name);
  const stubClaude = async () => {
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await page.keyboard.type('claude() { sleep 90; }', { delay: 4 });
    await page.keyboard.press('Enter');
    await sleep(300);
    await page.keyboard.type('claude', { delay: 4 });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.session-pill .running[data-kind="claude"]');
  };
  const unstubClaude = async () => {
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await until(async () => !(await page.$('.session-pill .running')), 10_000, 'the stub to end');
    await page.keyboard.type('unset -f claude', { delay: 4 });
    await page.keyboard.press('Enter');
    await sleep(300);
  };
  const toastCount = (text: string) => page.locator('.toast-text', { hasText: text }).count();
  const textOf = (sel: string) => page.evaluate((x) => document.querySelector(x)?.textContent ?? null, sel); // (no waiting for it to appear)

  it('the ring fills against the typical turn, stays full and pulses past it, turns dotted while compacting (one toast), and its tooltip tells the session clock and the running agents', async () => {
    const ring = '.session-pill .running .spinner';
    const cs = (prop: string) => page.$eval(ring, (el, p) => (getComputedStyle(el) as any)[p as string], prop);
    await endClaude();
    await cfgPatch({ claude: { typicalTurnMs: 60_000 } });
    await stubClaude();
    try {
      const base = { id: 'ring-1', state: 'working', startedAtAgo: 42 * 60_000 + 5_000, turns: 9 };
      // half way through a typical turn: half full, and it does not spin
      await inject([{ ...base, turnStartedAtAgo: 30_000 }]);
      await page.waitForSelector(`${ring}[data-progress]`);
      const p = Number(await page.$eval(ring, (el) => (el as HTMLElement).style.getPropertyValue('--p')));
      expect(p).toBeGreaterThan(0.45);
      expect(p).toBeLessThan(0.6);
      expect(await cs('backgroundImage')).toContain('conic-gradient');
      expect(await cs('animationName')).not.toContain('spin');
      // it fills as time goes by (its own one-second clock while Claude works)
      await until(async () => Number(await page.$eval(ring, (el) => (el as HTMLElement).style.getPropertyValue('--p'))) > p, 4_000, 'the ring to fill on');
      await shot('26-ring-progress');
      // past the typical length: full, and it pulses
      await inject([{ ...base, turnStartedAtAgo: 90_000 }]);
      await until(async () => (await page.$(`${ring}[data-full]`)) !== null, 4_000, 'a full ring');
      expect(await cs('animationName')).toContain('ring-pulse');
      await cfgPatch({ appearance: { animations: false } });
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
      expect(await cs('animationName')).toBe('none');
      await cfgPatch({ appearance: { animations: true } });
      // the tooltip: the session clock, the cost (only with showCost), the running agents (never their ids)
      await inject([{ ...base, turnStartedAtAgo: 10_000, cost: { usd: 0.2, total: 1.2, at: 1 }, subagents: [{ id: 'agent-secret-id-7', status: 'running', startAgo: 130_000 }, { id: 'done-1', status: 'done', startAgo: 10_000 }] }]);
      await until(async () => /Claude · 42 min · 9 turns · ≈ \$1\.20/.test((await page.getAttribute('.session-pill .running', 'title')) ?? ''), 4_000, 'the session clock');
      let tip = (await page.getAttribute('.session-pill .running', 'title')) ?? '';
      expect(tip).toMatch(/Agent 1 · 2m 1\ds/);
      expect(tip).not.toMatch(/Agent 2|secret|done-1/);
      await cfgPatch({ claude: { showCost: false } });
      await until(async () => !/≈/.test((await page.getAttribute('.session-pill .running', 'title')) ?? ''), 4_000, 'the cost to leave the tooltip');
      await cfgPatch({ claude: { showCost: true } });
      // no typical length yet: a plain spin
      await cfgPatch({ claude: { typicalTurnMs: 0 } });
      await until(async () => (await page.$(`${ring}[data-progress]`)) === null, 4_000, 'no progress without a typical turn');
      expect(await cs('animationName')).toContain('spin');
      // compacting: dotted, and one toast for it (not one per push)
      // a session first seen already compacting (or after a switch) says nothing: only a change says something
      const before = await toastCount('Claude is compacting its context');
      await inject([{ ...base, id: 'ring-2', state: 'idle', compacting: true }]);
      await until(async () => (await cs('borderTopStyle')) === 'dotted', 4_000, 'a dotted ring for the new session');
      await sleep(300);
      expect(await toastCount('Claude is compacting its context')).toBe(before);
      await inject([{ ...base, state: 'idle' }]);
      await inject([{ ...base, state: 'idle', compacting: true }]);
      await until(async () => (await cs('borderTopStyle')) === 'dotted', 4_000, 'a dotted ring');
      await until(async () => (await toastCount('Claude is compacting its context')) === before + 1, 4_000, 'the compacting toast');
      await inject([{ ...base, state: 'idle', compacting: true, turns: 10 }]);
      await sleep(300);
      expect(await toastCount('Claude is compacting its context')).toBe(before + 1);
      await inject([{ ...base, state: 'idle' }]);
      await until(async () => (await page.$(ring)) === null, 4_000, 'the ring to go back to a dot when compacting ends');
    } finally {
      await inject([]);
      await cfgPatch({ claude: { typicalTurnMs: 0, showCost: true }, appearance: { animations: true } });
      await unstubClaude();
    }
  }, 60_000);

  it('the tool strip: this turn’s calls under the title bar, coloured by kind, as wide as they took, failures red, the name and time on hover; Settings switches it off', async () => {
    await endClaude();
    const seg = '.tool-strip .ts-seg';
    const work = (await page.locator('.workspace').boundingBox())!;
    expect(await page.locator('.tool-strip').count()).toBe(1); // its 2 px are kept even when empty: nothing moves when it fills
    expect(await page.locator(seg).count()).toBe(0);
    const calls = [
      { name: 'Read', category: 'read', startAgo: 60_000, endAgo: 59_000 }, // the last prompt's: not this turn
      { name: 'Read', category: 'read', startAgo: 19_000, endAgo: 15_000 },
      { name: 'Bash', category: 'shell', startAgo: 15_000, endAgo: 10_000, failed: true },
      { name: 'Edit', category: 'write', startAgo: 10_000, endAgo: 9_000 },
      { name: 'WebFetch', category: 'web', startAgo: 9_000, endAgo: 8_000 },
      { name: 'Task', category: 'agent', startAgo: 8_000, endAgo: 7_000 },
      { name: 'mcp__x__y', category: 'other', startAgo: 5_000 }, // running
    ];
    await inject([{ id: 'strip-1', state: 'working', turnStartedAtAgo: 20_000, calls }]);
    await until(async () => (await page.locator(seg).count()) === 6, 4_000, 'six segments');
    expect(await page.$$eval(seg, (els) => els.map((e) => (e as HTMLElement).dataset.cat))).toEqual(['read', 'shell', 'write', 'web', 'agent', 'other']);
    const bg = (i: number) => page.locator(seg).nth(i).evaluate((e) => getComputedStyle(e, '::before').backgroundColor); // (the 2 px bar; the segment is its taller hover target)
    expect(await bg(0)).toBe(await token('--branch'));
    expect(await bg(1)).toBe(await token('--danger')); // the failed Bash
    expect(await bg(2)).toBe(await token('--accent'));
    expect(await bg(3)).toBe(await token('--violet'));
    expect(await bg(4)).toBe(await token('--ok'));
    expect(await page.locator(seg).nth(1).getAttribute('title')).toBe('Bash · 5.0 s · failed');
    expect(await page.locator(seg).nth(0).getAttribute('title')).toBe('Read · 4.0 s');
    const w = async (i: number) => (await page.locator(seg).nth(i).boundingBox())!.width;
    expect(await w(1)).toBeGreaterThan((await w(2)) * 3); // 5 s against 1 s
    expect(await w(2)).toBeGreaterThanOrEqual(2);
    const strip = (await page.locator('.tool-strip').boundingBox())!;
    expect(strip.height).toBe(2);
    expect((await page.locator('.workspace').boundingBox())!.y).toBe(work.y); // no layout shift
    expect((await page.locator(seg).nth(1).boundingBox())!.height).toBeGreaterThanOrEqual(8); // easier to hover than 2 px, taking no room
    expect(await page.locator(seg).nth(1).evaluate((e) => document.elementFromPoint(e.getBoundingClientRect().x + 3, e.getBoundingClientRect().bottom - 1) === e)).toBe(true);
    await shot('27-tool-strip');
    // the running call grows
    const grow = await w(5);
    await until(async () => (await w(5)) > grow, 4_000, 'the running call to grow');
    // Settings → Claude Code → Tool strip, off: gone
    await cfgPatch({ claude: { toolStrip: false } });
    await until(async () => (await page.locator('.tool-strip').count()) === 0, 4_000, 'the strip to go');
    await cfgPatch({ claude: { toolStrip: true } });
    await page.waitForSelector(seg);
    // more calls than fit: the newest stay in view (the oldest give way), and odd entries are skipped
    const many = Array.from({ length: 600 }, (_, n) => ({ name: `T${n}`, category: 'read', startAgo: 19_000 - n * 10, endAgo: 19_000 - n * 10 - 5 }));
    await inject([{ id: 'strip-2', state: 'working', turnStartedAtAgo: 20_000, calls: many }]);
    await until(async () => (await page.locator(seg).count()) === 600, 4_000, 'six hundred segments');
    const box = (await page.locator('.tool-strip').boundingBox())!;
    const last = (await page.locator(seg).last().boundingBox())!;
    expect(Math.abs(last.x + last.width - (box.x + box.width))).toBeLessThan(1.5); // the newest at the right end
    expect((await page.locator(seg).first().boundingBox())!.x).toBeLessThan(box.x); // the oldest pushed out on the left
    expect(await page.locator(seg).last().evaluate((e) => document.elementFromPoint(e.getBoundingClientRect().x + 1, e.getBoundingClientRect().y + 4) === e)).toBe(true);
    // an ended session shows nothing
    await inject([{ id: 'strip-1', state: 'ended', turnStartedAtAgo: 20_000, calls }]);
    await until(async () => (await page.locator(seg).count()) === 0, 4_000, 'no segments for an ended session');
    await inject([]);
  }, 30_000);

  it('needs-you in the title bar: the tool and the notice (clipped), and how many times that tool asked before', async () => {
    await endClaude();
    const chip = '.session-pill .needs-chip';
    const notice = 'Claude needs your permission to use Bash for something that takes a long sentence to say';
    const ask = { id: 'needs-1', state: 'needs-you', turnStartedAtAgo: 5_000, tool: { name: 'Bash', id: 't1' }, notice };
    await inject([ask]);
    await page.waitForSelector(chip);
    expect(await page.locator(`${chip} .alert-dot`).count()).toBe(1);
    let text = (await page.textContent(chip)) ?? '';
    expect(text).toContain('Bash');
    expect(text).toContain(notice.slice(0, 40));
    expect(text).not.toContain(notice); // clipped
    expect(text).not.toMatch(/time/);
    await shot('28-needs-you');
    // answered (back to working), asked again: the second time
    await inject([{ ...ask, state: 'working' }]);
    await until(async () => (await page.locator(chip).count()) === 0, 4_000, 'the chip to go when answered');
    await inject([ask]);
    await until(async () => /Bash.*· 2nd time/.test((await page.textContent(chip)) ?? ''), 4_000, 'the 2nd time');
    await inject([{ ...ask, state: 'working' }]);
    await inject([ask]);
    await until(async () => /· 3rd time/.test((await page.textContent(chip)) ?? ''), 4_000, 'the 3rd time');
    // another tool counts on its own
    await inject([{ ...ask, state: 'working' }]);
    await inject([{ ...ask, tool: { name: 'Write', id: 't2' }, notice: 'Claude needs your permission to use Write' }]);
    await until(async () => /Write/.test((await page.textContent(chip)) ?? ''), 4_000, 'the Write prompt');
    text = (await page.textContent(chip)) ?? '';
    expect(text).not.toMatch(/time/);
    await inject([]);
  }, 30_000);

  it('the editing chip: the file Claude is writing, beside the ring; a click shows it in Finder', async () => {
    await endClaude();
    await page.evaluate(() => ((window as any).__revealed = []));
    const file = path.join(env.userHome, 'proj', 'src', 'app.ts');
    await inject([{ id: 'edit-1', state: 'working', turnStartedAtAgo: 5_000, file, tool: { name: 'Edit', id: 'e1' } }]);
    await page.waitForSelector('.session-pill .edit-chip');
    expect((await page.textContent('.session-pill .edit-chip'))?.trim()).toBe('app.ts');
    expect(await page.locator('.session-pill .edit-chip svg').count()).toBe(1);
    await page.click('.session-pill .edit-chip');
    expect(await page.evaluate(() => (window as any).__revealed)).toEqual([file]);
    expect(await page.getAttribute('.session-pill .edit-chip', 'title')).not.toMatch(/proj|src\//); // the name only; the full path goes to Finder alone
    await inject([{ id: 'edit-1', state: 'working', turnStartedAtAgo: 5_000 }]);
    await until(async () => (await page.locator('.session-pill .edit-chip').count()) === 0, 4_000, 'the chip to go when the edit is done');
    await inject([]);
  }, 20_000);

  it('a finished turn: a summary toast (how long, what Claude did, the cost once it is known) with the edited files to reveal; none for a short or cut-short turn, or with the switch off', async () => {
    await endClaude();
    await page.evaluate(() => ((window as any).__revealed = []));
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((f) => path.join(env.userHome, 'proj', f));
    const calls = [
      { name: 'Read', category: 'read', startAgo: 70_000, endAgo: 69_000 },
      { name: 'Grep', category: 'read', startAgo: 68_000, endAgo: 67_000 },
      { name: 'Read', category: 'read', startAgo: 66_000, endAgo: 65_000 },
      { name: 'Edit', category: 'write', startAgo: 60_000, endAgo: 59_000 },
      { name: 'Write', category: 'write', startAgo: 50_000, endAgo: 49_000 },
      { name: 'Bash', category: 'shell', startAgo: 40_000, endAgo: 30_000 },
    ];
    const turn = { id: 'sum-1', turnStartedAtAgo: 72_000, calls, files };
    await inject([{ ...turn, state: 'working' }]);
    await inject([{ ...turn, state: 'idle' }]);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // (two frames: a toast shown at once would be on the screen by now)
    expect(await toastCount('Claude finished in')).toBe(0); // it waits a moment for the cost
    await inject([{ ...turn, state: 'idle', cost: { usd: 0.04, at: 77 } }]);
    const summary = 'Claude finished in 1m 12s · 3 reads, 2 edits, 1 shell · ≈ $0.04';
    await until(async () => (await toastCount(summary)) === 1, 15_000, 'the summary toast');
    const toast = page.locator('.toast', { hasText: summary });
    expect(await toast.locator('.toast-act').allTextContents()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    expect(await toast.locator('.toast-note').textContent()).toBe('+1 more');
    await shot('29-turn-summary');
    await toast.locator('.toast-act', { hasText: 'b.ts' }).click();
    expect(await page.evaluate(() => (window as any).__revealed)).toEqual([files[1]]);
    // no cost after 3 s: the summary without it
    const t2 = { id: 'sum-2', turnStartedAtAgo: 15_000, calls: [{ name: 'Read', category: 'read', startAgo: 14_000, endAgo: 13_000 }] };
    await inject([{ ...t2, state: 'working' }]);
    await inject([{ ...t2, state: 'idle' }]);
    await until(async () => (await toastCount('Claude finished in 15s · 1 read')) === 1, 15_000, 'the summary without a cost');
    expect(await toastCount('Claude finished in 15s · 1 read · ≈')).toBe(0);
    // too short, cut short, switched off: nothing
    const quiet = async (t: object, what: string) => {
      const n = await toastCount('Claude finished in');
      await inject([{ ...t, state: 'working' }]);
      await inject([{ ...t, state: 'idle', cost: { usd: 0.5, at: 99 } }]);
      await sleep(600);
      expect(await toastCount('Claude finished in'), what).toBe(n);
    };
    await quiet({ id: 'sum-3', turnStartedAtAgo: 5_000 }, 'a 5 s turn');
    await quiet({ id: 'sum-4', turnStartedAtAgo: 60_000, cutShort: true }, 'a cut-short turn');
    await cfgPatch({ claude: { turnSummary: false } });
    await quiet({ id: 'sum-5', turnStartedAtAgo: 60_000 }, 'the switch off');
    await cfgPatch({ claude: { turnSummary: true } });
    await inject([]);
  }, 90_000);

  it('the cost chip: the live figure greyed while Claude works (only with both switches), the budget colours, and a hover card with today, the estimate and two sparklines', async () => {
    await endClaude();
    const chip = '[data-cost-chip]';
    await inject([{ id: 'live-cost-1', state: 'working', turnStartedAtAgo: 5_000, live: { input: 1000, output: 2000, usd: 0.03, at: 1 } }]);
    await until(async () => (await textOf(chip)) === '≈ $0.03 so far', 4_000, 'the live figure');
    expect(await page.getAttribute(chip, 'data-live')).not.toBeNull();
    await cfgPatch({ claude: { liveCost: false } });
    await until(async () => (await page.locator(chip).count()) === 0, 4_000, 'no live figure with the live switch off');
    await cfgPatch({ claude: { liveCost: true } });
    await page.waitForSelector(chip);
    // three turns finish, each with its cost: the sparklines have something to draw
    for (const [i, usd] of [0.1, 0.4, 0.2].entries()) {
      const t = { id: 'live-cost-1', turnStartedAtAgo: 4_000 + i * 1000 };
      await inject([{ ...t, state: 'working', cost: i ? { usd: 0.1, at: 100 + i } : undefined }]);
      await inject([{ ...t, state: 'idle', cost: { usd, at: 200 + i } }]);
    }
    await until(async () => (await textOf(chip)) === '≈ $0.20', 4_000, 'the last answer’s cost');
    expect(await page.getAttribute(chip, 'data-live')).toBeNull();
    // the budget: warn from 80 %, danger past it
    await cfgPatch({ claude: { dailyBudgetUsd: 1 } });
    await inject([{ id: 'live-cost-1', state: 'idle', cost: { usd: 0.2, at: 202 } }], { usd: 0.85, date: '2026-10-14' });
    await until(async () => (await page.getAttribute(chip, 'class'))?.includes('warn') ?? false, 4_000, 'the warn colour');
    const warn = await token('--warn');
    await until(async () => (await page.$eval(chip, (el) => getComputedStyle(el).color)) === warn, 4_000, 'the chip in the warn colour'); // (after its flash)
    await inject([{ id: 'live-cost-1', state: 'idle', cost: { usd: 0.2, at: 202 } }], { usd: 1.2, date: '2026-10-14' });
    await until(async () => (await page.getAttribute(chip, 'class'))?.includes('danger') ?? false, 4_000, 'the danger colour');
    // the hover card
    await page.hover(chip);
    await page.waitForSelector('.cost-pop', { state: 'visible' });
    const pop = (await page.textContent('.cost-pop')) ?? '';
    expect(pop).toMatch(/Today ≈ \$1\.20 of \$1\.00/);
    expect(pop).toMatch(/an estimate at API list prices/i);
    expect(pop).toMatch(/not billed per token/);
    const paths = await page.$$eval('.cost-pop svg path', (els) => els.map((e) => e.getAttribute('d') ?? ''));
    expect(paths.length).toBe(2);
    for (const d of paths) expect(d).toMatch(/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+){2,}$/);
    await shot('30-cost-card');
    await page.mouse.move(10, 400);
    // no budget: no colour
    await cfgPatch({ claude: { dailyBudgetUsd: 0 } });
    await until(async () => !/warn|danger/.test((await page.getAttribute(chip, 'class')) ?? ''), 4_000, 'no budget colour');
    expect(await page.textContent('.cost-pop')).not.toMatch(/ of \$/);
    // showCost off: no chip at all, live or not
    await cfgPatch({ claude: { showCost: false } });
    await inject([{ id: 'live-cost-2', state: 'working', turnStartedAtAgo: 5_000, live: { input: 1, output: 2, usd: 0.03, at: 1 } }]);
    await sleep(300);
    expect(await page.locator(chip).count()).toBe(0);
    await cfgPatch({ claude: { showCost: true } });
    await inject([]);
  }, 40_000);

  it('the window glow: a pulse while Claude needs you, steady while it works, one flash when a turn ends; none with the switch or Animations off', async () => {
    await endClaude();
    const glow = () => page.getAttribute('.stage', 'data-glow');
    const t = { id: 'glow-1', turnStartedAtAgo: 5_000 };
    expect(await glow()).toBeNull();
    await inject([{ ...t, state: 'working' }]);
    await until(async () => (await glow()) === 'work', 4_000, 'the working glow');
    expect(await page.$eval('.stage', (el) => getComputedStyle(el, '::after').boxShadow)).not.toBe('none');
    await inject([{ ...t, state: 'needs-you', tool: { name: 'Bash', id: 'g1' } }]);
    await until(async () => (await glow()) === 'needs', 4_000, 'the needs-you glow');
    expect(await page.$eval('.stage', (el) => getComputedStyle(el, '::after').animationName)).toContain('glow-pulse');
    await inject([{ ...t, state: 'working' }]);
    await inject([{ ...t, state: 'idle' }]);
    await until(async () => (await glow()) === 'done', 4_000, 'the flash at the end of a turn');
    await until(async () => (await glow()) === null, 4_000, 'the flash to end');
    // Animations off, or the switch off: no glow
    await cfgPatch({ appearance: { animations: false } });
    await inject([{ ...t, state: 'working' }]);
    await sleep(300);
    expect(await glow()).toBeNull();
    await cfgPatch({ appearance: { animations: true, glow: false } });
    await sleep(300);
    expect(await glow()).toBeNull();
    await cfgPatch({ appearance: { glow: true } });
    await until(async () => (await glow()) === 'work', 4_000, 'the glow back');
    await inject([]);
    await until(async () => (await glow()) === null, 4_000, 'no glow without Claude');
  }, 30_000);

  it('the folder pill slides to a new folder (not with Animations off), and shows the repository’s git counts after the branch', async () => {
    const repo = path.join(env.userHome, 'git-pill');
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'a');
    git('add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'b');
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await page.keyboard.type(`cd ${repo}`, { delay: 4 });
    await page.keyboard.press('Enter');
    await until(async () => (await textOf('.session-pill .git-stat')) === '+1 ?1', 10_000, 'the git counts');
    // the folder changed: the old name slid out and the new one in
    expect(await page.$eval('.session-pill .cwd', (el) => getComputedStyle(el).animationName)).toContain('pill-in');
    await shot('31-git-pill');
    // the counts follow the next prompt
    fs.writeFileSync(path.join(repo, 'another.txt'), 'c');
    await page.keyboard.press('Enter');
    await until(async () => (await textOf('.session-pill .git-stat')) === '+1 ?2', 10_000, 'the counts after the next prompt');
    // out of the repository: gone; and with Animations off nothing slides
    await cfgPatch({ appearance: { animations: false } });
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
    await page.keyboard.type('cd /tmp', { delay: 4 });
    await page.keyboard.press('Enter');
    await until(async () => (await page.locator('.session-pill .git-stat').count()) === 0, 10_000, 'the counts to leave');
    expect(await page.locator('.session-pill .cwd-old').count()).toBe(0);
    expect(await page.$eval('.session-pill .cwd', (el) => getComputedStyle(el).animationName)).toBe('none');
    await cfgPatch({ appearance: { animations: true } });
  }, 40_000);

  it('system stats: small bars for CPU and memory (and battery, where there is one) in the title bar, only with the setting on', async () => {
    const bars = '.titlebar .sys-stats';
    await page.evaluate(() => (window as any).__stats?.(0.42, 0.95));
    await sleep(200);
    expect(await page.locator(bars).count()).toBe(0); // off by default
    await cfgPatch({ appearance: { systemStats: true } });
    await page.evaluate(() => (window as any).__stats(0.42, 0.95));
    await page.waitForSelector(bars);
    expect(await page.getAttribute(`${bars} [data-stat="cpu"]`, 'title')).toBe('CPU 42%');
    expect(await page.getAttribute(`${bars} [data-stat="mem"]`, 'title')).toBe('Memory 95%');
    expect(await page.getAttribute(`${bars} [data-stat="mem"]`, 'data-level')).toBe('danger');
    expect(await page.getAttribute(`${bars} [data-stat="cpu"]`, 'data-level')).toBe('ok');
    const bar = (await page.locator(`${bars} [data-stat="cpu"]`).boundingBox())!;
    expect(bar.width).toBe(24);
    expect(bar.height).toBe(4);
    await shot('32-system-stats');
    await cfgPatch({ appearance: { systemStats: false } });
    await until(async () => (await page.locator(bars).count()) === 0, 4_000, 'the bars to go');
    // numbers from before (or while it was off) are not shown when it is switched on again: only the next sample
    await page.evaluate(() => (window as any).__stats(0.1, 0.1));
    await cfgPatch({ appearance: { systemStats: true } });
    await sleep(300);
    expect(await page.locator(bars).count()).toBe(0);
    await page.evaluate(() => (window as any).__stats(0.5, 0.5));
    await page.waitForSelector(bars);
    await cfgPatch({ appearance: { systemStats: false } });
    await until(async () => (await page.locator(bars).count()) === 0, 4_000, 'the bars to go again');
  }, 20_000);

  it('the title bar: everything with a tooltip or a click is out of the window-drag region (macOS gives a drag region no hover), and the empty title bar still moves the window', async () => {
    const region = (sel: string) => page.$eval(sel, (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    const repo = path.join(env.userHome, 'drag-pill');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
    await endClaude();
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await page.keyboard.type(`cd ${repo}`, { delay: 4 });
    await page.keyboard.press('Enter');
    await until(async () => (await textOf('.session-pill .git-stat')) === '?1', 10_000, 'the git counts');
    await stubClaude();
    await cfgPatch({ appearance: { systemStats: true } });
    try {
      await page.evaluate(() => (window as any).__stats(0.3, 0.3));
      await inject([{ id: 'drag-1', state: 'needs-you', turnStartedAtAgo: 5_000, tool: { name: 'Bash', id: 'd1' }, notice: 'Claude needs your permission to use Bash', file: path.join(repo, 'new.txt'), cost: { usd: 0.1, at: 5 } }]);
      await page.waitForSelector('.session-pill .needs-chip');
      for (const sel of ['.session-pill .running', '.session-pill .needs-chip', '.session-pill .edit-chip', '.session-pill .git-stat', '.session-pill .cwd-box', '.titlebar .cost-wrap', '[data-cost-chip]', '.titlebar .sys-stats'])
        expect(await region(sel), sel).toBe('no-drag');
      // (only the bar itself carries `drag`: whether a child reports its parent's value differs between Chromium versions, so children are not asserted)
      expect(await region('.titlebar'), '.titlebar').toBe('drag');
    } finally {
      await inject([]);
      await cfgPatch({ appearance: { systemStats: false } });
      await unstubClaude();
      await page.keyboard.type('cd /tmp', { delay: 4 });
      await page.keyboard.press('Enter');
    }
  }, 40_000);

  it('odd claude.state objects (calls that are null, a cost without its last answer, a turn without times) show what they can and throw nothing', async () => {
    const errors: string[] = [];
    const onErr = (e: Error) => errors.push(e.message);
    page.on('pageerror', onErr);
    try {
      await endClaude();
      const n = await toastCount('Claude finished in');
      await page.evaluate(() => {
        const ev = (window as any).__event;
        ev('claude.state', { sessions: [{ id: 'odd-1', state: 'working', calls: [null, 7, { name: 'Read' }, { name: 'Bash', category: 'shell', startedAt: Date.now() - 2000 }], cost: { totalUsd: 1, answers: 1, at: 3 }, subagents: [] }] });
        ev('claude.state', { sessions: [{ id: 'odd-1', state: 'idle', calls: [null, 'x'], cost: { at: 4 }, subagents: [] }] });
        ev('claude.state', { sessions: [{ id: 'odd-2', state: 'working', since: Date.now(), turnStartedAt: Date.now() - 60_000 }] });
        ev('claude.state', { sessions: [{ id: 'odd-2', state: 'idle' }] }); // no since: no length to say
        ev('claude.state', { sessions: [{ id: 'odd-3', state: 'working', since: Date.now() }] });
        ev('claude.state', { sessions: [{ id: 'odd-3', state: 'idle', since: Date.now() }] }); // no turnStartedAt
      });
      await sleep(3500);
      expect(await toastCount('Claude finished in')).toBe(n);
      expect(await page.locator('.titlebar').count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      page.off('pageerror', onErr);
      await inject([]);
    }
  }, 20_000);

  it('Settings: system stats and the window glow under Appearance; live cost, the daily budget, the tool strip and the turn summary under Claude Code', async () => {
    const field = (label: string) => page.locator('label.field', { hasText: label });
    const flip = async (label: string, key: (c: any) => unknown, want: unknown) => {
      await field(label).locator('.switch').click();
      await until(async () => key(await page.evaluate(() => window.jaffer.call('config.get'))) === want, 8_000, `${label} to be ${want}`);
    };
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    try {
      await flip('System stats in the title bar', (c) => c.appearance.systemStats, true);
      await flip('System stats in the title bar', (c) => c.appearance.systemStats, false);
      await flip('Window glow', (c) => c.appearance.glow, false);
      await flip('Window glow', (c) => c.appearance.glow, true);
      await page.locator('.settings-nav button', { hasText: 'Claude Code' }).click();
      await flip('Live cost while Claude works', (c) => c.claude.liveCost, false);
      await flip('Live cost while Claude works', (c) => c.claude.liveCost, true);
      await flip('Tool strip', (c) => c.claude.toolStrip, false);
      await flip('Tool strip', (c) => c.claude.toolStrip, true);
      await flip('Turn summary', (c) => c.claude.turnSummary, false);
      await flip('Turn summary', (c) => c.claude.turnSummary, true);
      const budget = field('Daily budget').locator('input[type=number]');
      await budget.fill('2.5');
      await budget.press('Tab');
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).claude.dailyBudgetUsd === 2.5, 8_000, 'the budget');
      await budget.fill('-3');
      await budget.press('Tab');
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).claude.dailyBudgetUsd === 0, 8_000, 'a negative budget to be none');
      await until(async () => (await budget.inputValue()) === '0', 4_000, 'the field to show 0');
      await budget.fill('-5'); // the config stays 0: the field still shows what was kept
      await budget.press('Tab');
      await until(async () => (await budget.inputValue()) === '0', 4_000, 'the field to show 0 again');
      await budget.fill('999999');
      await budget.press('Tab');
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).claude.dailyBudgetUsd === 100_000, 8_000, 'the budget capped');
      await until(async () => (await budget.inputValue()) === '100000', 4_000, 'the field to show the cap');
      await budget.fill('0');
      await budget.press('Tab');
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).claude.dailyBudgetUsd === 0, 8_000, 'no budget again');
      await shot('33-settings-claude');
    } finally {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.settings', { state: 'detached' });
    }
  }, 40_000);

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

    // on again from Settings: the switch shows on once the window has the setting, and by then the mark handlers are live
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Terminal' }).click();
    await field.locator('.switch').click();
    await until(async () => field.locator('input').isChecked(), 5_000, 'the switch to show on');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await page.click('.term');
    await enter(''); // blocks start at the next prompt: the one already on the screen was printed while they were off
    await enter('echo blocks-on-82');
    expect(await (await markOf('echo blocks-on-82')).getAttribute('data-state')).toBe('ok');
  }, 60_000);

  // Terminal power (spec features 9, 10, 11, 12, 21, 23, 25, 37, 39).
  const clipStub = () =>
    page.evaluate(() => {
      const clip = { written: [] as string[] };
      (window as any).__powerClip = clip;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t: string) => void clip.written.push(t) } });
    });
  const pasteText = (text: string) =>
    page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document.querySelector('.term .xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
  const patch = (p: object) => page.evaluate((x) => window.jaffer.call('config.patch', x), p);

  it('pasting several lines asks first: Esc pastes nothing, Enter pastes them; one line pastes at once; Settings switches it off', async () => {
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await pasteText('echo paste-a-41\necho paste-b-42\n');
    await page.waitForSelector('.paste-bar');
    expect(await page.textContent('.paste-bar b')).toBe('Paste 2 lines?');
    expect(await page.textContent('.paste-bar .paste-first')).toBe('echo paste-a-41');
    await shot('19-paste-guard');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.paste-bar', { state: 'detached' });
    await sleep(400);
    expect(await termText()).not.toContain('paste-a-41');
    // the first line shown is clipped and redacted
    await pasteText(`export KEY=sk-ant-api03-${'q'.repeat(40)}${'x'.repeat(120)}\nls\n`);
    await page.waitForSelector('.paste-bar');
    const first = (await page.textContent('.paste-bar .paste-first')) ?? '';
    expect(first).not.toContain('sk-ant-api03-qqqq');
    expect(first.length).toBeLessThanOrEqual(80);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.paste-bar', { state: 'detached' });
    await pasteText('echo paste-a-41\necho paste-b-42\n');
    await page.waitForSelector('.paste-bar');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.paste-bar', { state: 'detached' });
    await page.keyboard.press('Enter'); // (a shell with bracketed paste holds pasted lines until Enter; an older one has run them already)
    await until(async () => /^paste-b-42/m.test(await termText()), 8_000, 'both lines pasted and run');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true); // the terminal has the keys again
    // one line goes straight in (and is not run)
    await pasteText('echo single-paste-43');
    await until(async () => /echo single-paste-43/.test(await termText()), 5_000, 'the line pasted');
    expect(await page.locator('.paste-bar').count()).toBe(0);
    await page.keyboard.press('Control+c');
    // Settings → Terminal → Ask before pasting several lines, off: several lines go straight in
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Terminal' }).click();
    const field = page.locator('label.field', { hasText: 'Ask before pasting several lines' });
    expect(await field.locator('input').isChecked()).toBe(true);
    await field.locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).terminal.pasteGuard === false, 5_000, 'the switch to be saved');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await page.click('.term');
    await pasteText('echo unguarded-44\necho unguarded-45\n');
    await page.keyboard.press('Enter');
    await until(async () => /^unguarded-45/m.test(await termText()), 8_000, 'the lines pasted without a question');
    expect(await page.locator('.paste-bar').count()).toBe(0);
    await patch({ terminal: { pasteGuard: true } });
    // a lone carriage return breaks a line too (older Mac text): it still asks
    await page.click('.term');
    await pasteText('echo cr-a-46\recho cr-b-47');
    await page.waitForSelector('.paste-bar');
    expect(await page.textContent('.paste-bar b')).toBe('Paste 2 lines?');
    expect(await page.textContent('.paste-bar .paste-first')).toBe('echo cr-a-46');
    // while another dialog is open, its Esc and Enter are its own: the question waits
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.palette', { state: 'detached' });
    expect(await page.locator('.paste-bar').count()).toBe(1);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.paste-bar', { state: 'detached' });
    await sleep(300);
    expect(await termText()).not.toContain('cr-a-46');
  }, 60_000);

  it('the find bar is no dialog: with it open, the paste question still takes Esc and Enter', async () => {
    await page.click('.term');
    await page.keyboard.press('Meta+f');
    await page.waitForSelector('.findbar');
    await pasteText('echo find-a-48\necho find-b-49\n');
    await page.waitForSelector('.paste-bar');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.paste-bar', { state: 'detached' });
    expect(await page.locator('.findbar').count()).toBe(1); // the Esc was the question's
    await sleep(300);
    expect(await termText()).not.toContain('find-a-48');
    await page.focus('.findbar input'); // (answering the question gave the terminal the keys back)
    await page.keyboard.press('Escape');
    await page.waitForSelector('.findbar', { state: 'detached' });
  }, 30_000);

  it('⌘-click on a printed path opens it (absolute, relative to the folder, with its line and column); a plain click does not', async () => {
    const dir = path.join(env.userHome, 'links-91');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), '');
    await page.evaluate(() => ((window as any).__openedPath = []));
    await page.click('.term');
    await enter(`cd ${dir}`); // (no clearing the screen: the reload test below reads this session's earlier output)
    await until(async () => (await page.textContent('.session-pill .cwd'))?.includes('links-91'), 8_000, 'the folder in the title bar');
    await enter(`printf 'at %s:12:3 and src/app%s:7\\n' "$PWD/src/app.ts" .ts`);
    const where = await until(
      () =>
        page.evaluate(() => {
          const t = (window as any).__jaffer.terminals.get('main').term;
          const b = t.buffer.active;
          for (let y = b.length - 1; y >= 0; y--) if (b.getLine(y)!.translateToString(true).startsWith('at /')) return { row: y - b.viewportY, text: b.getLine(y)!.translateToString(true) };
          return null;
        }),
      8_000,
      'the printed paths',
    );
    const cell = async (col: number) => {
      const box = (await page.locator('.term .xterm-screen').boundingBox())!;
      const dims = await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term._core._renderService.dimensions.css.cell);
      return { x: box.x + (col + 0.5) * dims.width, y: box.y + (where.row + 0.5) * dims.height };
    };
    const metaClick = async (col: number, meta = true) => {
      const p = await cell(col);
      await page.mouse.move(p.x, p.y);
      await sleep(250); // the link is found on hover
      if (meta) await page.keyboard.down('Meta');
      await page.mouse.down();
      await page.mouse.up();
      if (meta) await page.keyboard.up('Meta');
    };
    await metaClick(5, false);
    await sleep(200);
    expect(await page.evaluate(() => (window as any).__openedPath)).toEqual([]);
    await metaClick(5);
    await until(async () => (await page.evaluate(() => (window as any).__openedPath.length)) === 1, 3_000, 'the absolute path opened');
    expect(await page.evaluate(() => (window as any).__openedPath[0])).toEqual({ path: path.join(dir, 'src', 'app.ts'), line: 12, col: 3 });
    await metaClick(where.text.indexOf('src/app.ts:7') + 2);
    await until(async () => (await page.evaluate(() => (window as any).__openedPath.length)) === 2, 3_000, 'the relative path opened');
    expect(await page.evaluate(() => (window as any).__openedPath[1])).toEqual({ path: path.join(dir, 'src', 'app.ts'), line: 7 });
    // the editor link could not be opened (no app for its scheme): the window says so
    await page.evaluate(() => ((window as any).__openPathAnswer = { opened: false, editorFailed: true }));
    await metaClick(5);
    await toastSaid('Could not open the editor link');
    await page.evaluate(() => delete (window as any).__openPathAnswer);
  }, 40_000);

  it('the find bar counts matches ("2 of 3"), marks them on the overview ruler, and ⌘G / ⇧⌘G go on with the bar closed', async () => {
    await page.click('.term');
    await enter("printf 'needle%s\\n' 77 77 77");
    await until(async () => (await termText()).split('\n').filter((l) => l === 'needle77').length === 3, 8_000, 'the matches');
    await page.keyboard.press('Meta+f');
    await page.waitForSelector('.findbar input');
    await page.keyboard.type('needle77');
    await until(async () => /^\d of 3$/.test((await page.textContent('.findbar .find-count')) ?? ''), 5_000, 'the counter');
    const firstCount = await page.textContent('.findbar .find-count');
    await menu('find-next');
    await until(async () => (await page.textContent('.findbar .find-count')) !== firstCount, 3_000, 'the next match');
    expect(await page.textContent('.findbar .find-count')).toMatch(/^\d of 3$/);
    expect(await page.locator('.term .xterm-decoration-overview-ruler').count()).toBe(1);
    await shot('20-find-count');
    await page.keyboard.type('zzz-nothing');
    await until(async () => (await page.textContent('.findbar .find-count')) === 'No results', 3_000, 'no results');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.findbar', { state: 'detached' });
    const selection = () => page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.getSelection());
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.clearSelection());
    await menu('find-next'); // the bar is closed: the last search goes on (the last thing typed was a search with no results)
    expect(await selection()).toBe('');
    await page.keyboard.press('Meta+f');
    await page.waitForSelector('.findbar input');
    await page.keyboard.type('needle77');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.findbar', { state: 'detached' });
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.clearSelection());
    await menu('find-next');
    await until(async () => (await selection()) === 'needle77', 3_000, 'the next match selected');
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.clearSelection());
    await menu('find-prev');
    await until(async () => (await selection()) === 'needle77', 3_000, 'the previous match selected');
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.clearSelection());
  }, 40_000);

  it('⌘R lists this session’s commands (never a sensitive one); Enter copies one to the clipboard and types nothing', async () => {
    await clipStub();
    await page.click('.term');
    await enter('echo recent-one-55');
    await ended('echo recent-one-55');
    await enter('echo $NO_SUCH_TOKEN');
    await ended('echo $NO_SUCH_TOKEN');
    await menu('recent-commands');
    await page.waitForSelector('.recent-list input');
    const rows = await page.$$eval('.recent-list .recent-cmd', (r) => r.map((x) => x.textContent ?? ''));
    expect(rows[0]).toBe('echo recent-one-55'); // newest first
    expect(rows.some((r) => /NO_SUCH_TOKEN/.test(r))).toBe(false);
    await page.keyboard.type('recent-one');
    await until(async () => (await page.locator('.recent-list .recent-cmd').count()) === 1, 3_000, 'the filter');
    await shot('21-recent-commands');
    const before = await termText();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.recent-list', { state: 'detached' });
    await until(async () => (await page.evaluate(() => (window as any).__powerClip.written.at(-1))) === 'echo recent-one-55', 3_000, 'the command on the clipboard');
    await toastSaid('Copied. Paste it in the terminal.');
    // a command that ends while the list is open shows up in it
    await menu('recent-commands');
    await page.waitForSelector('.recent-list input');
    await page.evaluate(() => (window as any).__event('pty.command', { pane: 'main', cmd: 'echo while-open-56', exit: 0, durMs: 5, cwd: '/tmp' }));
    await until(async () => (await page.textContent('.recent-list .recent-cmd')) === 'echo while-open-56', 3_000, 'the new command in the open list');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.recent-list', { state: 'detached' });
    await sleep(500);
    expect(await termText()).toBe(before); // nothing typed
    // the palette has the new actions
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('re');
    const list = (await page.textContent('.palette-list')) ?? '';
    expect(list).toContain('Recent commands');
    await page.fill('.palette input', 'pin');
    expect(await page.textContent('.palette-list')).toContain('Pin selection');
    await page.fill('.palette input', 'find');
    expect(await page.textContent('.palette-list')).toMatch(/Find next[\s\S]*Find previous|Find previous[\s\S]*Find next/);
    await page.keyboard.press('Escape');
  }, 40_000);

  it('the column ruler sits at its column, follows the text size, and goes when off; inline images switch off and on', async () => {
    const errors: string[] = [];
    const onErr = (e: Error) => errors.push(e.message);
    page.on('pageerror', onErr);
    const expected = () =>
      page.evaluate(() => {
        const t = (window as any).__jaffer.terminals.get('main').term;
        const term = document.querySelector('.term')!.getBoundingClientRect();
        const screen = document.querySelector('.term .xterm-screen')!.getBoundingClientRect();
        const ruler = document.querySelector('.term .col-ruler') as HTMLElement;
        return { want: screen.left - term.left + t._core._renderService.dimensions.css.cell.width * 80, got: ruler.getBoundingClientRect().left - term.left, hidden: ruler.hidden };
      });
    expect((await expected()).hidden).toBe(true); // off by default
    await patch({ terminal: { ruler: 80 } });
    await until(async () => !(await expected()).hidden, 5_000, 'the ruler');
    let r = await expected();
    expect(Math.abs(r.got - r.want)).toBeLessThan(1);
    await shot('22-ruler');
    await patch({ appearance: { fontSize: 16 } });
    await until(async () => ((r = await expected()), Math.abs(r.got - r.want) < 1 && r.want > 0), 5_000, 'the ruler to follow the text size');
    await patch({ appearance: { fontSize: 13 } });
    await patch({ terminal: { ruler: 0 } });
    await until(async () => (await expected()).hidden, 5_000, 'the ruler to go');

    await patch({ terminal: { images: false } });
    await sleep(300);
    await patch({ terminal: { images: true } });
    await sleep(300);
    await page.click('.term');
    await enter('echo images-ok-57');
    await until(async () => /^images-ok-57/m.test(await termText()), 8_000, 'the terminal still working');
    page.off('pageerror', onErr);
    expect(errors).toEqual([]);
  }, 40_000);

  it('a local server the running command prints gets a chip in the title bar that opens it, gone when the command ends', async () => {
    await page.evaluate(() => ((window as any).__opened = undefined));
    await page.click('.term');
    await enter(`sh -c "printf 'listening on http://local%s:5173/\\n' host; sleep 3"`);
    await page.waitForSelector('.session-pill .port-chip', { timeout: 8_000 });
    expect(await page.textContent('.session-pill .port-chip')).toBe(':5173 ↗');
    await shot('23-port-chip');
    expect(await page.$eval('.session-pill .port-chip', (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
    await page.click('.session-pill .port-chip');
    expect(await page.evaluate(() => (window as any).__opened)).toBe('http://localhost:5173');
    await page.waitForSelector('.session-pill .port-chip', { state: 'detached', timeout: 8_000 });
    // Settings → Terminal → Links to local servers, off: no chip
    await patch({ terminal: { portLinks: false } });
    await page.click('.term');
    await enter(`sh -c "printf 'on http://127.0.0.%s:8080\\n' 1; sleep 2"`);
    await until(async () => /^on http:\/\/127\.0\.0\.1:8080/m.test(await termText()), 8_000, 'the output');
    await sleep(300);
    expect(await page.locator('.session-pill .port-chip').count()).toBe(0);
    await until(async () => !(await page.evaluate(() => window.jaffer.call('session.info'))).busy, 8_000, 'the command to end');
    await patch({ terminal: { portLinks: true } });
    // Claude Code draws its own screen in the normal buffer: what it prints is not a server of the command's
    await page.click('.term');
    await enter(`claude() { printf 'see http://local%s:3000\\n' host; sleep 2; }`);
    await enter('claude');
    await until(async () => /^see http:\/\/localhost:3000/m.test(await termText()), 8_000, 'the stub Claude output');
    await sleep(300);
    expect(await page.locator('.session-pill .port-chip').count()).toBe(0);
    await until(async () => !(await page.evaluate(() => window.jaffer.call('session.info'))).busy, 8_000, 'the stub to end');
    await enter('unset -f claude');
  }, 40_000);

  it('⇧⌘L pins the selected line (redacted) under the title bar, at most three, each with its ×', async () => {
    const selectOutput = async (text: string) => {
      await until(
        () =>
          page.evaluate((s) => {
            const t = (window as any).__jaffer.terminals.get('main').term;
            const b = t.buffer.active;
            for (let y = b.length - 1; y >= 0; y--)
              if (b.getLine(y)!.translateToString(true) === s) {
                t.selectLines(y, y);
                return true;
              }
            return false;
          }, text),
        8_000,
        `the line ${text}`,
      );
    };
    await page.click('.term');
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.clearSelection());
    await menu('pin-selection');
    await toastSaid('Select something first');
    for (const n of [1, 2, 3, 4]) {
      await enter(`echo pin-me-6${n}`);
      await ended(`echo pin-me-6${n}`); // (typed ahead, the next command would be echoed into this one's output)
    }
    for (const n of [1, 2, 3, 4]) {
      await selectOutput(`pin-me-6${n}`);
      await menu('pin-selection');
      await until(async () => (await page.$$eval('.pins .pin-text', (p) => p.map((x) => x.textContent))).includes(`pin-me-6${n}`), 3_000, `pin ${n}`);
      await sleep(200); // the strip grew: the terminal fits itself to the room left (which drops a selection)
    }
    await until(async () => (await page.locator('.pins .pin').count()) === 3, 3_000, 'three pins');
    expect(await page.$$eval('.pins .pin-text', (p) => p.map((x) => x.textContent))).toEqual(['pin-me-62', 'pin-me-63', 'pin-me-64']);
    // the strip sits at the top of the card, above the terminal (the card itself never scrolls)
    const area = (await page.locator('.terminal-area').boundingBox())!;
    const strip = (await page.locator('.pins').boundingBox())!;
    expect(Math.abs(strip.y - area.y)).toBeLessThan(2);
    expect((await page.locator('.term').boundingBox())!.y).toBeGreaterThanOrEqual(strip.y + strip.height - 0.5);
    await shot('24-pins');
    await page.locator('.pins .pin', { hasText: 'pin-me-63' }).locator('button').click();
    expect(await page.$$eval('.pins .pin-text', (p) => p.map((x) => x.textContent))).toEqual(['pin-me-62', 'pin-me-64']);
    await page.click('.term');
    await enter(`echo sk-ant-api03-${'p'.repeat(40)}`);
    await sleep(200);
    await selectOutput(`sk-ant-api03-${'p'.repeat(40)}`);
    await menu('pin-selection');
    await until(async () => (await page.locator('.pins .pin').count()) === 3, 3_000, 'the third pin');
    expect(await page.textContent('.pins')).not.toContain('pppppppppp');
    for (let i = 0; i < 3; i++) await page.locator('.pins .pin button').first().click();
    await page.waitForSelector('.pins', { state: 'detached' });
  }, 40_000);

  it('the pin strip pushes the sticky command header and the find bar down: nothing covers a pin or its ×', async () => {
    await page.click('.term');
    await enter('seq 1 300');
    const seq = await ended('seq 1 300');
    await page.evaluate((y) => (window as any).__jaffer.terminals.get('main').term.selectLines(y, y), seq.outputStart! + 298);
    await menu('pin-selection');
    await page.waitForSelector('.pins .pin');
    await sleep(200);
    await page.evaluate((line) => (window as any).__jaffer.terminals.get('main').term.scrollToLine(line), seq.outputStart! + 120);
    await page.waitForSelector('.sticky-cmd');
    await page.keyboard.press('Meta+f');
    await page.waitForSelector('.findbar input');
    const rect = (sel: string) => page.evaluate((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }, sel);
    const strip = await rect('.pins');
    for (const sel of ['.sticky-cmd', '.findbar']) expect((await rect(sel)).top, sel).toBeGreaterThanOrEqual(strip.bottom);
    await shot('25-pins-sticky-find');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.findbar', { state: 'detached' });
    await page.locator('.pins .pin button').click({ timeout: 3_000 }); // nothing covers it
    await page.waitForSelector('.pins', { state: 'detached' });
    await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.scrollToBottom());
  }, 40_000);

  it('back at the window, a toast says which long command finished while you were away', async () => {
    const cmd = (c: object) => page.evaluate((d) => (window as any).__event('pty.command', { pane: 'main', cwd: '/tmp', ...d }), c);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // focused: no toast
    await cmd({ cmd: 'make focused-71', exit: 0, durMs: 60_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await cmd({ cmd: 'make build', exit: 0, durMs: 252_000 });
    await cmd({ cmd: 'echo quick', exit: 0, durMs: 1_000 });
    await cmd({ cmd: 'npm test', exit: 1, durMs: 40_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await toastSaid('npm test finished in 40s (exit 1) and 1 more');
    expect(await page.locator('.toast-text', { hasText: 'focused-71' }).count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(200);
    expect(await page.locator('.toast-text', { hasText: 'npm test finished' }).count()).toBe(1); // once
  }, 20_000);

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

  // The companion (spec features 1, 4, 5, 20, 28): the tool it shows, helpers, dozing, "Fixed it!" and the bell.
  const working = (tool?: string, subagents: Record<string, unknown>[] = []) => inject([{ id: 'comp-1', state: 'working', tool: tool ? { name: tool, id: 'c1' } : undefined, subagents }]);
  const motion = (on: boolean) => page.evaluate((a) => window.jaffer.call('config.patch', { appearance: { animations: a } }), on);

  it('the companion shows the tool Claude uses: data-tool on the mole and on its helpers, a prop for each kind, and the props stand still without motion', async () => {
    const mole = '.pet-corner .pet[data-role="main"]';
    const opacity = (sel: string) => page.$eval(sel, (el) => getComputedStyle(el).opacity);
    await endClaude();
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole', animations: true } }));
    await page.waitForSelector(mole);
    const props: Record<string, string | null> = { Bash: null, Read: '.pet-book', Grep: '.pet-book', Edit: '.pet-hammer', WebFetch: '.pet-dish', Task: '.pet-hat' };
    const cats: Record<string, string> = { Bash: 'shell', Read: 'read', Grep: 'read', Edit: 'write', WebFetch: 'web', Task: 'agent', mcp__x__y: 'other' };
    for (const [tool, cat] of Object.entries(cats)) {
      await working(tool);
      await until(async () => (await page.getAttribute(mole, 'data-tool')) === cat, 5_000, `${tool}: data-tool ${cat}`);
      for (const prop of ['.pet-book', '.pet-hammer', '.pet-dish']) expect(await opacity(`${mole} ${prop}`), `${tool} ${prop}`).toBe(props[tool] === prop ? '1' : '0'); // only its own prop shows
      if (props[tool] === '.pet-hat') await until(async () => (await opacity(`${mole} .pet-hat`)) === '1', 3_000, 'the hard hat on for agents'); // (it fades in)
    }
    await working(); // working without a tool call open: no prop
    await until(async () => (await page.getAttribute(mole, 'data-tool')) === null, 5_000, 'no data-tool without a tool call');
    await working('Read');
    await until(async () => (await page.getAttribute(mole, 'data-tool')) === 'read', 5_000, 'Read');
    await shot('16a-pet-read');
    await inject([{ id: 'comp-1', state: 'idle', tool: { name: 'Read', id: 'c1' } }]); // not working: none
    await until(async () => (await page.getAttribute(mole, 'data-tool')) === null, 5_000, 'no data-tool while idle');
    // helpers carry their own tool, and show the same props smaller
    await working('Bash', [
      { id: 'h1', status: 'running', startAgo: 4_000, tool: 'Read' },
      { id: 'h2', status: 'running', startAgo: 4_000, tool: 'Edit' },
      { id: 'h3', status: 'running', startAgo: 4_000 },
    ]);
    await until(async () => (await page.locator('.pet-corner .pet-helper').count()) === 3, 5_000, 'three helpers');
    expect(await page.$$eval('.pet-corner .pet-helper', (els) => els.map((e) => e.getAttribute('data-tool')))).toEqual(['read', 'write', null]);
    expect(await page.getAttribute(mole, 'data-tool')).toBe('shell');
    expect(await opacity('.pet-corner .pet-helper[data-tool="read"] .pet-book')).toBe('1');
    await shot('16b-pet-helpers-tools');
    // motion off: the prop still shows, nothing moves
    await working('Read');
    await motion(false);
    try {
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
      expect(await opacity(`${mole} .pet-book`)).toBe('1');
      expect(await page.$eval(`${mole} .pet-book .pet-page`, (el) => getComputedStyle(el).animationName)).toBe('none');
    } finally {
      await motion(true);
    }
    // macOS Reduce motion: the page stops flipping
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(parseFloat(await page.$eval(`${mole} .pet-book .pet-page`, (el) => getComputedStyle(el).animationDuration))).toBeLessThan(0.001);
    await page.emulateMedia({ reducedMotion: null });
    await endClaude();
  }, 60_000);

  it('the scenes carry data-tool too, and change their colour with the kind of work', async () => {
    try {
      await endClaude();
      for (const variant of ['matrix', 'agents', 'warp', 'radar', 'core']) {
        await page.evaluate((c) => window.jaffer.call('config.patch', { appearance: { companion: c } }), variant);
        const scene = `.pet-corner[data-companion='${variant}'] .scene`;
        await page.waitForSelector(scene);
        const colour = () => page.$eval(scene, (el) => getComputedStyle(el).getPropertyValue('--c').trim());
        const seen: Record<string, string> = {};
        for (const [tool, cat] of [['Bash', 'shell'], ['Read', 'read'], ['Edit', 'write'], ['WebFetch', 'web'], ['Task', 'agent']] as const) {
          await working(tool);
          await until(async () => (await page.getAttribute(scene, 'data-tool')) === cat && (await page.getAttribute(scene, 'data-mood')) === 'dig', 5_000, `${variant}: ${tool}`);
          seen[cat] = await colour();
        }
        const said = `${variant} ${JSON.stringify(seen)}`;
        expect(seen.read, said).not.toBe(seen.shell); // cooler
        expect(seen.write, said).not.toBe(seen.shell); // warmer
        expect(seen.read, said).not.toBe(seen.write);
        expect(seen.web, said).toBe(seen.shell); // the web is quicker, not another colour
        await inject([]); // (no session at all: no cheering for the end of a turn either)
        await until(async () => (await page.getAttribute(scene, 'data-tool')) === null && (await page.getAttribute(scene, 'data-mood')) === 'sleep', 5_000, `${variant}: no tool, asleep`);
      }
    } finally {
      await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole' } }));
      await endClaude();
    }
  }, 90_000);

  it('the companion dozes after ten quiet minutes (dimmer, Zzz) and wakes at once with any activity', async () => {
    const mole = '.pet-corner .pet[data-role="main"]';
    const dbg = (ago: number) => page.evaluate((a) => ((window as any).__jaffer.activity.value = Date.now() - a), ago);
    await endClaude();
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole', animations: true } }));
    await inject([{ id: 'comp-2', state: 'idle' }]); // Claude is open and idle (rest), not working
    await until(async () => (await page.getAttribute(mole, 'data-mood')) === 'rest', 5_000, 'rest');
    await dbg(9 * 60_000);
    await sleep(300);
    expect(await page.getAttribute(mole, 'data-idle')).toBeNull(); // nine minutes: not yet
    await dbg(11 * 60_000);
    await until(async () => (await page.getAttribute(mole, 'data-idle')) === 'doze', 5_000, 'doze');
    expect(await page.$eval(mole, (el) => getComputedStyle(el).opacity)).toBe('0.5');
    expect(await page.$eval(`${mole} .pet-zs`, (el) => getComputedStyle(el).opacity)).toBe('1');
    await shot('16c-pet-doze');
    // Claude starts working: awake at once, and it does not doze while it works however long it takes
    await working('Bash');
    await until(async () => (await page.getAttribute(mole, 'data-idle')) === null, 3_000, 'awake with Claude working');
    await dbg(30 * 60_000);
    await sleep(200);
    expect(await page.getAttribute(mole, 'data-idle')).toBeNull(); // a long turn is not a quiet one
    await inject([{ id: 'comp-2', state: 'idle' }]);
    await until(async () => (await page.getAttribute(mole, 'data-idle')) === 'doze', 3_000, 'doze again once idle and quiet');
    // a command (pty.start) wakes it too
    await page.evaluate(() => (window as any).__event('pty.start', { pane: 'main', cmd: 'sleep 1' }));
    await until(async () => (await page.getAttribute(mole, 'data-idle')) === null, 3_000, 'awake with a command');
    await page.evaluate(() => (window as any).__event('pty.command', { pane: 'main', cmd: 'sleep 1', exit: 0, durMs: 5, cwd: '/tmp' }));
    await endClaude();
  }, 30_000);

  it('"Fixed it!": a short burst of sparks after a command that failed three times in a row finally works (none with motion off, and none for fewer failures)', async () => {
    const burst = '.pet-corner .pet-burst';
    const cmd = (c: string, exit: number) => page.evaluate((d) => (window as any).__event('pty.command', { pane: 'main', cwd: '/tmp', durMs: 5, ...d }), { cmd: c, exit });
    /**
     * The command ends, and the burst is looked at from inside the page the moment it appears (a MutationObserver): it lasts 1.4 s, and a
     * wait for it followed by a second evaluate can miss it on a busy machine. Null: none appeared within 4 s.
     */
    const fixes = (c: string, root = '.pet-corner') =>
      page.evaluate(
        ([text, r]) =>
          new Promise<{ sparks: number; pointerEvents: string; display: string } | null>((resolve) => {
            const look = () => {
              const el = document.querySelector(`${r} .pet-burst`);
              return el ? { sparks: el.querySelectorAll('.pet-spark').length, pointerEvents: getComputedStyle(el).pointerEvents, display: getComputedStyle(el).display } : null;
            };
            const done = (v: ReturnType<typeof look>) => (obs.disconnect(), clearTimeout(timer), resolve(v));
            const obs = new MutationObserver(() => {
              const l = look();
              if (l) done(l);
            });
            obs.observe(document.body, { childList: true, subtree: true });
            const timer = setTimeout(() => done(null), 4_000);
            (window as any).__event('pty.command', { pane: 'main', cwd: '/tmp', durMs: 5, cmd: text, exit: 0 });
          }),
        [c, root] as const,
      );
    await endClaude();
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole', animations: true } }));
    await page.waitForSelector('.pet-corner .pet');
    await cmd('make fixit-a', 2);
    await cmd('make fixit-a', 2);
    await cmd('make fixit-a', 0); // only two failures
    await sleep(300);
    expect(await page.locator(burst).count()).toBe(0);
    await cmd('make fixit-b', 1);
    await cmd('make fixit-b', 1);
    await cmd('ls', 0); // other commands in between do not matter
    await cmd('make fixit-b', 1);
    const b = await fixes('make fixit-b');
    expect(b).not.toBeNull();
    expect(b!.sparks).toBeGreaterThanOrEqual(6);
    expect(b!.sparks).toBeLessThanOrEqual(8);
    expect(b!.pointerEvents).toBe('none');
    await shot('16d-pet-fixed-it');
    await until(async () => (await page.locator(burst).count()) === 0, 4_000, 'the burst to end by itself');
    // the same again with Animations off: nothing
    for (let i = 0; i < 3; i++) await cmd('make fixit-c', 1);
    await motion(false);
    try {
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
      await cmd('make fixit-c', 0);
      await sleep(400);
      expect(await page.locator(burst).count()).toBe(0);
    } finally {
      await motion(true);
    }
    // macOS Reduce motion: it exists but is never drawn
    for (let i = 0; i < 3; i++) await cmd('make fixit-d', 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      expect((await fixes('make fixit-d'))?.display).toBe('none');
    } finally {
      await page.emulateMedia({ reducedMotion: null }); // (a failed assertion must not leave Reduce motion on for the tests after this one)
    }
    // the scenes get it too
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'radar' } }));
    await page.waitForSelector(".pet-corner[data-companion='radar'] .scene");
    await sleep(1_600);
    for (let i = 0; i < 3; i++) await cmd('make fixit-e', 1);
    expect(await fixes('make fixit-e', ".pet-corner[data-companion='radar']")).not.toBeNull();
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole' } }));
  }, 40_000);

  it('a bell makes the companion flinch for a moment (once in two seconds)', async () => {
    const mole = '.pet-corner .pet[data-role="main"]';
    /**
     * Rings the bell and reports, from a MutationObserver inside the page, whether `sel` got `data-flinch` within `ms` and what its animation
     * was at that moment: a flinch lasts 400 ms, which polling from outside can miss on a busy machine (and so can a second evaluate).
     */
    const bell = (sel: string, ms: number) =>
      page.evaluate(
        ([s, wait]) =>
          new Promise<{ seen: boolean; animation: string }>((resolve) => {
            const el = document.querySelector(s as string)!;
            const done = (seen: boolean, animation = '') => (obs.disconnect(), clearTimeout(timer), resolve({ seen, animation }));
            const obs = new MutationObserver(() => el.getAttribute('data-flinch') === '1' && done(true, getComputedStyle(el).animationName));
            obs.observe(el, { attributes: true, attributeFilter: ['data-flinch'] });
            const timer = setTimeout(() => done(false), wait as number);
            (window as any).__event('pty.bell', { pane: 'main' });
          }),
        [sel, ms] as const,
      );
    await endClaude();
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole', animations: true } }));
    await page.waitForSelector(mole);
    expect(await page.getAttribute(mole, 'data-flinch')).toBeNull();
    await sleep(2_100); // (an earlier test may have rung)
    const first = await bell(mole, 3_000);
    expect(first.seen).toBe(true);
    expect(first.animation).toContain('pet-flinch');
    await until(async () => (await page.getAttribute(mole, 'data-flinch')) === null, 2_000, 'the flinch to end');
    expect((await bell(mole, 700)).seen).toBe(false); // within two seconds of the last one: ignored
    // the scenes flinch too
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'warp' } }));
    const scene = ".pet-corner[data-companion='warp'] .scene";
    await page.waitForSelector(scene);
    await sleep(2_100);
    expect((await bell(scene, 3_000)).seen).toBe(true);
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole' } }));
  }, 30_000);

  // App level (spec features 17, 34, 38, 40): the theme that follows macOS or the clock, blur, hook health, focus mode.
  const rootVar = (n: string) => page.evaluate((v) => document.documentElement.style.getPropertyValue(v), n);
  const alphaOf = (c: string) => parseFloat(/,\s*([\d.]+)\)$/.exec(c)?.[1] ?? 'NaN');
  const themeBg = (id: string) => ({ 'jaffer-dark': '#12151b', 'jaffer-light': '#fdfcfa', nord: '#2e3440' })[id]!;
  const openSettings = async (nav: string) => {
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: nav }).click();
  };
  const closeSettings = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  };

  it('the theme follows macOS (system) or the time of day (time): the dark theme and the light one swap, the surfaces fade over a second, Animations off does not fade; off follows nothing', async () => {
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-dark', lightTheme: 'jaffer-light', autoTheme: 'off', animations: true } }));
    await page.emulateMedia({ colorScheme: 'light' });
    await sleep(300);
    expect(await rootVar('--bg-solid')).toBe(themeBg('jaffer-dark')); // off: macOS's light appearance changes nothing
    await cfgPatch({ appearance: { autoTheme: 'system' } });
    await until(async () => (await rootVar('--bg-solid')) === themeBg('jaffer-light'), 5_000, 'the light theme in light mode');
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light');
    expect(await page.evaluate(() => String((window as any).__jaffer.terminals.get('main').term.options.theme.background))).toContain('253,252,250'); // the terminal's own colours at once
    expect(await page.evaluate(() => document.documentElement.classList.contains('theme-fade'))).toBe(true); // fading
    expect(await page.$eval('.terminal-area', (el) => getComputedStyle(el).transitionDuration)).toBe('1s, 1s, 1s');
    await until(async () => !(await page.evaluate(() => document.documentElement.classList.contains('theme-fade'))), 4_000, 'the fade to end');
    await page.emulateMedia({ colorScheme: 'dark' });
    await until(async () => (await rootVar('--bg-solid')) === themeBg('jaffer-dark'), 5_000, 'the dark theme in dark mode');
    // the terminal's own colours follow (they switch at once)
    expect(await page.evaluate(() => String((window as any).__jaffer.terminals.get('main').term.options.theme.background))).toContain('18,21,27');
    // the light theme is a choice, and Animations off swaps without a fade
    await until(async () => !(await page.evaluate(() => document.documentElement.classList.contains('theme-fade'))), 4_000, 'the last fade to end');
    await cfgPatch({ appearance: { lightTheme: 'nord', animations: false } });
    await page.emulateMedia({ colorScheme: 'light' });
    await until(async () => (await rootVar('--bg-solid')) === themeBg('nord'), 5_000, 'the chosen light theme');
    expect(await page.evaluate(() => document.documentElement.classList.contains('theme-fade'))).toBe(false);
    await cfgPatch({ appearance: { autoTheme: 'off' } });
    await until(async () => (await rootVar('--bg-solid')) === themeBg('jaffer-dark'), 5_000, 'the chosen theme with the switch off');
    // time of day: the hour of the page's clock (07:00 to 18:59 is light)
    const at = (h: string) => page.evaluate((iso) => {
      const w = window as any;
      w.__RealDate ??= Date;
      const fixed = new w.__RealDate(iso).getTime();
      w.Date = class extends w.__RealDate { constructor(...a: unknown[]) { (a.length ? super(...(a as [])) : super(fixed)); } static now() { return fixed; } };
    }, `2026-10-14T${h}:00`);
    try {
      await cfgPatch({ appearance: { autoTheme: 'time', lightTheme: 'jaffer-light' } });
      for (const [time, id] of [['06:59', 'jaffer-dark'], ['07:00', 'jaffer-light'], ['18:59', 'jaffer-light'], ['19:00', 'jaffer-dark'], ['12:30', 'jaffer-light'], ['23:15', 'jaffer-dark']] as const) {
        await at(time);
        await cfgPatch({ appearance: { autoTheme: 'off' } }); // (the hour is read when the mode starts, and every five minutes)
        await cfgPatch({ appearance: { autoTheme: 'time' } });
        await until(async () => (await rootVar('--bg-solid')) === themeBg(id), 5_000, `${id} at ${time}`);
      }
    } finally {
      await page.evaluate(() => { const w = window as any; if (w.__RealDate) w.Date = w.__RealDate; });
      await cfgPatch({ appearance: { autoTheme: 'off', animations: true, lightTheme: 'jaffer-light', theme: 'jaffer-dark' } });
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await until(async () => (await rootVar('--bg-solid')) === themeBg('jaffer-dark'), 5_000, 'the dark theme again');
    // Settings → Appearance: the two selects, in their place after the theme cards, writing the config
    await openSettings('Appearance');
    const labels = await page.$$eval('.settings-body .field-label', (els) => els.map((e) => e.firstChild?.textContent ?? ''));
    expect(labels.slice(0, 4)).toEqual(['Follow macOS / time of day', 'Light theme', 'Font size', 'Font family']);
    await page.locator('.settings-body select').nth(0).selectOption('system'); // (Follow macOS / time of day, then Light theme)
    await page.locator('.settings-body select').nth(1).selectOption('nord');
    await until(async () => { const a = (await page.evaluate(() => window.jaffer.call('config.get'))).appearance; return a.autoTheme === 'system' && a.lightTheme === 'nord'; }, 5_000, 'the two selects to reach the config');
    await closeSettings();
    await cfgPatch({ appearance: { autoTheme: 'off', lightTheme: 'jaffer-light' } });
    await page.emulateMedia({ colorScheme: 'light' });
  }, 60_000);

  it('blur: the switch is in Settings after the opacity; off, the window colours are opaque whatever the slider says, on, the slider counts again', async () => {
    await cfgPatch({ appearance: { blur: true, opacity: 0.8 } });
    await until(async () => alphaOf(await rootVar('--surface')) < 0.9, 5_000, 'the see-through colours');
    const termBg = () => page.evaluate(() => String((window as any).__jaffer.terminals.get('main').term.options.theme.background));
    expect(await termBg()).toMatch(/^rgba/);
    await openSettings('Appearance');
    const labels = await page.$$eval('.settings-body .field-label', (els) => els.map((e) => e.firstChild?.textContent ?? ''));
    expect(labels.indexOf('Blur behind the window')).toBe(labels.indexOf('Window opacity') + 1);
    const sw = page.locator('.field', { hasText: 'Blur behind the window' }).locator('input[type=checkbox]');
    expect(await sw.isChecked()).toBe(true);
    await page.locator('.field', { hasText: 'Blur behind the window' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).appearance.blur === false, 5_000, 'the switch to reach the config');
    await until(async () => alphaOf(await rootVar('--surface')) === 1 && alphaOf(await rootVar('--chrome')) === 1, 5_000, 'opaque colours');
    expect(await termBg()).toBe('#12151b');
    await closeSettings();
    await cfgPatch({ appearance: { blur: true } });
    await until(async () => alphaOf(await rootVar('--surface')) < 0.9, 5_000, 'the slider counting again');
    await cfgPatch({ appearance: { opacity: 0.96 } });
  }, 30_000);

  it('hook health: Settings → Claude Code lists the eleven events (last seen / not seen yet, live), and warns when Stop is missing for over an hour with no session working', async () => {
    await endClaude();
    await sendHook('SessionStart', { session_id: 'hh-1', source: 'startup' });
    await openSettings('Claude Code');
    await page.waitForSelector('.hook-health li');
    const rows = () => page.$$eval('.hook-health li', (els) => els.map((e) => [...e.children].map((c) => c.textContent)));
    const names = (await rows()).map((r) => r[0]);
    expect(names).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'SessionEnd', 'PreCompact']);
    expect((await rows()).find((r) => r[0] === 'SessionStart')![1]).toMatch(/^last seen (just now|\d+m ago)$/);
    for (const r of await rows()) expect(r[1], r[0]!).toMatch(/^(not seen yet|last seen .+)$/);
    expect(await page.locator('.hook-health .hh-warn').count()).toBe(0); // (a session began a moment ago)
    await shot('31-hook-health');
    // the daemon's answer, stood in for: an old SessionStart without a Stop; then (while the list is open, it asks again by itself) a Stop
    await page.evaluate(() => {
      const j = window.jaffer as any;
      j.__realCall = j.call;
      j.__hooks = { SessionStart: Date.now() - 2 * 3_600_000, Stop: null, PreToolUse: Date.now() - 90_000 };
      j.call = (m: string, p: unknown) => (m === 'claude.hooks' ? Promise.resolve({ events: { ...j.__hooks } }) : j.__realCall(m, p));
    });
    try {
      await closeSettings();
      await openSettings('Claude Code');
      await page.waitForSelector('.hook-health .hh-warn');
      expect(await page.textContent('.hook-health .hh-warn')).toBe('Stop has not arrived for over an hour: the hooks may be broken. Try Reinstall.');
      expect((await rows()).find((r) => r[0] === 'PreToolUse')![1]).toBe('last seen 2m ago');
      expect((await rows()).find((r) => r[0] === 'Stop')![1]).toBe('not seen yet');
      await page.evaluate(() => ((window.jaffer as any).__hooks.Stop = Date.now()));
      await until(async () => (await rows()).find((r) => r[0] === 'Stop')![1] === 'last seen just now', 14_000, 'the list to refresh by itself');
      await until(async () => (await page.locator('.hook-health .hh-warn').count()) === 0, 1_000, 'no warning once a Stop came');
      await page.evaluate(() => ((window.jaffer as any).__hooks.Stop = null));
      await until(async () => (await page.locator('.hook-health .hh-warn').count()) === 1, 14_000, 'the warning again');
      // a working session: Stop is not due
      await inject([{ id: 'hh-w', state: 'working', turnStartedAtAgo: 5_000 }]);
      await until(async () => (await page.locator('.hook-health .hh-warn').count()) === 0, 15_000, 'no warning while Claude works');
    } finally {
      await page.evaluate(() => { const j = window.jaffer as any; if (j.__realCall) j.call = j.__realCall; });
      await inject([]);
    }
    await closeSettings();
    await endClaude();
  }, 60_000);

  it('focus mode (⌥⌘F, the palette): the title bar, the tool strip, the pins and the companion fade to 15 % and come back; the app is told; the palette entry reads Leave focus mode while it is on; no fade animation with Animations off', async () => {
    await endClaude();
    await page.evaluate(() => ((window as any).__focusCalls = []));
    // a pin to fade (selecting a line of what is on the screen)
    await page.click('.term');
    await page.evaluate(() => {
      const t = (window as any).__jaffer.terminals.get('main').term;
      const b = t.buffer.active;
      for (let y = b.length - 1; y >= 0; y--) if (b.getLine(y)!.translateToString(true).trim()) return void t.selectLines(y, y);
    });
    await menu('pin-selection');
    await page.waitForSelector('.pins .pin');
    const sel = ['.titlebar', '.tool-strip', '.pins', '.pet-corner'];
    const opacity = (q: string) => page.$eval(q, (el) => getComputedStyle(el).opacity);
    const before = await Promise.all(sel.map(opacity));
    expect(before.every((o) => parseFloat(o) > 0.9)).toBe(true);
    expect(await page.getAttribute('.app', 'data-focus')).toBeNull();
    await menu('focus-mode');
    await page.waitForSelector(".app[data-focus='1']");
    await until(async () => (await Promise.all(sel.map(opacity))).every((o) => parseFloat(o) === 0.15), 3_000, 'all four to fade');
    expect(await page.$eval('.titlebar', (el) => getComputedStyle(el).transitionDuration)).toBe('0.25s');
    expect(await page.$eval('.terminal-area .term', (el) => getComputedStyle(el).opacity)).toBe('1'); // the terminal itself does not
    expect(await page.evaluate(() => (window as any).__focusCalls)).toEqual([true]);
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette-list');
    expect(await page.textContent('.palette-list')).toContain('Leave focus mode');
    await page.keyboard.press('Escape');
    await menu('focus-mode');
    await page.waitForSelector(".app[data-focus='1']", { state: 'detached' });
    await until(async () => (await Promise.all(sel.map(opacity))).every((o, i) => o === before[i]), 3_000, 'all four to come back');
    expect(await page.evaluate(() => (window as any).__focusCalls)).toEqual([true, false]);
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette-list');
    expect(await page.textContent('.palette-list')).toContain('Focus mode');
    expect(await page.textContent('.palette-list')).not.toContain('Leave focus mode');
    await page.keyboard.press('Escape');
    // Animations off: it fades at once, with no transition
    await cfgPatch({ appearance: { animations: false } });
    await menu('focus-mode');
    await page.waitForSelector(".app[data-focus='1']");
    expect(await page.$eval('.titlebar', (el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    expect(parseFloat(await opacity('.titlebar'))).toBe(0.15);
    await menu('focus-mode');
    await page.waitForSelector(".app[data-focus='1']", { state: 'detached' });
    await cfgPatch({ appearance: { animations: true } });
    await page.locator('.pins .pin button').click(); // unpin
    await page.evaluate(() => ((window as any).__jaffer.terminals.get('main').term.clearSelection()));
  }, 30_000);

  it('Ctrl-L erases what is on the screen: a block keeps the part of its output above it, and copying nothing says so, never a false "Copied"', async () => {
    await page.evaluate(() => {
      const clip = { written: [] as string[] };
      (window as any).__eraseClip = clip;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t: string) => void clip.written.push(t) } });
    });
    const copies = () => page.evaluate(() => ((window as any).__eraseClip.written as string[]).slice());
    const term = (fn: string, arg?: number) => page.evaluate(([f, a]) => (window as any).__jaffer.terminals.get('main').term[f as string](a), [fn, arg] as const);
    await page.click('.term');
    await enter('true'); // no output at all
    await ended('true');
    await (await markOf('true')).click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: 'Copy output' }).click();
    await toastSaid('Nothing to copy');
    expect(await copies()).toEqual([]);
    await (await markOf('true')).click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: 'Save output…' }).click();
    await sleep(300);
    expect(await page.evaluate(() => ((window as any).__saved ?? []).filter((x: { name: string }) => x.name === 'true-output.txt').length)).toBe(0);

    await page.click('.term');
    await enter('seq 1 200');
    const seq = await ended('seq 1 200');
    await page.keyboard.press('Control+l');
    await until(async () => !(await termText()).split('\n').slice(-60).some((l) => l === '200'), 5_000, 'the screen to be erased');
    await term('scrollToLine', seq.promptLine);
    await (await markOf('seq 1 200')).click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: 'Copy output' }).click();
    await until(async () => (await copies()).length === 1, 3_000, 'the part left to be copied');
    const left = (await copies())[0]!.split('\n');
    expect(left.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(left.length).toBeLessThan(200); // the erased lines are not copied as blank lines
    expect(left.every((l, i) => l === String(i + 1))).toBe(true);
    await term('scrollToBottom');
  }, 40_000);

  // (last: ESC c wipes the scrollback, which the reload test above reads)
  it('Clear and a full reset (ESC c) take the blocks along: an open gutter menu closes, no stale marks, no stale prompt to jump to', async () => {
    await page.click('.term');
    await enter('echo before-clear-91');
    await (await markOf('echo before-clear-91')).click({ button: 'right' });
    await page.waitForSelector('.ctx-menu');
    await menu('clear'); // ⌘K: the lines above the prompt leave the scrollback, their blocks with them, and the menu of one
    await page.waitForSelector('.ctx-menu', { state: 'detached' });
    await until(async () => !(await blocks()).some((b) => b.cmd === 'echo before-clear-91'), 5_000, 'the cleared block to go');
    await page.click('.term');
    await enter('echo before-reset-92'); // the prompt that waited through ⌘K still makes a block of its command
    expect(await (await markOf('echo before-reset-92')).getAttribute('data-state')).toBe('ok');
    await page.keyboard.press('Control+l'); // and through Ctrl-L (the shell erases the screen and draws the prompt again)
    await enter('echo after-ctrl-l-94');
    expect(await (await markOf('echo after-ctrl-l-94')).getAttribute('data-state')).toBe('ok');
    expect(await shownMarks()).toBeGreaterThanOrEqual(1);
    await enter("printf '\\033c'");
    await until(async () => (await page.locator('.xterm-decoration.gutter-mark').count()) === 0, 5_000, 'every mark gone with the reset');
    expect((await blocks()).filter((b) => b.cmd !== undefined)).toEqual([]);
    const top = await viewTop();
    await menu('prompt-prev');
    await menu('prompt-next');
    expect(await viewTop()).toBe(top);
    await enter('echo after-reset-93');
    expect(await (await markOf('echo after-reset-93')).getAttribute('data-state')).toBe('ok'); // and blocks go on from there
  }, 40_000);

});

void ensureDaemon;
