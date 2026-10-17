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
import { RELEASE_NOTES } from '../../src/generated/release-notes';
import { parseMd } from '../../src/shared/mini-md';
import { seasonOf } from '../../src/shared/season';
import { unseenNotes } from '../../src/shared/whats-new';
import { paneGrid } from '../../src/shared/pane-grid';
import { GLOSSARY, glossaryEntry, searchGlossary } from '../../src/shared/glossary';
import { TOUR_STEPS } from '../../src/shared/tour';

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
  // (1.4.0) first-time tips and the tour's offer stay out of the way of the other tests: the Learn tests below switch them on for themselves
  fs.mkdirSync(env.home, { recursive: true });
  fs.writeFileSync(env.paths.config, JSON.stringify({ tips: { enabled: false }, tour: { done: true } }));
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
    // ⇧⌘R does nothing while this screen is up (as What's New): it reads no list and resumes nothing
    await page.evaluate(() => {
      const w = window as any;
      w.__obReads = 0;
      w.__obReal = w.jaffer.call;
      w.jaffer.call = (m: string, p: unknown) => (m === 'claude.history' && w.__obReads++, w.__obReal(m, p));
    });
    await page.evaluate(() => (window as any).__menu('resume-last'));
    await sleep(400);
    expect(await page.evaluate(() => (window as any).__obReads)).toBe(0);
    await page.evaluate(() => ((window as any).jaffer.call = (window as any).__obReal));
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).onboarded).toBe(false); // not done until they say so
    await shot('01-onboarding');

    // 1.4.0: Get started leads to the last stage, Privacy and permissions; nothing is done until "Looks good"
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard[data-step="privacy"]');
    expect(await page.locator('.onboard .btn.primary').textContent()).toBe('Looks good');
    expect(await page.locator('.onboard .pv-list .field').count()).toBe(5);
    expect(await page.locator('.onboard .pv-locked').count()).toBe(1);
    const defaults = async () => page.$$eval('.onboard .pv-list .field input[type="checkbox"]', (b) => b.map((x) => (x as HTMLInputElement).checked));
    expect(await defaults()).toEqual([false, false, true, true, false]);
    await page.locator('.onboard .pv-list .field', { hasText: 'Move conversations to the Trash' }).locator('.switch').click(); // a switch writes at once
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).permissions.trash === false, 5_000, 'the trash switch to be written');
    await page.locator('.onboard .pv-list .field', { hasText: 'Move conversations to the Trash' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).permissions.trash === true, 5_000, 'the trash switch to be written again');
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).onboarded).toBe(false); // still not done
    await page.keyboard.press('Escape');
    expect(await page.locator('.onboard').count()).toBe(1); // and it cannot be dismissed
    await shot('01c-onboarding-privacy');
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

  it('a calm window: only the terminal, the title bar, the mole and the one side panel, whatever keys are pressed', async () => {
    for (const k of ['Meta+j', 'Meta+Shift+M']) await page.keyboard.press(k); // the Claude panel and the memory drawer are gone (⌘B is the side panel's since 1.1.0)
    await sleep(300);
    expect(await page.locator('.rail, .statusbar, .agent, .panel-head, .side').count()).toBe(0);
    // 1.0.0 allows command blocks inside the card (gutter marks, the sticky command header, the gutter menu), up to three pinned lines and
    // the paste question; still no drawer, other panel or tab
    expect(await page.locator('.sidebar, .drawer, .panel, .tabs, .tab').count()).toBe(0);
    expect(await page.$$eval('.terminal-area > *', (els) => els.map((e) => e.className).filter((c) => !/^(panes|pet-corner|sticky-cmd|findbar|pins|paste-bar)\b/.test(c)))).toEqual([]);
    // 1.1.0: the one side panel (⌘B) sits beside the card; nothing else does
    expect(await page.$$eval('.workspace > *', (els) => els.map((e) => e.className).filter((c) => !/^(terminal-area|side-panel)\b/.test(c)))).toEqual([]);
    expect(await page.locator('.side-panel').count()).toBe(1);
    // and the 2 px tool strip under the title bar (feature 6): nothing else between the title bar and the card
    expect(await page.$$eval('.stage > *', (els) => els.map((e) => e.className).filter((c) => !/^(titlebar|tool-strip|daemon-banner|workspace)\b/.test(c)))).toEqual([]);
    expect(await page.locator('.titlebar .seg-btn, .titlebar .seg').count()).toBe(0); // the folder, the branch, the ring, the cost
    expect(await page.locator('.titlebar button:not(.panel-toggle)').count()).toBe(0); // and one button: the side panel's
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
    await page.click('.onboard .btn.primary'); // (1.4.0: then the privacy stage, which a plain terminal sees too)
    await page.waitForSelector('.onboard[data-step="privacy"]');
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
    await page.waitForSelector('.onboard[data-step="privacy"]'); // (1.4.0)
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

  it('companion size: a select in Settings writes appearance.petSize, the corner scales from its bottom right, takes no clicks and stays inside the terminal', async () => {
    const setApp = (appearance: object) => page.evaluate((a) => window.jaffer.call('config.patch', { appearance: a }), appearance);
    const corner = '.pet-corner';
    const size = () => page.evaluate(async () => ((await window.jaffer.call('config.get')) as any).appearance.petSize);
    const box = async () => (await page.locator(corner).boundingBox())!;
    await setApp({ companion: 'mole', petSize: 'normal' });
    await page.waitForSelector(`${corner}[data-companion='mole'] .pet`);
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Appearance' }).click();
    const select = page.locator('.settings .field', { hasText: 'Companion size' }).locator('select');
    await until(async () => (await select.inputValue()) === 'normal', 5_000, 'the select at Normal');
    await until(async () => ['1', 'none'].includes(await page.$eval(corner, (el) => getComputedStyle(el).scale)), 5_000, 'the corner at its normal scale');
    expect(await page.textContent('.settings .field:has(select option[value="huge"])')).toContain('Makes the mole or the scene bigger or smaller in the corner.');
    const normal = await box();
    const factors: Record<string, number> = { small: 0.75, normal: 1, large: 1.5, huge: 2.25 };
    for (const [id, f] of Object.entries(factors)) {
      await select.selectOption(id);
      await until(async () => (await size()) === id, 5_000, `petSize ${id} in the config`);
      await until(async () => Math.abs((await box()).width / normal.width - f) < 0.02, 5_000, `the corner at ${f}x`);
      expect(Math.abs((await box()).height / normal.height - f)).toBeLessThan(0.02);
      const b = await box();
      expect(Math.abs(b.x + b.width - (normal.x + normal.width))).toBeLessThan(1); // anchored at the bottom right
      expect(Math.abs(b.y + b.height - (normal.y + normal.height))).toBeLessThan(1);
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    const term = (await page.locator('.terminal-area').boundingBox())!;
    for (const companion of ['mole', 'matrix']) {
      await setApp({ companion, petSize: 'huge' });
      await page.waitForSelector(`${corner}[data-companion='${companion}']`);
      // the cap is applied by an effect after the first layout: wait for the settled scale
      await until(async () => {
        const sc = Number(await page.$eval(corner, (el) => getComputedStyle(el).scale));
        return companion === 'mole' ? sc === 2.25 : sc > 1.5 && sc < 2.25;
      }, 5_000, `${companion}: the corner at its settled huge scale`);
      const b = await box();
      expect(b.x).toBeGreaterThanOrEqual(term.x - 0.5);
      expect(b.y).toBeGreaterThanOrEqual(term.y - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(term.x + term.width + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(term.y + term.height + 0.5);
      expect(await page.$eval(corner, (el) => getComputedStyle(el).pointerEvents)).toBe('none');
      const scale = Number(await page.$eval(corner, (el) => getComputedStyle(el).scale));
      if (companion === 'mole') expect(scale).toBe(2.25);
      else expect(scale).toBeLessThan(2.25); // the scene would be wider than half of the terminal: the cap holds it back (and it is still bigger than normal)
      expect(scale).toBeGreaterThan(1.5);
      expect(await page.$eval(corner, (el) => (el.getBoundingClientRect().width))).toBeLessThanOrEqual(term.width / 2 + 0.5); // never more than half the terminal's width
    }
    await setApp({ companion: 'mole', petSize: 'giant' }); // an unknown value counts as normal
    await until(async () => Math.abs((await box()).width - normal.width) < 0.5, 5_000, 'an unknown size to draw as normal');
    await setApp({ petSize: 'normal' });
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

  it('approvals (1.2.0): a prompt that waits for a click asks in the title bar and the Now card with a countdown; only a click answers (Allow or Deny, with its id); the buttons go with it', async () => {
    await endClaude();
    await inject([]);
    await cfgPatch({ panel: { open: true } });
    // the answers are recorded here, not sent (the daemon has no such prompt)
    await page.evaluate(() => {
      const w = window as any;
      w.__apCalls = [];
      w.__apReal = w.jaffer.call;
      w.jaffer.call = (m: string, p: unknown) => (m === 'claude.approval.answer' ? (w.__apCalls.push(p), Promise.resolve({ ok: true })) : w.__apReal(m, p));
    });
    const calls = () => page.evaluate(() => (window as any).__apCalls as { id: string; decision: string }[]);
    const push = (d: object) => page.evaluate((x) => (window as any).__event('claude.approvals', x), d);
    const chip = '.session-pill .needs-chip[data-approval]';
    const card = '.now-card';
    try {
      const a = { id: 'ap-1', sessionId: 'ap-sess', tool: 'Bash', detail: 'npm test', allowable: true, expiresAt: Date.now() + 15_000 };
      await push({ items: [a] });
      await page.waitForSelector(chip);
      expect(await page.locator(`${chip} .alert-dot`).count()).toBe(1);
      expect(await textOf(`${chip} .ap-text`)).toMatch(/^Bash · Waiting for your answer \(1[45] s\)$/);
      expect(await page.getAttribute(chip, 'title')).toBe('Claude asks to use Bash: npm test');
      // the chip offers Deny and "Answer in terminal" only: Allow lives in the card, next to the whole request
      expect(await page.$$eval(`${chip} button`, (els) => els.map((e) => e.textContent))).toEqual(['Deny', 'Answer in terminal']);
      await page.waitForSelector(`${card}[data-state="needs-you"] .ap-ask[data-id="ap-1"]`);
      expect(await textOf(`${card} .ap-detail`)).toBe('npm test');
      expect(await page.$$eval(`${card} .ap-btns button`, (els) => els.map((e) => e.textContent))).toEqual(['Deny', 'Allow', 'Answer in terminal']);
      expect(await page.locator(`${card} .now-hint`).count()).toBe(0); // (no prompt in the terminal to answer yet)
      await until(async () => /\(1[23] s\)/.test((await textOf(`${chip} .ap-text`)) ?? ''), 5_000, 'the countdown');
      await shot('28b-approval');
      // nothing answers without a click: Enter and Space on a focused Allow, a click a script makes
      await page.focus(`${card} .ap-allow`);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await page.$eval(`${card} .ap-allow`, (b) => (b as HTMLButtonElement).click());
      await page.$eval(`${card} .ap-allow`, (b) => b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
      expect(await page.getAttribute(`${card} .ap-allow`, 'tabindex')).toBe('-1'); // (not in the keyboard's way)
      await sleep(400);
      expect(await calls()).toEqual([]);
      // a click on Allow answers allow for that id; the terminal keeps the keyboard
      await page.click('.term');
      await page.click(`${card} .ap-allow`);
      await until(async () => (await calls()).length === 1, 3_000, 'the allow');
      expect(await calls()).toEqual([{ id: 'ap-1', decision: 'allow' }]);
      expect(await page.evaluate(() => !!document.activeElement?.closest('.term'))).toBe(true);
      // the next one: Deny in the title bar
      await push({ items: [{ ...a, id: 'ap-2', tool: 'Write', detail: 'src/a.ts' }], answered: { sessionId: 'ap-sess', tool: 'Bash' } });
      await page.waitForSelector(`${chip} .ap-ask[data-id="ap-2"]`);
      await page.click(`${chip} .ap-deny`);
      await until(async () => (await calls()).length === 2, 3_000, 'the deny');
      expect((await calls())[1]).toEqual({ id: 'ap-2', decision: 'deny' });
      // "Answer in terminal": the hook lets go (ask), Claude Code's own prompt follows
      await push({ items: [{ ...a, id: 'ap-3' }] });
      await page.waitForSelector(`${chip} .ap-ask[data-id="ap-3"]`);
      await page.click(`${chip} .ap-term`);
      await until(async () => (await calls()).length === 3, 3_000, 'the ask');
      expect((await calls())[2]).toEqual({ id: 'ap-3', decision: 'ask' });
      // answered or timed out, the daemon's list empties: the buttons go, and the chip is the plain one again
      await push({ items: [], answered: { sessionId: 'ap-sess', tool: 'Write' } });
      await until(async () => (await page.locator('.ap-ask').count()) === 0, 3_000, 'the buttons to go');
      expect(await page.locator('.session-pill .needs-chip').count()).toBe(0);
      // an answer from here counts as an answered prompt: the next time Bash asks in the terminal it is the 2nd
      await inject([{ id: 'ap-sess', state: 'needs-you', turnStartedAtAgo: 5_000, tool: { name: 'Bash', id: 't9' } }]);
      await until(async () => /Bash.*· 2nd time/.test((await page.textContent('.session-pill .needs-chip')) ?? ''), 4_000, 'the 2nd time');
      expect(await page.locator('.ap-ask').count()).toBe(0);
      expect((await calls()).length).toBe(3); // nothing else was ever answered
    } finally {
      await page.evaluate(() => {
        const w = window as any;
        w.jaffer.call = w.__apReal;
      });
      await push({ items: [] });
      await inject([]);
    }
  }, 30_000);

  it('approvals: Allow arms 750 ms after its request shows (a double-click allows only the first of two), and is not offered for a request that is not shown whole', async () => {
    await endClaude();
    await inject([]);
    await cfgPatch({ panel: { open: true } });
    await page.evaluate(() => {
      const w = window as any;
      w.__apCalls = [];
      w.__apReal = w.jaffer.call;
      w.jaffer.call = (m: string, p: unknown) => (m === 'claude.approval.answer' ? (w.__apCalls.push(p), Promise.resolve({ ok: true })) : w.__apReal(m, p));
    });
    const calls = () => page.evaluate(() => (window as any).__apCalls as { id: string; decision: string }[]);
    const push = (d: object) => page.evaluate((x) => (window as any).__event('claude.approvals', x), d);
    const allow = '.now-card .ap-allow';
    try {
      const a1 = { id: 'arm-1', sessionId: 'arm-sess', tool: 'Bash', detail: 'npm test', allowable: true, expiresAt: Date.now() + 15_000 };
      const a2 = { ...a1, id: 'arm-2', detail: 'rm -rf build' };
      await push({ items: [a1, a2] });
      await page.waitForSelector(`${allow}[aria-disabled="true"]`); // not armed yet: it looks so
      expect(await page.$eval(allow, (el) => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
      // a real click at once (page.click itself waits for the element to settle, longer than the delay)
      const clickNow = async () => {
        const b = await page.$eval(allow, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await page.mouse.click(b.x, b.y);
      };
      await clickNow(); // inside the arming delay: nothing
      await sleep(200);
      expect(await calls()).toEqual([]);
      await page.waitForSelector(`${allow}:not([aria-disabled])`, { timeout: 2_000 });
      // a double-click: only the first click counts, for the first request; the second stays waiting
      const b = await page.$eval(allow, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.dblclick(b.x, b.y);
      await sleep(300);
      expect(await calls()).toEqual([{ id: 'arm-1', decision: 'allow' }]);
      // the daemon takes the first away: the second shows, and its Allow arms afresh
      await push({ items: [a2] });
      await page.waitForSelector(`.now-card .ap-ask[data-id="arm-2"] .ap-allow[aria-disabled="true"]`);
      await clickNow();
      await sleep(200);
      expect(await calls()).toHaveLength(1);
      await page.waitForSelector(`${allow}:not([aria-disabled])`, { timeout: 2_000 });
      await page.click(allow);
      await until(async () => (await calls()).length === 2, 3_000, 'the second allow');
      expect((await calls())[1]).toEqual({ id: 'arm-2', decision: 'allow' });
      // a request that is not shown whole: no Allow anywhere, a word on why, Deny and "Answer in terminal" stay
      await push({ items: [{ ...a1, id: 'arm-3', detail: 'echo xxxxx… (+250 chars)', allowable: false }] });
      await page.waitForSelector('.now-card .ap-ask[data-id="arm-3"]');
      await sleep(900);
      expect(await page.locator('.ap-allow').count()).toBe(0);
      expect(await textOf('.now-card .ap-why')).toMatch(/terminal/);
      expect(await page.$$eval('.now-card .ap-btns button', (els) => els.map((e) => e.textContent))).toEqual(['Deny', 'Answer in terminal']);
      // the whole line wraps in the card: nothing of it is hidden
      await push({ items: [{ ...a1, id: 'arm-4', detail: `echo ${'word '.repeat(22)}`.trim() }] });
      await page.waitForSelector('.now-card .ap-ask[data-id="arm-4"]');
      expect(await page.$eval('.now-card .ap-detail', (el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).whiteSpace !== 'nowrap')).toBe(true);
    } finally {
      await page.evaluate(() => {
        const w = window as any;
        w.jaffer.call = w.__apReal;
      });
      await push({ items: [] });
    }
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
    await until(async () => (await page.$eval(chip, (el) => getComputedStyle(el).color)) === warn, 15_000, 'the chip in the warn colour'); // (after its 1.6 s flash, which a loaded machine stretches)
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
      for (const sel of ['.session-pill .running', '.session-pill .needs-chip', '.session-pill .edit-chip', '.session-pill .git-stat', '.session-pill .cwd-box', '.titlebar .cost-wrap', '[data-cost-chip]', '.titlebar .sys-stats', '.titlebar .panel-toggle'])
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

  it('Settings → Appearance → Window: what closing does, the menu bar icon, menu bar only (needs the icon) and the menu bar text, each written to window.*', async () => {
    const win = async () => (await page.evaluate(() => window.jaffer.call('config.get'))).window;
    const field = (label: string) => page.locator('label.field', { hasText: label });
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Appearance' }).click();
    try {
      expect(await win()).toEqual({ closeAction: 'menubar', menuBar: true, menuBarOnly: false, menuBarTitle: 'off', hintShown: false, dropdown: false });
      const close = field('When I close the window').locator('select');
      expect(await close.inputValue()).toBe('menubar');
      expect(await close.locator('option').allTextContents()).toEqual(['Hide to the menu bar', 'Quit Jaffer', 'Ask']);
      await close.selectOption('ask');
      await until(async () => (await win()).closeAction === 'ask', 5_000, 'closeAction ask');
      await close.selectOption('quit');
      await until(async () => (await win()).closeAction === 'quit', 5_000, 'closeAction quit');
      await close.selectOption('menubar');
      await until(async () => (await win()).closeAction === 'menubar', 5_000, 'closeAction back to menubar');

      const title = field('Menu bar text').locator('select');
      expect(await title.locator('option').allTextContents()).toEqual(['Nothing', 'This session’s cost', 'Running turn', 'Today’s cost']);
      for (const v of ['cost', 'time', 'today', 'off']) {
        await title.selectOption(v);
        await until(async () => (await win()).menuBarTitle === v, 5_000, `menuBarTitle ${v}`);
      }

      const menuBar = field('Show Jaffer in the menu bar');
      const only = field('Only in the menu bar');
      expect(await menuBar.locator('input').isChecked()).toBe(true);
      expect(await only.locator('input').isDisabled()).toBe(false);
      await only.locator('.switch').click();
      await until(async () => (await win()).menuBarOnly === true, 5_000, 'menu bar only on');
      // the icon off: menu bar only cannot be on without it (the switch shows off and is disabled; the Dock icon comes back)
      await menuBar.locator('.switch').click();
      await until(async () => (await win()).menuBar === false, 5_000, 'the menu bar icon off');
      await until(async () => only.locator('input').isDisabled(), 5_000, 'menu bar only disabled');
      expect(await only.locator('input').isChecked()).toBe(false);
      await menuBar.locator('.switch').click();
      await until(async () => (await win()).menuBar === true, 5_000, 'the menu bar icon on again');
      await until(async () => !(await only.locator('input').isDisabled()), 5_000, 'menu bar only enabled again');
      await only.locator('.switch').click();
      await until(async () => (await win()).menuBarOnly === false, 5_000, 'menu bar only off');
      expect((await win()).hintShown).toBe(false); // (the main process sets it, the first time the window hides)

      const dropdown = field('Drop-down mode');
      expect(await dropdown.locator('input').isChecked()).toBe(false);
      await dropdown.locator('.switch').click();
      await until(async () => (await win()).dropdown === true, 5_000, 'drop-down mode on');
      await dropdown.locator('.switch').click();
      await until(async () => (await win()).dropdown === false, 5_000, 'drop-down mode off');
      expect(await dropdown.textContent()).toContain('the hotkey brings Jaffer down at the top of the screen under the pointer; it hides when you click elsewhere. Needs the hotkey');
      // no hotkey: the switch is disabled (and shows off)
      await cfgPatch({ hotkey: '', window: { dropdown: true } });
      await until(async () => dropdown.locator('input').isDisabled(), 5_000, 'drop-down disabled without a hotkey');
      expect(await dropdown.locator('input').isChecked()).toBe(false);
      await cfgPatch({ hotkey: 'Control+`', window: { dropdown: false } });
      await until(async () => !(await dropdown.locator('input').isDisabled()), 5_000, 'drop-down enabled with the hotkey');
    } finally {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.settings', { state: 'detached' });
    }
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
    expect(await page.$$eval('.ctx-menu button', (b) => b.map((x) => x.textContent))).toEqual(['Copy command', 'Copy output', 'Save output…', 'Copy as Markdown', 'Copy as image']);
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
    expect(await page.$$eval('.ctx-menu button', (b) => b.map((x) => x.textContent))).toEqual(['Copy output', 'Save output…', 'Copy as Markdown', 'Copy as image']);
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

  it('Copy as image (1.2.0): the gutter menu puts a PNG of the command and its output on the clipboard, never a sensitive command\'s line; a refusing clipboard says so', async () => {
    // the clipboard's write is caught (the PNG kept), and what the canvas draws is read off fillText
    await page.evaluate(() => {
      const w = window as any;
      w.__img = { blobs: [] as Blob[], refuse: false };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: async () => '',
          writeText: async () => undefined,
          write: async (items: ClipboardItem[]) => {
            if (w.__img.refuse) throw new Error('refused');
            w.__img.blobs.push(await items[0]!.getType('image/png'));
          },
        },
      });
      w.__drawn = [] as string[];
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, max?: number) {
        w.__drawn.push(text);
        return max === undefined ? fill.call(this, text, x, y) : fill.call(this, text, x, y, max);
      };
    });
    const png = () =>
      page.evaluate(async () => {
        const b = ((window as any).__img.blobs as Blob[]).at(-1)!;
        return { type: b.type, size: b.size, head: [...new Uint8Array(await b.arrayBuffer()).slice(0, 8)] };
      });
    const pick = async (cmd: string) => {
      await page.evaluate(() => ((window as any).__drawn = []));
      await (await markOf(cmd)).click({ button: 'right' });
      await page.waitForSelector('.ctx-menu');
      await page.locator('.ctx-menu button', { hasText: 'Copy as image' }).click();
      await page.waitForSelector('.ctx-menu', { state: 'detached' });
    };
    await pick('echo hi-block');
    await until(async () => page.evaluate(() => (window as any).__img.blobs.length === 1), 5_000, 'the image on the clipboard');
    const p = await png();
    expect(p.type).toBe('image/png');
    expect(p.head).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(p.size).toBeGreaterThan(500);
    expect(p.size).toBeLessThan(2_000_000);
    expect(await page.evaluate(() => (window as any).__drawn)).toEqual(['$ echo hi-block', 'hi-block']);
    await toastSaid('Copied as image');
    // a sensitive command: its output only, no `$` line
    await page.click('.term');
    await enter('echo $NO_SUCH_TOKEN seen-out');
    await pick('echo $NO_SUCH_TOKEN seen-out');
    await until(async () => page.evaluate(() => (window as any).__img.blobs.length === 2), 5_000, 'the second image');
    const drawn: string[] = await page.evaluate(() => (window as any).__drawn);
    expect(drawn.map((t) => t.trim())).toEqual(['seen-out']);
    expect(drawn.some((t) => t.startsWith('$') || /NO_SUCH_TOKEN/.test(t))).toBe(false);
    // a sensitive command with no output: nothing to draw, so no blank image
    await pick('echo $NO_SUCH_TOKEN');
    await toastSaid('Nothing to copy');
    expect(await page.evaluate(() => (window as any).__drawn)).toEqual([]);
    // the clipboard refuses: an error toast, nothing kept
    await page.evaluate(() => ((window as any).__img.refuse = true));
    await pick('echo hi-block');
    await toastSaid('Could not copy the image to the clipboard.');
    expect(await page.evaluate(() => (window as any).__img.blobs.length)).toBe(2);
    // no canvas to draw on: the same error toast, nothing kept
    await page.evaluate(() => ((window as any).__img.refuse = false));
    const failToasts = () => page.locator('.toast-text', { hasText: 'Could not copy the image to the clipboard.' }).count();
    const before = await failToasts();
    await page.evaluate(() => {
      const w = window as any;
      w.__getContext = HTMLCanvasElement.prototype.getContext;
      (HTMLCanvasElement.prototype as any).getContext = () => null;
    });
    await pick('echo hi-block');
    await until(async () => (await failToasts()) > before, 5_000, 'a second error toast');
    await page.evaluate(() => ((HTMLCanvasElement.prototype as any).getContext = (window as any).__getContext));
    expect(await page.evaluate(() => (window as any).__img.blobs.length)).toBe(2);
  }, 40_000);

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

  it('⌘R by folder (1.2.0): the toggle groups the commands under the folder they ran in, the newest folder first; Enter still only copies', async () => {
    await clipStub();
    for (const d of ['rc-alpha', 'rc-beta']) fs.mkdirSync(path.join(env.userHome, d), { recursive: true });
    await page.click('.term');
    for (const line of ['rc_back=$PWD; cd ~/rc-alpha', 'echo in-alpha-61', 'cd ~/rc-beta', 'echo in-beta-62', 'cd "$rc_back"']) {
      await enter(line);
      await ended(line);
    }
    await menu('recent-commands');
    await page.waitForSelector('.recent-list input');
    expect(await page.locator('.recent-list .rc-folder').count()).toBe(0);
    await page.click('.recent-list .rc-toggle');
    await until(async () => (await page.locator('.recent-list .rc-folder').count()) >= 2, 3_000, 'the folder groups');
    expect(await page.getAttribute('.recent-list .rc-toggle', 'aria-pressed')).toBe('true');
    const order = await page.$$eval('.recent-list .palette-list > *', (els) => els.map((e) => (e.classList.contains('rc-folder') ? `# ${e.textContent}` : (e.querySelector('.recent-cmd')?.textContent ?? ''))));
    const beta = order.findIndex((t) => t.startsWith('# ') && t.endsWith('/rc-beta'));
    const alpha = order.findIndex((t) => t.startsWith('# ') && t.endsWith('/rc-alpha'));
    expect(beta).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeGreaterThan(beta); // the newest folder first
    expect(order.slice(beta + 1, beta + 3)).toEqual(['cd "$rc_back"', 'echo in-beta-62']); // newest first within a folder
    expect(order.slice(alpha + 1).find((t) => !t.startsWith('# '))).toBe('cd ~/rc-beta'); // (a command counts in the folder it was typed in)
    expect(order.slice(alpha + 1)).toContain('echo in-alpha-61');
    await shot('21b-recent-by-folder');
    const before = await termText();
    await page.locator('.recent-list .recent-cmd', { hasText: 'echo in-alpha-61' }).click();
    await page.waitForSelector('.recent-list', { state: 'detached' });
    await until(async () => (await page.evaluate(() => (window as any).__powerClip.written.at(-1))) === 'echo in-alpha-61', 3_000, 'the command on the clipboard');
    await sleep(300);
    expect(await termText()).toBe(before); // nothing typed
  }, 40_000);

  it('⌘/ (1.2.0): the shortcuts sheet lists the keys by section, the search narrows it, Esc closes it and the terminal has the keys again', async () => {
    await page.click('.term');
    await menu('shortcuts');
    await page.waitForSelector('.ks-sheet input');
    expect(await page.evaluate(() => document.activeElement?.matches('.ks-sheet input'))).toBe(true);
    const sections = await page.$$eval('.ks-sheet .pal-group', (g) => g.map((x) => x.textContent));
    expect(sections).toEqual(['View', 'Terminal', 'App']);
    const keys = await page.$$eval('.ks-sheet kbd', (k) => k.map((x) => x.textContent));
    for (const k of ['⌘/', '⌘R', '⇧⌘R', '⌘B', '⌘P', '⌘←', '⇧↵']) expect(keys).toContain(k);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    await sleep(300); // (the dialog's entrance has settled)
    await shot('21c-shortcuts');
    await page.keyboard.type('find');
    await until(async () => (await page.locator('.ks-sheet .ks-row').count()) === 3, 3_000, 'the search');
    expect(await page.$$eval('.ks-sheet .ks-row kbd', (k) => k.map((x) => x.textContent))).toEqual(['⌘F', '⌘G', '⇧⌘G']);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ks-sheet', { state: 'detached' });
    await until(async () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')), 3_000, 'the terminal to have the keys again');
  }, 30_000);

  // 1.1.0: replaces the 1.0.1 test of the ⇧⌘O overlay ("⇧⌘O lists past Claude conversations from the transcripts; …"), deliberately: the list moved into the side panel
  it('past conversations in the side panel: planted transcripts by day with their titles, the title and folder search, a click or Enter resumes (the line it types is caught here; a bad id never), ↑/↓/Esc, ⇧⌘O opens a closed panel with the search focused, read on open, after a turn and on refresh (never while closed), nothing else typed', async () => {
    await clipStub();
    const T = Date.now();
    const d0 = new Date(T);
    const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
    const sid = (n: number) => `0000000${n}`.slice(-8) + '-aaaa-4bbb-8ccc-ddddeeeeffff';
    const plant = (n: number, proj: string, end: number, cwd: string) => {
      const dir = path.join(env.userHome, '.claude', 'projects', proj);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sid(n)}.jsonl`);
      const line = (type: string, at: number, extra: object) => JSON.stringify({ type, cwd, timestamp: new Date(at).toISOString(), ...extra });
      // the first message is the title; a later one never shows
      fs.writeFileSync(file, [line('user', end - 90_000, { message: { role: 'user', content: `Title of ${proj.slice(1)}` } }), line('user', end - 60_000, { message: { role: 'user', content: 'SECRET-WORDS' } }), line('assistant', end, { message: { id: `m${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET-REPLY' }], usage: { input_tokens: 1000, output_tokens: 500 } } })].join('\n') + '\n');
      fs.utimesSync(file, end / 1000, end / 1000);
    };
    const endA = Math.max(T - 60_000, midnight + 1000); // today
    const endB = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 1, 12).getTime(); // yesterday noon
    const endC = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 3, 12).getTime(); // three days ago
    plant(71, '-hist-a', endA, path.join(env.userHome, 'hist-proj-a'));
    plant(72, '-hist-b', endB, path.join(env.userHome, 'hist-proj-b'));
    plant(73, '-hist-c', endC, path.join(env.userHome, 'hist-proj-c'));
    // every claude.history call is counted; a stub can stand in for the daemon's answer; what a click types is caught (kept from the shell)
    await page.evaluate(() => {
      const w = window as any;
      w.__histReal = w.jaffer.call;
      w.__histCalls = 0;
      w.__histStub = null;
      w.__typed = [];
      w.jaffer.call = (m: string, p: any) =>
        m === 'claude.history' ? (w.__histCalls++, w.__histStub ? w.__histStub() : w.__histReal(m, p))
        : m === 'pty.write' && String(p?.data).includes('--resume') ? (w.__typed.push(p.data), w.__noStart || queueMicrotask(() => (w.__event('pty.start', { pane: 'main', cmd: 'claude' }), w.__event('pty.command', { pane: 'main', cmd: 'claude', exit: 0, durMs: 1 }))), Promise.resolve({})) // (as if the shell ran it: the next click may type again)
        : w.__histReal(m, p);
    });
    const histCalls = () => page.evaluate(() => (window as any).__histCalls as number);
    const stub = (kind: 'bad' | 'empty' | 'fail' | 'slow' | null) =>
      page.evaluate((k) => {
        const w = window as any;
        w.__histStub =
          k === 'bad' ? () => Promise.resolve({ items: [{ id: 'x; rm -rf ~', cwd: '/tmp/evil', endedAt: Date.now() }] })
          : k === 'empty' ? () => Promise.resolve({ items: [] })
          : k === 'fail' ? () => Promise.reject(new Error('history is broken'))
          : k === 'slow' ? () => new Promise((r) => setTimeout(() => r({ items: [] }), 800))
          : null;
      }, kind);
    const focused = () => page.evaluate(() => (document.activeElement?.matches('.conv-search input') ? 'search' : document.activeElement?.classList.contains('xterm-helper-textarea') ? 'terminal' : document.activeElement?.className ?? 'none'));
    const clipLast = () => page.evaluate(() => (window as any).__powerClip.written.at(-1));
    const written = () => page.evaluate(() => (window as any).__powerClip.written.length as number);
    const typedLast = () => page.evaluate(() => (window as any).__typed.at(-1) as string | undefined);
    const typedCount = () => page.evaluate(() => (window as any).__typed.length as number);
    const resumes = (n: number) => `\x05\x15\x18\x0bcd '${path.join(env.userHome, `hist-proj-${'abc'[n - 71]}`)}' && claude --resume ${sid(n)}\r`; // (the shell is elsewhere: cd first)
    const mine = () => page.$$eval('.sp-convos .conv-row[data-id^="0000007"]', (r) => r.map((x) => ({ id: (x as HTMLElement).dataset.id!, sel: (x as HTMLElement).dataset.sel !== undefined, day: x.closest('.conv-day')?.querySelector('.conv-day-label')?.textContent ?? '', text: x.textContent ?? '' })));
    const turn = (state: string) => page.evaluate((st) => { const now = Date.now(); (window as any).__event('claude.state', { sessions: [{ id: 'hist-turn', state: st, since: now, turnStartedAt: now - 2000, startedAt: now - 60_000, calls: [], counts: {}, files: [], subagents: [], turns: 1 }] }); }, state);

    if (!(await page.evaluate(() => window.jaffer.call('config.get'))).panel.open) await menu('toggle-panel');
    await page.waitForSelector('.side-panel .sp-convos .conv-search input');
    expect(await page.getAttribute('.sp-convos .conv-search input', 'placeholder')).toBe('Search titles and folders');
    await page.click('.term');
    const before = await termText();
    // the refresh button reads the list again: the three planted ones, newest first, by day
    await page.click('.sp-convos .conv-refresh');
    await until(async () => (await mine()).length === 3, 5_000, 'the three planted conversations');
    expect(await histCalls()).toBe(1);
    let rows = await mine();
    expect(rows.map((r) => r.id)).toEqual([sid(71), sid(72), sid(73)]);
    expect([rows[0]!.day, rows[1]!.day]).toEqual(['Today', 'Yesterday']);
    expect(rows[2]!.day).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( \d{4})?$/);
    const hhmm = (t: number) => `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`;
    expect(rows[0]!.text).toContain('hist-proj-a');
    expect(await page.textContent(`.sp-convos .conv-row[data-id="${sid(71)}"] .conv-name`)).toBe('Title of hist-a');
    expect(rows[0]!.text).toMatch(/~\/(\S+\/)?hist-proj-a/); // (the bridge's home is a folder above the test's HOME)
    expect(rows[0]!.text).toContain(hhmm(endA));
    expect(rows[0]!.text).toMatch(/1m 30s · ≈ \$0\.0\d/);
    expect(rows[1]!.text).toContain(hhmm(endB));
    expect(rows.some((r) => /SECRET/.test(r.text))).toBe(false);
    expect(await page.textContent('.side-panel')).not.toContain('SECRET');
    await shot('18-past-conversations');
    // the cost only with the switch
    await page.evaluate(() => window.jaffer.call('config.patch', { claude: { showCost: false } }));
    await until(async () => (await mine()).every((r) => !r.text.includes('≈')), 5_000, 'the cost to go');
    await page.evaluate(() => window.jaffer.call('config.patch', { claude: { showCost: true } }));
    await page.click('.sp-convos .conv-refresh'); // (the daemon reads token costs only with the switch on)
    await until(async () => (await mine()).some((r) => r.text.includes('≈')), 5_000, 'the cost back');
    // the search filters by folder and by title; Enter resumes the selected one and gives the keyboard back to the terminal
    await page.click('.sp-convos .conv-search input');
    await page.keyboard.type('TITLE OF HIST-C');
    await until(async () => (await mine()).length === 1 && (await mine())[0]!.id === sid(73), 3_000, 'the title filter');
    await page.fill('.sp-convos .conv-search input', '');
    await page.keyboard.type('proj-b');
    await until(async () => (await mine()).length === 1, 3_000, 'the filter');
    expect(await page.$$eval('.sp-convos .conv-row', (r) => r.length)).toBe(1);
    const copiesBefore = await written();
    await page.keyboard.press('Enter');
    await until(async () => (await typedLast()) === resumes(72), 3_000, 'the resume line typed');
    await toastSaid('Resuming…');
    expect(await focused()).toBe('terminal');
    expect(await written()).toBe(copiesBefore); // (typed, not copied)
    // ↑/↓ move the selection, Enter copies it
    await page.fill('.sp-convos .conv-search input', 'hist-proj');
    await page.focus('.sp-convos .conv-search input');
    await until(async () => (await mine()).length === 3, 3_000, 'the three again');
    expect((await mine()).map((r) => r.sel)).toEqual([true, false, false]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    expect((await mine()).map((r) => r.sel)).toEqual([false, false, true]);
    expect(await focused()).toBe('search');
    await page.keyboard.press('Enter');
    await until(async () => (await typedLast()) === resumes(73), 3_000, 'Enter on the selected row');
    // a click resumes too; the row's copy button copies the same line and types nothing
    await page.locator(`.sp-convos .conv-row[data-id="${sid(71)}"]`).click();
    await until(async () => (await typedLast()) === resumes(71), 3_000, 'the click to resume');
    let typed = await typedCount();
    await page.locator(`.sp-convos .conv-item:has(.conv-row[data-id="${sid(72)}"]) .conv-copy`).click();
    await until(async () => (await clipLast()) === resumes(72).slice(4, -1), 3_000, 'the copy button');
    await toastSaid('Copied. Paste it in the terminal.');
    expect(await typedCount()).toBe(typed);
    // a second click before the shell has started the first line types nothing and says so
    await page.evaluate(() => void ((window as any).__noStart = true));
    await page.locator(`.sp-convos .conv-row[data-id="${sid(71)}"]`).click();
    await until(async () => (await typedCount()) === typed + 1, 3_000, 'the first click to type');
    await page.locator(`.sp-convos .conv-row[data-id="${sid(72)}"]`).click();
    await toastSaid('Already resuming…');
    expect(await typedCount()).toBe(typed + 1);
    await page.evaluate(() => { const w = window as any; w.__noStart = false; w.__event('pty.start', { pane: 'main', cmd: 'claude' }); w.__event('pty.command', { pane: 'main', cmd: 'claude', exit: 0, durMs: 1 }); });
    typed = await typedCount();
    // Esc gives the keyboard back to the terminal
    await page.focus('.sp-convos .conv-search input');
    await page.keyboard.press('Escape');
    expect(await focused()).toBe('terminal');
    // Tab to a row (past the first row and its copy, name, (1.4.0) tag and hide, pin and (1.3.0) trash buttons; 1.2.0: the folder chips sit between the search and the rows):
    // Enter resumes THAT row; ↑/↓ go on from the focused row; Shift+Tab to the refresh button: Enter refreshes and types nothing
    await page.fill('.sp-convos .conv-search input', 'hist-proj');
    await until(async () => (await mine()).length === 3, 3_000, 'the three for Tab');
    await page.focus(`.sp-convos .conv-row[data-id="${sid(71)}"]`);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-copy'))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-name-btn'))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-tag-btn'))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-hide'))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-pin'))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-trash'))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe(sid(72));
    expect((await mine()).map((r) => r.sel)).toEqual([false, true, false]);
    await page.keyboard.press('Enter');
    await until(async () => (await typedLast()) === resumes(72), 3_000, 'Enter on the focused second row to resume it');
    await page.focus(`.sp-convos .conv-row[data-id="${sid(71)}"]`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe(sid(73));
    expect((await mine()).map((r) => r.sel)).toEqual([false, false, true]);
    await page.keyboard.press('Enter');
    await until(async () => (await typedLast()) === resumes(73), 3_000, 'Enter on the row the arrows reached');
    let copied = await written();
    typed = await typedCount();
    let reads = await histCalls();
    await page.focus('.sp-convos .conv-search input');
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-refresh'))).toBe(true);
    await page.keyboard.press('Enter');
    await until(async () => (await histCalls()) === reads + 1, 3_000, 'Enter on the refresh button to read the list');
    await sleep(300);
    expect(await written()).toBe(copied);
    expect(await typedCount()).toBe(typed);
    // an Enter that commits an input method's text resumes nothing
    await page.evaluate(() => document.querySelector('.sp-convos .conv-search input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await sleep(300);
    expect(await written()).toBe(copied);
    expect(await typedCount()).toBe(typed);
    await page.fill('.sp-convos .conv-search input', '');
    // a bad id from the daemon is refused: nothing typed or copied, an error says so
    const copies = await written();
    await stub('bad');
    await page.click('.sp-convos .conv-refresh');
    await page.waitForSelector('.sp-convos .conv-row[data-id="x; rm -rf ~"]');
    await page.click('.sp-convos .conv-row[data-id="x; rm -rf ~"]');
    await toastSaid('no valid id');
    await page.focus('.sp-convos .conv-search input');
    await page.keyboard.press('Enter');
    await sleep(300);
    expect(await written()).toBe(copies);
    await page.locator('.sp-convos .conv-copy').first().click();
    await sleep(300);
    expect(await written()).toBe(copies);
    expect(await typedCount()).toBe(typed);
    // empty, failing and slow
    await stub('empty');
    await page.click('.sp-convos .conv-refresh');
    await until(async () => ((await page.textContent('.sp-convos .conv-list')) ?? '').includes('No Claude Code conversations found.'), 3_000, 'the empty state');
    await stub('fail');
    await page.click('.sp-convos .conv-refresh');
    await toastSaid('history is broken');
    await until(async () => ((await page.textContent('.sp-convos .conv-note')) ?? '').includes('history is broken'), 3_000, 'the error in the panel');
    await stub('slow');
    await page.click('.sp-convos .conv-refresh');
    await page.waitForSelector('.sp-convos .conv-refresh[data-busy]');
    await page.waitForSelector('.sp-convos .conv-refresh[data-busy]', { state: 'detached' });
    expect(await page.textContent('.sp-convos .conv-list')).not.toContain('history is broken'); // (a good answer clears the error)
    await stub(null);
    await page.click('.sp-convos .conv-refresh');
    await until(async () => (await mine()).length === 3, 5_000, 'the real list again');
    // a finished turn (working → idle) reads it again, once
    let n = await histCalls();
    await turn('working');
    await sleep(200);
    expect(await histCalls()).toBe(n);
    await turn('idle');
    await until(async () => (await histCalls()) === n + 1, 3_000, 'a read after the turn');
    await sleep(300);
    expect(await histCalls()).toBe(n + 1);
    // closed, the panel reads nothing (not even after a turn)
    await page.click('.term');
    await page.keyboard.press('Meta+b');
    await page.waitForSelector('.side-panel', { state: 'detached' });
    n = await histCalls();
    await turn('working');
    await turn('idle');
    await sleep(1500);
    expect(await histCalls()).toBe(n);
    // ⇧⌘O (the menu, the menu bar's All Past Conversations…) opens it with the search focused, and it reads the list
    await menu('history');
    await page.waitForSelector('.side-panel .conv-search input');
    await until(async () => (await focused()) === 'search', 3_000, 'the search to take the keyboard');
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).panel.open).toBe(true);
    await until(async () => (await histCalls()) === n + 1, 3_000, 'a read on open');
    await until(async () => (await mine()).length === 3, 5_000, 'the list in the reopened panel');
    // open already: ⇧⌘O only focuses the search (no second read)
    await page.click('.term');
    await menu('history');
    await until(async () => (await focused()) === 'search', 3_000, 'the search to take the keyboard again');
    await sleep(300);
    expect(await histCalls()).toBe(n + 1);
    // ⌘B reopening it later does not take the keyboard from the terminal
    await page.click('.term');
    await page.keyboard.press('Meta+b');
    await page.waitForSelector('.side-panel', { state: 'detached' });
    await page.keyboard.press('Meta+b');
    await page.waitForSelector('.side-panel .conv-search input');
    await sleep(300);
    expect(await focused()).toBe('terminal');
    // no overlay is left of it, the palette still has it, and nothing was ever typed
    expect(await page.locator('.hist-list, .modal').count()).toBe(0);
    await page.evaluate(() => { const w = window as any; w.jaffer.call = w.__histReal; });
    await page.evaluate(() => (window as any).__event('claude.state', { sessions: [] }));
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('past claude');
    expect((await page.textContent('.palette-list')) ?? '').toContain('Past Claude conversations');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.palette', { state: 'detached' });
    await until(async () => (await focused()) === 'search', 3_000, 'the palette entry to focus the search');
    await page.keyboard.press('Escape');
    await sleep(500);
    expect(await termText()).toBe(before);
  }, 60_000);

  it('resume on a click (1.1.1), in a real bash: the exact line at an idle prompt (same folder; `cd` into a folder with a space and a quote), Ctrl-U clears a half-typed line, a running command or Claude gets nothing typed (copied, and why), the copy button, Enter, the title shown', async () => {
    await clipStub();
    const sid = (n: number) => `0000000${n}`.slice(-8) + '-aaaa-4bbb-8ccc-ddddeeeeffff';
    const here = path.join(env.userHome, 'resume-here');
    const odd = path.join(env.userHome, "resume it's odd");
    fs.mkdirSync(here, { recursive: true });
    fs.mkdirSync(odd, { recursive: true });
    const plant = (n: number, cwd: string, title: string) => {
      const dir = path.join(env.userHome, '.claude', 'projects', `-resume-${n}`);
      fs.mkdirSync(dir, { recursive: true });
      const at = Date.now() - 30_000 + n;
      const line = (type: string, t: number, extra: object) => JSON.stringify({ type, cwd, timestamp: new Date(t).toISOString(), ...extra });
      fs.writeFileSync(path.join(dir, `${sid(n)}.jsonl`), [line('user', at - 5000, { message: { role: 'user', content: title } }), line('assistant', at, { message: { id: `r${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }] } })].join('\n') + '\n');
    };
    plant(81, here, 'Resume here please');
    plant(82, odd, 'Resume the odd one');
    const row = (n: number) => page.locator(`.sp-convos .conv-row[data-id="${sid(n)}"]`);
    const clipLast = () => page.evaluate(() => (window as any).__powerClip.written.at(-1));
    const resumed = (dir: string, n: number) => `RESUMED:${dir}:--resume ${sid(n)}`;
    // the screen's text with wrapped rows joined (a long folder wraps)
    const flat = () => page.evaluate(() => { const b = (window as any).__jaffer.terminals.get('main').term.buffer.active; let out = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i)!; out += (l.isWrapped ? '' : '\n') + l.translateToString(true); } return out; });
    const count = async (text: string) => (await flat()).split(text).length - 1;
    const lineFor = (n: number, dir?: string) => (dir ? `cd '${dir.replace(/'/g, `'\\''`)}' && ` : '') + `claude --resume ${sid(n)}`;
    const running = (cmd: string) => until(async () => (await blocks()).find((b) => b.cmd === cmd && b.endedAt === undefined), 10_000, `${cmd} to run`);

    // a `claude` that only says where it ran and with what (never the real one)
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await enter(`claude() { echo "RESUMED:$PWD:$*"; }`);
    await enter(`cd '${here}'`);
    await ended(`cd '${here}'`);
    if (!(await page.evaluate(() => window.jaffer.call('config.get'))).panel.open) await menu('toggle-panel');
    await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
    await page.click('.sp-convos .conv-refresh');
    await until(async () => (await row(81).count()) === 1 && (await row(82).count()) === 1, 5_000, 'the two planted conversations');
    // the title is the row's first line; the folder below it
    expect(await row(81).locator('.conv-name').textContent()).toBe('Resume here please');
    expect(await row(82).textContent()).toContain("resume it's odd");

    // idle, same folder: exactly `claude --resume <id>` runs, the toast says so, the keyboard goes to the terminal
    await row(81).click();
    await ended(lineFor(81));
    await until(async () => (await count(resumed(here, 81))) === 1, 5_000, 'claude to run in the same folder');
    await toastSaid('Resuming…');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
    // idle, another folder (a space and a quote in it): the shell really goes there first
    await row(82).click();
    await ended(lineFor(82, odd));
    await until(async () => (await count(resumed(odd, 82))) === 1, 5_000, 'claude to run in the odd folder');
    // a half-typed line is cleared first: what runs is exactly the resume line
    await page.click('.term');
    await page.keyboard.type('echo JUNK ', { delay: 4 });
    await row(81).click();
    await ended(lineFor(81, here));
    await until(async () => (await count(resumed(here, 81))) === 2, 5_000, 'the resume after Ctrl-U');
    expect(await flat()).not.toContain('JUNK cd');
    // the cursor at the start of a half-typed line: the whole line still goes (Ctrl-E first, then Ctrl-U)
    await page.click('.term');
    await page.keyboard.type('echo JUNK', { delay: 4 });
    await page.keyboard.press('Control+a');
    await row(82).click();
    await ended(lineFor(82, odd));
    await until(async () => (await count(resumed(odd, 82))) === 2, 5_000, 'the resume with the cursor at the start');
    expect((await blocks()).some((b) => b.cmd?.includes('JUNK'))).toBe(false);
    // a double click types once
    const typedBlocks = async () => (await blocks()).filter((b) => b.cmd?.includes('--resume')).length;
    const nBlocks = await typedBlocks();
    await row(81).dblclick();
    await until(async () => (await count(resumed(here, 81))) === 3, 5_000, 'the resume after a double click');
    await sleep(1500);
    expect(await count(resumed(here, 81))).toBe(3);
    expect(await typedBlocks()).toBe(nBlocks + 1);
    // Enter on the selected row (the search filters by title) resumes too
    await page.fill('.sp-convos .conv-search input', 'odd one');
    await until(async () => (await page.locator('.sp-convos .conv-row').count()) === 1, 3_000, 'the title filter');
    await page.focus('.sp-convos .conv-search input');
    await page.keyboard.press('Enter');
    await until(async () => (await count(resumed(odd, 82))) === 3, 5_000, 'Enter to resume');
    await page.fill('.sp-convos .conv-search input', '');
    // the copy button copies the same line (with the cd here, the shell being in the odd folder) and types nothing
    let before = await termText();
    await page.locator(`.sp-convos .conv-item:has(.conv-row[data-id="${sid(81)}"]) .conv-copy`).click();
    await until(async () => (await clipLast()) === lineFor(81, here), 3_000, 'the copy button');
    await toastSaid('Copied. Paste it in the terminal.');
    await sleep(300);
    expect(await termText()).toBe(before);

    // a command runs: nothing is typed, the line is copied and the toast names the command
    await page.click('.term');
    await enter('sleep 31');
    await running('sleep 31');
    before = await termText();
    await row(81).click();
    await until(async () => (await clipLast()) === lineFor(81, here), 3_000, 'the copy while busy');
    await toastSaid('sleep 31 is running: command copied');
    await sleep(400);
    expect(await termText()).toBe(before);
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await ended('sleep 31');
    // Claude runs (resumed by a click, so after a cd into the folder with a space and a quote): nothing is typed, the line is copied and
    // the toast says to quit it first
    await enter(`claude() { echo CLAUDE-UP; sleep 30; }`);
    await row(81).click();
    await running(lineFor(81, here));
    await until(async () => (await count('CLAUDE-UP')) >= 1, 5_000, 'the stand-in claude');
    before = await termText();
    await row(82).click();
    await until(async () => (await clipLast()) === lineFor(82), 3_000, 'the copy while Claude runs'); // (the shell says its folder at a prompt: still the odd one)
    await toastSaid('Claude is already running here: quit it first (/exit)');
    await sleep(400);
    expect(await termText()).toBe(before);
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await until(async () => !(await blocks()).some((b) => b.cmd === lineFor(81, here) && b.endedAt === undefined), 10_000, 'the stand-in to end');
    await enter('unset -f claude');
  }, 60_000);

  it('past conversations, 1.2.0: a name (pencil, F2) kept in history.names wins in the rows and the search, a pin (the Pinned group, an older one read through include), folder chips, cost by folder, ⇧⌘R resumes the newest of the folder, the palette finds one by its name and Enter resumes it; a running command gets nothing typed', async () => {
    await clipStub();
    const sid = (n: number) => `0000000${n}`.slice(-8) + '-aaaa-4bbb-8ccc-ddddeeeeffff';
    const alpha = path.join(env.userHome, 'p12-alpha');
    const beta = path.join(env.userHome, 'p12-beta');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(beta, { recursive: true });
    const plant = (n: number, proj: string, cwd: string, title: string, end: number) => {
      const dir = path.join(env.userHome, '.claude', 'projects', proj);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sid(n)}.jsonl`);
      const line = (type: string, at: number, extra: object) => JSON.stringify({ type, cwd, timestamp: new Date(at).toISOString(), ...extra });
      fs.writeFileSync(file, [line('user', end - 60_000, { message: { role: 'user', content: title } }), line('user', end - 30_000, { message: { role: 'user', content: 'SECRET-WORDS' } }), line('assistant', end, { message: { id: `p${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET-REPLY' }], usage: { input_tokens: 1000, output_tokens: 500 } } })].join('\n') + '\n');
      fs.utimesSync(file, end / 1000, end / 1000);
    };
    const T = Date.now();
    plant(91, '-p12-alpha', alpha, 'Alpha first', T - 120_000);
    plant(92, '-p12-alpha', alpha, 'Alpha second', T - 60_000);
    plant(93, '-p12-beta', beta, 'Beta only', T - 30_000);
    plant(94, '-p12-old', beta, 'Old beta', Date.parse('2020-01-02T10:00:00Z')); // older than the 50 newest once the fillers are there
    const fill = path.join(env.userHome, '.claude', 'projects', '-p12-fill');
    const row = (n: number) => page.locator(`.sp-convos .conv-row[data-id="${sid(n)}"]`);
    const item = (n: number) => page.locator(`.sp-convos .conv-item:has(.conv-row[data-id="${sid(n)}"])`);
    const nameOf = (n: number) => row(n).locator('.conv-name').textContent();
    const cfgNow = () => page.evaluate(() => window.jaffer.call('config.get'));
    const refresh = async (what: string, ok: () => Promise<boolean>) => (await page.click('.sp-convos .conv-refresh'), until(ok, 5_000, what));
    const groupOf = (n: number) => row(n).evaluate((x) => x.closest('.conv-day')?.querySelector('.conv-day-label')?.textContent ?? '');
    const flat = () => page.evaluate(() => { const b = (window as any).__jaffer.terminals.get('main').term.buffer.active; let out = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i)!; out += (l.isWrapped ? '' : '\n') + l.translateToString(true); } return out; });
    const count = async (text: string) => (await flat()).split(text).length - 1;
    const resumed = (dir: string, n: number) => `RESUMED:${dir}:--resume ${sid(n)}`;
    const resumeBlocks = async () => (await blocks()).filter((b) => b.cmd?.includes('--resume')).length;
    const clipLast = () => page.evaluate(() => (window as any).__powerClip.written.at(-1));

    // a `claude` that only says where it ran and with what (never the real one), the shell in the alpha folder
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await enter(`claude() { echo "RESUMED:$PWD:$*"; }`);
    await enter(`cd '${alpha}'`);
    await ended(`cd '${alpha}'`);
    if (!(await cfgNow()).panel.open) await menu('toggle-panel');
    await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
    await refresh('the planted conversations', async () => (await row(91).count()) === 1 && (await row(92).count()) === 1 && (await row(93).count()) === 1);

    // the pencil names a row in place: empty at first (the title is only the placeholder, never written as a name); Enter keeps it
    await item(92).hover();
    await item(92).locator('.conv-name-btn').click();
    await page.waitForSelector('.sp-convos .conv-rename');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-rename'))).toBe(true);
    expect(await page.inputValue('.sp-convos .conv-rename')).toBe('');
    expect(await page.getAttribute('.sp-convos .conv-rename', 'placeholder')).toBe('Alpha second');
    await page.keyboard.type('  Deploy   fix  ');
    const renameBefore = await termText();
    await page.keyboard.press('Enter');
    await until(async () => (await nameOf(92)) === 'Deploy fix', 3_000, 'the new name in the row');
    await sleep(300);
    expect(await termText()).toBe(renameBefore); // Enter in the name field names the row: nothing is typed into the terminal (no resume)
    expect((await cfgNow()).history).toEqual({ names: [`${sid(92)} Deploy fix`], pinned: [], tags: [], hidden: [] });
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe(sid(92)); // (the keyboard back on the row)
    // on disk: the person's own name and nothing of the transcript
    const onDisk = fs.readFileSync(env.paths.config, 'utf8');
    expect(onDisk).toContain('Deploy fix');
    expect(onDisk).not.toMatch(/Alpha second|SECRET|Beta only/);
    // the search finds it by the name, and by the title it had
    await page.fill('.sp-convos .conv-search input', 'deploy');
    await until(async () => (await page.locator('.sp-convos .conv-row').count()) === 1 && (await row(92).count()) === 1, 3_000, 'the name found');
    await page.fill('.sp-convos .conv-search input', 'alpha second');
    await until(async () => (await page.locator('.sp-convos .conv-row').count()) === 1 && (await row(92).count()) === 1, 3_000, 'the title still found');
    await page.fill('.sp-convos .conv-search input', '');
    // F2 on the selected row; Esc cancels (nothing kept), the keyboard back on the row
    await row(93).focus();
    await page.keyboard.press('F2');
    await page.waitForSelector('.sp-convos .conv-rename');
    await page.keyboard.type('Not kept');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sp-convos .conv-rename', { state: 'detached' });
    expect(await nameOf(93)).toBe('Beta only');
    expect((await cfgNow()).history.names).toEqual([`${sid(92)} Deploy fix`]);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id)).toBe(sid(93));
    // an empty name removes it; then named again
    await row(92).focus();
    await page.keyboard.press('F2');
    expect(await page.inputValue('.sp-convos .conv-rename')).toBe('Deploy fix');
    await page.fill('.sp-convos .conv-rename', '');
    await page.keyboard.press('Enter');
    await until(async () => (await nameOf(92)) === 'Alpha second', 3_000, 'the title back');
    expect((await cfgNow()).history.names).toEqual([]);
    await row(92).focus();
    await page.keyboard.press('F2');
    await page.keyboard.type('Deploy fix');
    await page.keyboard.press('Enter');
    await until(async () => (await nameOf(92)) === 'Deploy fix', 3_000, 'named again');

    // the star pins: a "Pinned" group above the days, kept in history.pinned
    await item(91).hover();
    await item(91).locator('.conv-pin').click();
    await until(async () => (await groupOf(91)) === 'Pinned', 3_000, 'the Pinned group');
    expect(await page.locator('.sp-convos .conv-day-label').first().textContent()).toBe('Pinned');
    expect(await item(91).locator('.conv-pin').getAttribute('aria-pressed')).toBe('true');
    expect((await cfgNow()).history.pinned).toEqual([sid(91)]);
    // a pinned conversation older than the 50 newest is read too (include), with its title
    fs.mkdirSync(fill, { recursive: true });
    for (let k = 0; k < 50; k++) {
      const f = path.join(fill, `${String(k).padStart(8, '0')}-ffff-4fff-8fff-ffffffffffff.jsonl`);
      fs.writeFileSync(f, JSON.stringify({ type: 'user', cwd: '/p12/fill', timestamp: new Date(T - 600_000).toISOString(), message: { role: 'user', content: 'filler' } }) + '\n');
      fs.utimesSync(f, (T - 600_000 + k) / 1000, (T - 600_000 + k) / 1000);
    }
    await refresh('the old one out of the 50 newest', async () => (await row(94).count()) === 0 && (await page.locator('.sp-convos .conv-row[data-id$="-ffff-4fff-8fff-ffffffffffff"]').count()) > 0);
    await patch({ history: { pinned: [sid(94), sid(91)] } });
    await refresh('the pinned old one listed', async () => (await row(94).count()) === 1);
    expect(await groupOf(94)).toBe('Pinned');
    expect(await nameOf(94)).toBe('Old beta');
    expect(await page.$$eval('.sp-convos .conv-day:first-child .conv-row', (r) => r.map((x) => (x as HTMLElement).dataset.id))).toEqual([sid(91), sid(94)]); // (newest first)
    await item(94).hover();
    await item(94).locator('.conv-pin').click();
    await until(async () => JSON.stringify((await cfgNow()).history.pinned) === JSON.stringify([sid(91)]), 3_000, 'unpinned');
    fs.rmSync(fill, { recursive: true, force: true });
    await refresh('the fillers gone', async () => (await page.locator('.sp-convos .conv-row[data-id$="-ffff-4fff-8fff-ffffffffffff"]').count()) === 0 && (await row(94).count()) === 1);

    // the folder chips: All and the most used folders; one filters the list (memory only)
    expect(await page.getAttribute('.sp-convos .conv-chip >> nth=0', 'aria-pressed')).toBe('true');
    expect(await page.textContent('.sp-convos .conv-chip >> nth=0')).toBe('All');
    await page.click(`.sp-convos .conv-chip[data-cwd="${beta}"]`);
    await until(async () => (await page.getAttribute(`.sp-convos .conv-chip[data-cwd="${beta}"]`, 'aria-pressed')) === 'true', 3_000, 'the beta chip');
    expect(await page.textContent(`.sp-convos .conv-chip[data-cwd="${beta}"]`)).toBe('p12-beta');
    expect((await page.$$eval('.sp-convos .conv-row', (r) => r.map((x) => (x as HTMLElement).dataset.id))).sort()).toEqual([sid(93), sid(94)]);
    await page.click('.sp-convos .conv-chip >> nth=0');
    await until(async () => (await row(92).count()) === 1, 3_000, 'All again');

    // cost by folder: today and this week, from the 30 newest; only with the cost switch
    await page.click('.sp-convos .conv-cost-toggle');
    await page.waitForSelector('.sp-convos .conv-costs');
    const costs = (await page.textContent('.sp-convos .conv-costs')) ?? '';
    expect(costs).toMatch(/Folder\s*Today\s*This week/);
    expect(costs).toMatch(/p12-alpha\s*≈ \$0\.\d\d\s*≈ \$0\.\d\d/);
    expect(costs).toContain('from the 30 newest conversations');
    await patch({ claude: { showCost: false } });
    await until(async () => (await page.locator('.sp-convos .conv-cost-toggle, .sp-convos .conv-costs').count()) === 0, 3_000, 'cost by folder gone');
    await patch({ claude: { showCost: true } });

    // ⇧⌘R at an idle prompt: exactly one resume line, the newest conversation of the shell's folder (no cd: the same folder)
    const typedBefore = await resumeBlocks();
    await menu('resume-last');
    await until(async () => (await count(resumed(alpha, 92))) === 1, 5_000, 'the last alpha conversation resumed');
    await toastSaid('Resuming…');
    await ended(`claude --resume ${sid(92)}`);
    await sleep(1500);
    expect(await count(resumed(alpha, 92))).toBe(1);
    expect(await resumeBlocks()).toBe(typedBefore + 1);
    // a command runs: nothing typed, the line copied and why
    await page.click('.term');
    await enter('sleep 31');
    await until(async () => (await blocks()).find((b) => b.cmd === 'sleep 31' && b.endedAt === undefined), 10_000, 'sleep 31 to run');
    const screen = await termText();
    await menu('resume-last');
    await until(async () => (await clipLast()) === `claude --resume ${sid(92)}`, 3_000, 'the copy while busy');
    await toastSaid('sleep 31 is running: command copied');
    await sleep(400);
    expect(await termText()).toBe(screen);
    await page.click('.term');
    await page.keyboard.press('Control+c');
    await ended('sleep 31');

    // the palette: one character finds no conversation; its name finds it, Enter resumes it as a click would (the folder differs: cd first)
    await enter(`cd '${beta}'`);
    await ended(`cd '${beta}'`);
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('d');
    expect(await page.locator('.pal-row', { hasText: 'Deploy fix' }).count()).toBe(0);
    await page.keyboard.type('eploy fix');
    await until(async () => (await page.locator('.pal-row').first().textContent())?.includes('Deploy fix'), 3_000, 'the conversation in the palette');
    expect(await page.locator('.pal-row').first().textContent()).toContain('Conversation');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.palette', { state: 'detached' });
    await until(async () => (await count(resumed(alpha, 92))) === 2, 5_000, 'the palette to resume it');
    await ended(`cd '${alpha}' && claude --resume ${sid(92)}`);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
    expect(await resumeBlocks()).toBe(typedBefore + 2);

    await page.click('.term');
    await enter('unset -f claude');
    await patch({ history: { names: [], pinned: [] } });
    for (const proj of ['-p12-alpha', '-p12-beta', '-p12-old']) fs.rmSync(path.join(env.userHome, '.claude', 'projects', proj), { recursive: true, force: true });
  }, 90_000);

  it('past conversations, 1.2.0 review: ⇧⌘R reads the list first (a stale list never resumes an older one; a failed read uses the last list), the palette reads it at every open and names a row without a title by its folder, rows keep the keyboard across a refresh and a pin, Tab goes search → chips → rows, nothing overflows a 220 px panel', async () => {
    await clipStub();
    const sid = (n: number) => `0000000${n}`.slice(-8) + '-aaaa-4bbb-8ccc-ddddeeeeffff';
    const gamma = path.join(env.userHome, 'p12-gamma');
    const delta = path.join(env.userHome, 'p12-delta');
    fs.mkdirSync(gamma, { recursive: true });
    fs.mkdirSync(delta, { recursive: true });
    const plant = (n: number, proj: string, cwd: string, title: string | null, end: number, output = 500) => {
      const dir = path.join(env.userHome, '.claude', 'projects', proj);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sid(n)}.jsonl`);
      const line = (type: string, at: number, extra: object) => JSON.stringify({ type, cwd, timestamp: new Date(at).toISOString(), ...extra });
      fs.writeFileSync(file, [line('user', end - 60_000, { message: { role: 'user', content: title ?? '<command-name>/clear</command-name>' } }), line('assistant', end, { message: { id: `g${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000, output_tokens: output } } })].join('\n') + '\n');
      fs.utimesSync(file, end / 1000, end / 1000);
    };
    const T = Date.now();
    plant(95, '-p12-gamma', gamma, 'Gamma old', T - 300_000, 9_000_000); // (≈ $90: a wide figure for the cost table)
    plant(99, '-p12-delta', delta, null, T - 400_000);
    const row = (n: number) => page.locator(`.sp-convos .conv-row[data-id="${sid(n)}"]`);
    const active = () => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return { cls: a?.className ?? '', id: a?.dataset.id ?? a?.closest('.conv-item')?.querySelector<HTMLElement>('.conv-row')?.dataset.id }; });
    const groupOf = (n: number) => row(n).evaluate((x) => x.closest('.conv-day')?.querySelector('.conv-day-label')?.textContent ?? '');
    const flat = () => page.evaluate(() => { const b = (window as any).__jaffer.terminals.get('main').term.buffer.active; let out = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i)!; out += (l.isWrapped ? '' : '\n') + l.translateToString(true); } return out; });
    const count = async (text: string) => (await flat()).split(text).length - 1;
    const resumed = (n: number) => `RESUMED:${gamma}:--resume ${sid(n)}`;
    await page.evaluate(() => {
      const w = window as any;
      w.__revReal = w.jaffer.call;
      w.__revReads = 0;
      w.__revFail = false;
      w.jaffer.call = (m: string, p: any) => (m === 'claude.history' ? (w.__revReads++, w.__revFail ? Promise.reject(new Error('history is away')) : w.__revReal(m, p)) : w.__revReal(m, p));
    });
    const reads = () => page.evaluate(() => (window as any).__revReads as number);

    await page.click('.term');
    await page.keyboard.press('Control+c');
    await enter(`claude() { echo "RESUMED:$PWD:$*"; }`);
    await enter(`cd '${gamma}'`);
    await ended(`cd '${gamma}'`);
    if (!(await page.evaluate(() => window.jaffer.call('config.get'))).panel.open) await menu('toggle-panel');
    await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
    await page.click('.sp-convos .conv-refresh');
    await until(async () => (await row(95).count()) === 1, 5_000, 'the gamma conversation');
    // the panel closes: its list stays in the window's memory, and grows stale
    await page.click('.term');
    await page.keyboard.press('Meta+b');
    await page.waitForSelector('.side-panel', { state: 'detached' });
    plant(96, '-p12-gamma', gamma, 'Gamma new', T - 10_000);
    let n = await reads();
    await menu('resume-last');
    await until(async () => (await count(resumed(96))) === 1, 5_000, 'the newest conversation (read just now) resumed');
    expect(await reads()).toBe(n + 1);
    expect(await count(resumed(95))).toBe(0);
    await ended(`claude --resume ${sid(96)}`);
    // the read fails: the last list is used, nothing breaks
    plant(97, '-p12-gamma', gamma, 'Gamma unseen', T - 5_000);
    await page.evaluate(() => void ((window as any).__revFail = true));
    await menu('resume-last');
    await until(async () => (await count(resumed(96))) === 2, 5_000, 'the last list used when the read fails');
    await ended(`claude --resume ${sid(96)}`);
    expect(await count(resumed(97))).toBe(0);
    await page.evaluate(() => void ((window as any).__revFail = false));

    // the palette reads the list at every open (the rows it had show meanwhile); a row without a name or title is its folder
    n = await reads();
    for (const k of [1, 2]) {
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.palette input');
      await until(async () => (await reads()) === n + k, 3_000, `a read at open ${k}`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.palette', { state: 'detached' });
    }
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('p12-delta');
    await until(async () => /~\/user\/p12-delta$/.test((await page.locator('.pal-row .pal-title').first().textContent()) ?? ''), 3_000, 'the folder as the title');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.palette', { state: 'detached' });

    // the panel again: Tab from the search reaches the first chip, then the rows
    await page.click('.term');
    await page.keyboard.press('Meta+b');
    await page.waitForSelector('.side-panel .sp-convos .conv-search input');
    await until(async () => (await row(97).count()) === 1 && (await page.locator('.sp-convos .conv-chip').count()) >= 3, 5_000, 'the list and its chips');
    await page.focus('.sp-convos .conv-search input');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.matches('.conv-chip') && document.activeElement.textContent)).toBe('All');
    const chips = await page.locator('.sp-convos .conv-chip').count();
    for (let k = 0; k < chips; k++) await page.keyboard.press('Tab'); // (the other chips, then Cost by folder)
    expect((await active()).cls).toContain('conv-cost-toggle');
    await page.keyboard.press('Tab');
    expect((await active()).cls).toContain('st-toggle'); // (1.4.0: Storage)
    await page.keyboard.press('Tab');
    expect((await active()).cls).toContain('conv-row');

    // a refresh with a newer conversation above keeps the keyboard on the same row
    await row(96).focus();
    plant(98, '-p12-gamma', gamma, 'Gamma newest', T - 1_000);
    await page.evaluate(() => (document.querySelector('.sp-convos .conv-refresh') as HTMLElement).click());
    await until(async () => (await row(98).count()) === 1, 5_000, 'the newer one listed');
    await sleep(200);
    expect(await active()).toEqual({ cls: 'conv-row', id: sid(96) });
    // pinning from the keyboard keeps it on the star, in the Pinned group and back (past copy, name and, 1.4.0, tag and hide)
    for (let k = 0; k < 5; k++) await page.keyboard.press('Tab');
    expect((await active()).cls).toContain('conv-pin');
    await page.keyboard.press('Enter');
    await until(async () => (await groupOf(96)) === 'Pinned', 3_000, 'pinned');
    await sleep(200);
    expect(await active()).toMatchObject({ id: sid(96) });
    expect((await active()).cls).toContain('conv-pin');
    await page.keyboard.press('Enter');
    await until(async () => (await groupOf(96)) !== 'Pinned', 3_000, 'unpinned');
    await sleep(200);
    expect((await active()).cls).toContain('conv-pin');
    expect((await active()).id).toBe(sid(96));

    // a 220 px panel: nothing overflows, the cost figures are whole, the hidden row buttons leave the row its width
    await patch({ panel: { width: 220 } });
    await until(async () => Math.round((await page.locator('.side-panel').boundingBox())!.width) <= 222, 3_000, 'the narrow panel');
    await page.click('.sp-convos .conv-cost-toggle');
    await page.click('.sp-convos .st-toggle'); // (1.4.0: the storage view must fit too)
    await page.waitForSelector('.sp-convos .conv-costs');
    await page.waitForSelector('.sp-convos .st-row');
    await until(async () => ((await page.textContent('.sp-convos .conv-costs')) ?? '').includes('≈ $90'), 3_000, 'the wide figure');
    const fit = await page.evaluate(() => {
      const box = document.querySelector('.sp-convos')!;
      const costs = document.querySelector('.conv-costs')!.getBoundingClientRect();
      const cells = [...document.querySelectorAll<HTMLElement>('.conv-costs [data-usd]')];
      const item = document.querySelector('.conv-item')!.getBoundingClientRect();
      const r = document.querySelector('.conv-item .conv-row')!.getBoundingClientRect();
      return {
        overflow: box.scrollWidth - box.clientWidth,
        cells: cells.length,
        clipped: cells.filter((c) => c.scrollWidth > c.clientWidth || c.getBoundingClientRect().right > costs.right + 0.5).map((c) => c.textContent),
        rowShare: r.width / item.width,
      };
    });
    expect(fit.overflow).toBeLessThanOrEqual(0);
    expect(fit.cells).toBeGreaterThan(0);
    expect(fit.clipped).toEqual([]);
    expect(fit.rowShare).toBeGreaterThan(0.9);
    await page.click('.sp-convos .conv-cost-toggle');
    await page.click('.sp-convos .st-toggle');
    await patch({ panel: { width: 300 } });

    await page.evaluate(() => { const w = window as any; w.jaffer.call = w.__revReal; });
    await page.click('.term');
    await enter('unset -f claude');
    for (const proj of ['-p12-gamma', '-p12-delta']) fs.rmSync(path.join(env.userHome, '.claude', 'projects', proj), { recursive: true, force: true });
  }, 90_000);

  it('past conversations, 1.3.0: the trash button, Delete on a row and Remove… (this folder, all listed) ask the app to move them to the Trash; pins and names go, the list is read again, a toast says what happened; Cancel leaves everything; a running one is refused', async () => {
    const sid = (n: number) => `0000000${n}`.slice(-8) + '-aaaa-4bbb-8ccc-ddddeeeeffff';
    const eps = path.join(env.userHome, 'p13-eps');
    const zeta = path.join(env.userHome, 'p13-zeta');
    const files = new Map<number, string>();
    const plant = (n: number, proj: string, cwd: string, end: number) => {
      const dir = path.join(env.userHome, '.claude', 'projects', proj);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sid(n)}.jsonl`);
      const line = (type: string, at: number, extra: object) => JSON.stringify({ type, cwd, timestamp: new Date(at).toISOString(), ...extra });
      fs.writeFileSync(file, [line('user', end - 60_000, { message: { role: 'user', content: `Talk ${n}` } }), line('assistant', end, { message: { id: `t${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } })].join('\n') + '\n');
      fs.utimesSync(file, end / 1000, end / 1000);
      files.set(n, file);
    };
    // the Trash is not the page's to empty: the bridge's stand-in records the ids and moves nothing, so a test moves the files away itself
    const binned = (...ns: number[]) => ns.forEach((n) => fs.rmSync(files.get(n)!, { force: true }));
    const T = Date.now();
    plant(101, '-p13-eps', eps, T - 50_000);
    plant(102, '-p13-eps', eps, T - 40_000);
    for (const n of [103, 104, 105, 106]) plant(n, '-p13-zeta', zeta, T - 200_000 + n); // (the most used folder: it gets a chip)
    const row = (n: number) => page.locator(`.sp-convos .conv-row[data-id="${sid(n)}"]`);
    const item = (n: number) => page.locator(`.sp-convos .conv-item:has(.conv-row[data-id="${sid(n)}"])`);
    const ids = () => page.$$eval('.sp-convos .conv-row', (r) => r.map((x) => (x as HTMLElement).dataset.id!));
    const cfgNow = () => page.evaluate(() => window.jaffer.call('config.get'));
    const trashed = () => page.evaluate(() => ((window as any).__trashed ?? []) as string[][]);
    const answer = (a: object | null) => page.evaluate((x) => void ((window as any).__trashAnswer = x ?? undefined), a);
    const trashRow = async (n: number) => (await item(n).hover(), await item(n).locator('.conv-trash').click());
    const menuItems = () => page.$$eval('.ctx-menu [role="menuitem"]', (b) => b.map((x) => x.textContent));
    await patch({ history: { pinned: [sid(101), sid(103)], names: [`${sid(101)} Eps named`, `${sid(103)} Zeta named`] } });
    if (!(await cfgNow()).panel.open) await menu('toggle-panel');
    await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
    await page.fill('.sp-convos .conv-search input', 'p13-');
    await page.click('.sp-convos .conv-refresh');
    await until(async () => (await ids()).length === 6, 5_000, 'the planted conversations');
    expect(await item(101).locator('.conv-trash').getAttribute('aria-label')).toBe('Move to Trash');
    let calls = (await trashed()).length;

    // Cancel in the app's question: nothing changes, no toast
    await answer({ cancelled: true });
    await trashRow(102);
    await until(async () => (await trashed()).length === calls + 1, 3_000, 'the ask');
    expect((await trashed()).at(-1)).toEqual([sid(102)]);
    calls++;
    await sleep(400);
    expect((await ids()).sort()).toEqual([101, 102, 103, 104, 105, 106].map(sid).sort());
    expect((await cfgNow()).history.pinned).toEqual([sid(101), sid(103)]);
    expect(await page.locator('.toast-text', { hasText: 'Trash' }).count()).toBe(0);
    await answer(null);

    // the row's trash button: the id asked for, its pin and name gone from the config, the list read again (a new one shows), a toast
    binned(101);
    plant(107, '-p13-eps', eps, T - 30_000);
    await trashRow(101);
    await until(async () => (await row(101).count()) === 0 && (await row(107).count()) === 1, 5_000, 'the list without it, read again');
    expect((await trashed()).at(-1)).toEqual([sid(101)]);
    calls++;
    await toastSaid('Moved 1 conversation to the Trash');
    const h = (await cfgNow()).history;
    expect(h.pinned).toEqual([sid(103)]);
    expect(h.names).toEqual([`${sid(103)} Zeta named`]);

    // still running: refused, the row stays, the toast says why
    await answer({ trashed: [], refused: [{ id: sid(102), reason: 'running' }] });
    await trashRow(102);
    await toastSaid('Nothing moved to the Trash: 1 is still running');
    calls++;
    expect(await row(102).count()).toBe(1);
    // the running sessions could not be looked up: says why, nothing moved
    await answer({ trashed: [], refused: [{ id: sid(102), reason: 'unknown' }] });
    await trashRow(102);
    await toastSaid('Jaffer could not check whether Claude is running, so nothing was moved');
    calls++;
    expect(await row(102).count()).toBe(1);
    await answer(null);

    // Delete on the row with the keyboard: that row; the keyboard goes on to the row in its place. Delete or Backspace elsewhere asks nothing
    await page.focus('.sp-convos .conv-search input');
    await page.keyboard.press('Backspace'); // (the search loses its last character: "p13")
    await page.focus(`.sp-convos .conv-chip >> nth=0`);
    await page.keyboard.press('Delete');
    await sleep(300);
    expect((await trashed()).length).toBe(calls);
    expect(await page.inputValue('.sp-convos .conv-search input')).toBe('p13');
    binned(102);
    await row(102).focus();
    await page.keyboard.press('Delete');
    await until(async () => (await row(102).count()) === 0, 5_000, 'the row removed with Delete');
    expect((await trashed()).at(-1)).toEqual([sid(102)]);
    calls++;
    await until(() => page.evaluate(() => document.activeElement?.classList.contains('conv-row')), 3_000, 'the keyboard on the next row');

    // Remove…: with a folder chip, This folder (N) and All listed (N), the counts of what the list shows; a press again closes it
    await page.fill('.sp-convos .conv-search input', 'p13-');
    await page.click(`.sp-convos .conv-chip[data-cwd="${zeta}"]`);
    await until(async () => (await ids()).length === 4, 3_000, 'the zeta chip');
    await page.click('.sp-convos .conv-remove');
    await page.waitForSelector('.ctx-menu');
    expect(await menuItems()).toEqual(['This folder (4)', 'All listed (5)']);
    await page.click('.sp-convos .conv-remove');
    await page.waitForSelector('.ctx-menu', { state: 'detached' });
    // from the keyboard: Enter opens it on its first item, Esc closes it back to the button
    await page.focus('.sp-convos .conv-remove');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ctx-menu');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('This folder (4)');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ctx-menu', { state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-remove'))).toBe(true);
    expect((await trashed()).length).toBe(calls);
    // This folder: one of them still running
    binned(103, 104, 105);
    await answer({ trashed: [sid(103), sid(104), sid(105)], refused: [{ id: sid(106), reason: 'running' }] });
    await page.click('.sp-convos .conv-remove');
    await page.click('.ctx-menu [role="menuitem"] >> text=This folder (4)');
    await toastSaid('Moved 3 conversations to the Trash; 1 is still running');
    expect([...(await trashed()).at(-1)!].sort()).toEqual([103, 104, 105, 106].map(sid));
    calls++;
    await until(async () => JSON.stringify(await ids()) === JSON.stringify([sid(106)]), 5_000, 'only the running one left');
    expect((await cfgNow()).history).toEqual({ pinned: [], names: [], tags: [], hidden: [] });
    await answer(null);

    // All listed, without a chip: only that item, every row the list shows
    await page.click('.sp-convos .conv-chip >> nth=0');
    await until(async () => (await ids()).length === 2, 3_000, 'All again');
    await page.click('.sp-convos .conv-remove');
    await page.waitForSelector('.ctx-menu');
    expect(await menuItems()).toEqual(['All listed (2)']);
    binned(106, 107);
    await page.click('.ctx-menu [role="menuitem"] >> text=All listed (2)');
    await toastSaid('Moved 2 conversations to the Trash');
    expect([...(await trashed()).at(-1)!].sort()).toEqual([sid(106), sid(107)]);
    await until(async () => (await ids()).length === 0, 5_000, 'nothing listed');
    expect(await page.locator('.sp-convos .conv-remove').isDisabled()).toBe(true);

    await page.fill('.sp-convos .conv-search input', '');
    for (const proj of ['-p13-eps', '-p13-zeta']) fs.rmSync(path.join(env.userHome, '.claude', 'projects', proj), { recursive: true, force: true });
  }, 60_000);

  it('Settings → Privacy and permissions (1.4.0): five switches with their words, in order, and the locked rules; each switch writes its own config key and nothing else', async () => {
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.click('.settings-nav button:has-text("Privacy and permissions")');
    const fields = page.locator('.settings .pv-list .field');
    expect(await fields.count()).toBe(5);
    const labels = await page.$$eval('.settings .pv-list .field .field-label', (l) => l.map((x) => x.firstChild?.textContent));
    expect(labels).toEqual([
      'Explain the last answer with a helper Claude',
      'Search the text of past conversations',
      'Type the resume line for you',
      'Move conversations to the Trash',
      'Answer permission prompts from the notification',
    ]);
    const hints = await page.$$eval('.settings .pv-list .field small', (l) => l.map((x) => x.textContent ?? ''));
    expect(hints[0]).toMatch(/sends it to a separate Claude run on your subscription.*Uses your plan's usage.*Off: Jaffer never reads a reply\./);
    expect(hints[1]).toMatch(/Shows only which conversations match\. Nothing is stored\./);
    expect(hints[2]).toMatch(/types claude --resume into an idle terminal\. Off: it only copies the command\./);
    expect(hints[3]).toMatch(/Always asks first; never deletes for good\./);
    expect(hints[4]).toMatch(/Experimental\./);
    const locked = (await page.textContent('.settings .pv-locked')) ?? '';
    expect(locked).toContain('Always locked');
    expect(locked).toMatch(/Allow .* needs your own click, with the whole request shown/);
    expect(locked).toMatch(/never reads Claude's login files or your keychain/);
    expect(locked).toMatch(/Nothing is deleted for good/);
    expect(locked).toMatch(/redacted/);
    expect(await page.locator('.settings .pv-locked input').count()).toBe(0); // no switch for what is locked
    await shot('08b-privacy');
    const read = () => page.evaluate(() => window.jaffer.call('config.get'));
    const flip = (label: string) => page.locator('.settings .pv-list .field', { hasText: label }).locator('.switch').click();
    const perms = async () => (await read()).permissions;
    expect(await perms()).toEqual({ explain: false, deepSearch: false, resumeTyping: true, trash: true });
    for (const [label, key, now] of [
      ['Explain the last answer', 'explain', true],
      ['Search the text of past conversations', 'deepSearch', true],
      ['Type the resume line', 'resumeTyping', false],
      ['Move conversations to the Trash', 'trash', false],
    ] as const) {
      await flip(label);
      await until(async () => (await perms())[key] === now, 5_000, `${key} to be written`);
      expect(await perms(), key).toEqual({ explain: false, deepSearch: false, resumeTyping: true, trash: true, [key]: now }); // only that key moved
      await flip(label);
      await until(async () => (await perms())[key] === !now, 5_000, `${key} to be written back`);
    }
    const before = (await read()).claude.approvals;
    await flip('Answer permission prompts');
    await until(async () => (await read()).claude.approvals === !before, 5_000, 'approvals to be written');
    await flip('Answer permission prompts');
    await until(async () => (await read()).claude.approvals === before, 5_000, 'approvals to be written back');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  }, 40_000);

  it('Privacy and permissions off (1.4.0): resumeTyping off, a click on a past conversation copies the command, types nothing and says why; trash off, no trash button, no Remove… and Delete does nothing; main refuses too', async () => {
    await clipStub();
    const sid = '00000091-aaaa-4bbb-8ccc-ddddeeeeffff';
    const dir = path.join(env.userHome, '.claude', 'projects', '-p14-priv');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    const at = Date.now() - 20_000;
    const line = (type: string, t: number, extra: object) => JSON.stringify({ type, cwd: env.userHome, timestamp: new Date(t).toISOString(), ...extra });
    fs.writeFileSync(file, [line('user', at - 5000, { message: { role: 'user', content: 'Privacy probe p14' } }), line('assistant', at, { message: { id: 'p14', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }] } })].join('\n') + '\n');
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.__privReal = w.jaffer.call;
        w.__privTyped = [];
        w.jaffer.call = (m: string, p: any) => (m === 'pty.write' && String(p?.data).includes('--resume') ? (w.__privTyped.push(p.data), Promise.resolve({})) : w.__privReal(m, p));
      });
      const typed = () => page.evaluate(() => (window as any).__privTyped as string[]);
      const clipLast = () => page.evaluate(() => (window as any).__powerClip.written.at(-1) as string | undefined);
      if (!(await page.evaluate(() => window.jaffer.call('config.get'))).panel.open) await menu('toggle-panel');
      await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
      await page.fill('.sp-convos .conv-search input', 'p14');
      await page.click('.sp-convos .conv-refresh');
      const row = page.locator(`.sp-convos .conv-row[data-id="${sid}"]`);
      await until(async () => (await row.count()) === 1, 5_000, 'the planted conversation');
      // both on (the defaults): the trash button and Remove… are there
      expect(await page.locator('.sp-convos .conv-trash').count()).toBe(1);
      expect(await page.locator('.sp-convos .conv-remove').count()).toBe(1);

      await patch({ permissions: { resumeTyping: false, trash: false } });
      await until(async () => (await page.locator('.sp-convos .conv-trash, .sp-convos .conv-remove').count()) === 0, 5_000, 'the remove buttons to go');
      await page.click('.term');
      await sleep(300); // (the shell is at an idle prompt)
      await row.click();
      await until(async () => /claude --resume 00000091-aaaa-4bbb-8ccc-ddddeeeeffff$/.test((await clipLast()) ?? ''), 3_000, 'the command on the clipboard');
      await toastSaid('Typing is off in Settings → Privacy and permissions: command copied');
      await sleep(400);
      expect(await typed()).toEqual([]); // nothing was typed
      // Delete on a focused row does nothing (no question, no call to main)
      await page.evaluate(() => { const w = window as any; w.__trashed = []; });
      await row.focus();
      await page.keyboard.press('Delete');
      await page.keyboard.press('Backspace');
      await sleep(400);
      expect(await page.evaluate(() => ((window as any).__trashed ?? []).length)).toBe(0);
      expect(fs.existsSync(file)).toBe(true);

      // back on: the same click types the resume line, and the trash buttons return
      await patch({ permissions: { resumeTyping: true, trash: true } });
      await until(async () => (await page.locator('.sp-convos .conv-trash').count()) === 1 && (await page.locator('.sp-convos .conv-remove').count()) === 1, 5_000, 'the remove buttons to return');
      await page.click('.term');
      await row.click();
      await until(async () => (await typed()).length === 1, 3_000, 'the resume line typed');
      expect((await typed())[0]).toMatch(/claude --resume 00000091-aaaa-4bbb-8ccc-ddddeeeeffff\r$/);
    } finally {
      await page.evaluate(() => { const w = window as any; if (w.__privReal) w.jaffer.call = w.__privReal; delete w.__privReal; });
      await patch({ permissions: { resumeTyping: true, trash: true } });
      await page.fill('.sp-convos .conv-search input', '').catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('past conversations, 1.4.0: tags (a menu per row, chips that filter with the folder and the search), hide and unhide (Hidden (N), left out of Remove… counts), and a removal takes their tags and hidden marks', async () => {
    const sid = (n: number) => `0000000${n}`.slice(-8) + '-aaaa-4bbb-8ccc-dddd15151515';
    const eps = path.join(env.userHome, 'p15-eps');
    const zeta = path.join(env.userHome, 'p15-zeta');
    const files = new Map<number, string>();
    const plant = (n: number, proj: string, cwd: string, end: number) => {
      const dir = path.join(env.userHome, '.claude', 'projects', proj);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sid(n)}.jsonl`);
      const line = (type: string, at: number, extra: object) => JSON.stringify({ type, cwd, timestamp: new Date(at).toISOString(), ...extra });
      fs.writeFileSync(file, [line('user', end - 60_000, { message: { role: 'user', content: `Tag talk ${n}` } }), line('assistant', end, { message: { id: `g${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }] } })].join('\n') + '\n');
      fs.utimesSync(file, end / 1000, end / 1000);
      files.set(n, file);
    };
    const T = Date.now();
    plant(1, '-p15-eps', eps, T - 50_000);
    plant(2, '-p15-eps', eps, T - 40_000);
    for (const n of [3, 4, 5]) plant(n, '-p15-zeta', zeta, T - 100_000 + n);
    const row = (n: number) => page.locator(`.sp-convos .conv-row[data-id="${sid(n)}"]`);
    const item = (n: number) => page.locator(`.sp-convos .conv-item:has(.conv-row[data-id="${sid(n)}"])`);
    const ids = async () => (await page.$$eval('.sp-convos .conv-row', (r) => r.map((x) => (x as HTMLElement).dataset.id!))).sort();
    const want = (...ns: number[]) => ns.map(sid).sort();
    const cfgNow = () => page.evaluate(() => window.jaffer.call('config.get'));
    const menuItems = () => page.$$eval('.ctx-menu [role="menuitem"]', (b) => b.map((x) => x.textContent));
    const openTags = async (n: number) => (await item(n).hover(), await item(n).locator('.conv-tag-btn').click(), await page.waitForSelector('.conv-tagmenu'));
    try {
      if (!(await cfgNow()).panel.open) await menu('toggle-panel');
      await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
      await page.fill('.sp-convos .conv-search input', 'Tag talk');
      await page.click('.sp-convos .conv-refresh');
      await until(async () => (await ids()).length === 5, 5_000, 'the planted conversations');
      expect(await page.locator('.sp-convos .conv-tag-chips').count()).toBe(0); // (no tags yet: no chips)

      // the tag menu: "New tag…" has the keyboard, Enter adds (the menu stays), Esc closes it back to the row's tag button
      expect(await item(1).locator('.conv-tag-btn').getAttribute('aria-label')).toBe('Tags');
      await openTags(1);
      expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-tagnew'))).toBe(true);
      // (fix round) the input is a group in the menu, not a menu item; the menu scrolls rather than leaving the window; keys of an input method's composition stay with it
      expect(await page.locator('.conv-tagmenu [role="group"] .conv-tagnew').count()).toBe(1);
      expect(await page.$eval('.conv-tagmenu', (m) => [getComputedStyle(m).overflowY, getComputedStyle(m).maxHeight !== 'none', m.getBoundingClientRect().top >= 0])).toEqual(['auto', true, true]);
      await page.evaluate(() => {
        for (const key of ['ArrowUp', 'Escape']) document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }));
      });
      await sleep(150);
      expect(await page.locator('.conv-tagmenu').count()).toBe(1);
      expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-tagnew'))).toBe(true);
      await page.keyboard.type('  Work ');
      await page.keyboard.press('Enter');
      await until(async () => JSON.stringify((await cfgNow()).history.tags) === JSON.stringify([`${sid(1)} Work`]), 3_000, 'the tag kept');
      await until(async () => (await page.locator('.conv-tagmenu [role="menuitemcheckbox"][aria-checked="true"]').count()) === 1, 3_000, 'Work on in the menu');
      await page.keyboard.type('urgent');
      await page.keyboard.press('Enter');
      await until(async () => (await cfgNow()).history.tags.length === 2, 3_000, 'the second tag');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.conv-tagmenu', { state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.classList.contains('conv-tag-btn'))).toBe(true);
      await until(async () => JSON.stringify(await item(1).locator('.conv-tag').allTextContents()) === JSON.stringify(['Work', 'urgent']), 3_000, 'the tags on the row');
      // another row: the tags in use are switches (↑ from the input reaches them); a click turns one on; a click elsewhere closes
      await openTags(3);
      expect(await page.$$eval('.conv-tagmenu [role="menuitemcheckbox"]', (b) => b.map((x) => [x.textContent, x.getAttribute('aria-checked')]))).toEqual([['urgent', 'false'], ['Work', 'false']]); // (as often used: by name)
      await page.keyboard.press('ArrowUp');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Work');
      await page.click('.conv-tagmenu [role="menuitemcheckbox"] >> text=Work');
      await until(async () => (await cfgNow()).history.tags.includes(`${sid(3)} Work`), 3_000, 'Work on row 3');
      await page.click('.sp-convos .conv-head > span');
      await page.waitForSelector('.conv-tagmenu', { state: 'detached' });
      // a fourth tag is refused with a toast
      await patch({ history: { tags: [`${sid(1)} Work`, `${sid(1)} urgent`, `${sid(1)} third`, `${sid(3)} Work`] } });
      await openTags(1);
      await page.keyboard.type('fourth');
      await page.keyboard.press('Enter');
      await toastSaid('At most 3 tags a conversation.');
      expect((await cfgNow()).history.tags).toHaveLength(4);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.conv-tagmenu', { state: 'detached' });

      // the tag chips: the most used first, colours from the palette; a chip filters, with the folder chip and the search too
      await until(async () => JSON.stringify(await page.locator('.sp-convos .conv-tag-chip').allTextContents()) === JSON.stringify(['Work', 'third', 'urgent']), 3_000, 'the tag chips');
      expect(Number(await page.getAttribute('.sp-convos .conv-tag-chip >> nth=0', 'data-c'))).toBeLessThan(6);
      await openTags(1);
      await shot('16a-tags');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.conv-tagmenu', { state: 'detached' });
      await page.click('.sp-convos .conv-tag-chip >> text=Work');
      await until(async () => JSON.stringify(await ids()) === JSON.stringify(want(1, 3)), 3_000, 'the Work chip');
      await page.click(`.sp-convos .conv-chip[data-cwd="${zeta}"]`);
      await until(async () => JSON.stringify(await ids()) === JSON.stringify(want(3)), 3_000, 'Work and zeta');
      await page.click('.sp-convos .conv-chips:not(.conv-tag-chips) .conv-chip >> nth=0'); // (All folders)
      await page.fill('.sp-convos .conv-search input', 'Tag talk 1');
      await until(async () => JSON.stringify(await ids()) === JSON.stringify(want(1)), 3_000, 'Work and the search');
      await page.fill('.sp-convos .conv-search input', 'Tag talk');
      await page.click('.sp-convos .conv-tag-chip >> text=Work');
      await until(async () => (await ids()).length === 5, 3_000, 'the chip off again');

      // hide: the row goes, Hidden (N) appears; Remove… does not count it (All listed, This folder)
      expect(await page.locator('.sp-convos .conv-hidden-toggle').count()).toBe(0);
      await item(2).hover();
      expect(await item(2).locator('.conv-hide').getAttribute('aria-label')).toBe('Hide');
      await item(2).locator('.conv-hide').click();
      await until(async () => (await row(2).count()) === 0, 3_000, 'the hidden row to go');
      expect((await cfgNow()).history.hidden).toEqual([sid(2)]);
      expect(await page.textContent('.sp-convos .conv-hidden-toggle')).toBe('Hidden (1)');
      await page.click(`.sp-convos .conv-chip[data-cwd="${eps}"]`);
      await until(async () => JSON.stringify(await ids()) === JSON.stringify(want(1)), 3_000, 'the eps chip');
      await page.click('.sp-convos .conv-remove');
      await page.waitForSelector('.ctx-menu');
      expect((await menuItems()).slice(0, 2)).toEqual(['This folder (1)', 'All listed (4)']);
      await page.click('.sp-convos .conv-remove');
      await page.waitForSelector('.ctx-menu', { state: 'detached' });
      // Hidden (1) on: the hidden row is back, dimmed, with Unhide; Remove… still leaves it out
      await page.click('.sp-convos .conv-hidden-toggle');
      await until(async () => JSON.stringify(await ids()) === JSON.stringify(want(1, 2)), 3_000, 'the hidden row shown');
      expect(await item(2).getAttribute('data-hidden')).toBe('');
      expect(await item(1).getAttribute('data-hidden')).toBeNull();
      await page.click('.sp-convos .conv-remove');
      await page.waitForSelector('.ctx-menu');
      expect((await menuItems()).slice(0, 2)).toEqual(['This folder (1)', 'All listed (4)']);
      await page.click('.sp-convos .conv-remove');
      await page.waitForSelector('.ctx-menu', { state: 'detached' });
      await item(2).hover();
      expect(await item(2).locator('.conv-hide').getAttribute('aria-label')).toBe('Unhide');
      await item(2).locator('.conv-hide').click();
      await until(async () => (await cfgNow()).history.hidden.length === 0, 3_000, 'unhidden');
      await until(async () => (await page.locator('.sp-convos .conv-hidden-toggle').count()) === 0, 3_000, 'no Hidden toggle');
      expect(await item(2).getAttribute('data-hidden')).toBeNull();

      // a removal takes the tags and the hidden mark of what went to the Trash, and nothing else's
      await patch({ history: { hidden: [sid(3), sid(4)] } });
      await page.click('.sp-convos .conv-chips:not(.conv-tag-chips) .conv-chip >> nth=0');
      await page.click('.sp-convos .conv-hidden-toggle');
      await until(async () => (await ids()).length === 5, 3_000, 'all five, hidden ones shown');
      fs.rmSync(files.get(3)!, { force: true });
      await item(3).hover();
      await item(3).locator('.conv-trash').click();
      await toastSaid('Moved 1 conversation to the Trash');
      await until(async () => (await cfgNow()).history.hidden.length === 1, 3_000, 'its hidden mark gone');
      const h = (await cfgNow()).history;
      expect(h.hidden).toEqual([sid(4)]);
      expect(h.tags).toEqual([`${sid(1)} Work`, `${sid(1)} urgent`, `${sid(1)} third`]);
    } finally {
      await patch({ history: { tags: [], hidden: [] } });
      await page.fill('.sp-convos .conv-search input', '').catch(() => undefined);
      for (const proj of ['-p15-eps', '-p15-zeta']) fs.rmSync(path.join(env.userHome, '.claude', 'projects', proj), { recursive: true, force: true });
    }
  }, 60_000);

  it('past conversations, 1.4.0: Storage lists the 10 biggest with a trash button (the app\'s removal), Remove… → Older than 30/60/90 days with their counts and ids (200 at a time), and deep search only with its permission: the hits filter the rows with N matches', async () => {
    const sid = (n: number) => `0000000${n}`.slice(-8) + '-aaaa-4bbb-8ccc-dddd16161616';
    const proj = path.join(env.userHome, '.claude', 'projects', '-p16-store');
    const oldProj = path.join(env.userHome, '.claude', 'projects', '-p16-old');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(oldProj, { recursive: true });
    const cwd = path.join(env.userHome, 'p16-store');
    const DAY = 86_400_000;
    const plant = (dir: string, n: number, daysAgo: number, words: string, extra: object[] = [], pad = 0) => {
      const end = Date.now() - daysAgo * DAY - 60_000 + n;
      const file = path.join(dir, `${sid(n)}.jsonl`);
      const lines = [{ type: 'user', cwd, timestamp: new Date(end - 1000).toISOString(), message: { role: 'user', content: words } }, ...extra, { type: 'assistant', cwd, timestamp: new Date(end).toISOString(), message: { id: `s${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }] } }];
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + 'x'.repeat(pad));
      fs.utimesSync(file, end / 1000, end / 1000);
      return file;
    };
    const big = plant(proj, 1, 0, 'Store the big one', [], 3 * 1024 * 1024);
    plant(proj, 2, 0, 'Store needle-word and NEEDLE-WORD');
    plant(proj, 3, 0, 'Store with a tool', [{ type: 'assistant', cwd, timestamp: new Date().toISOString(), message: { id: 't3', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'echo needle-word' } }] } }]);
    plant(proj, 4, 40, 'Store old needle-word');
    plant(proj, 5, 70, 'Store older');
    plant(proj, 6, 100, 'Store oldest');
    for (let i = 0; i < 202; i++) plant(oldProj, 1000 + i, 120 + i / 1000, 'Store very old'); // (more than one removal takes)
    const row = (n: number) => page.locator(`.sp-convos .conv-row[data-id="${sid(n)}"]`);
    const ids = async () => (await page.$$eval('.sp-convos .conv-row', (r) => r.map((x) => (x as HTMLElement).dataset.id!))).sort();
    const cfgNow = () => page.evaluate(() => window.jaffer.call('config.get'));
    const trashed = () => page.evaluate(() => ((window as any).__trashed ?? []) as string[][]);
    const menuItems = () => page.$$eval('.ctx-menu [role="menuitem"]', (b) => b.map((x) => x.textContent));
    const old = (days: number) => page.evaluate((d) => window.jaffer.call('claude.old', { days: d }), days) as Promise<{ ids: string[]; total: number }>;
    try {
      if (!(await cfgNow()).panel.open) await menu('toggle-panel');
      await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
      await page.fill('.sp-convos .conv-search input', 'Store');
      await page.click('.sp-convos .conv-refresh');
      await until(async () => (await ids()).length >= 6, 5_000, 'the planted conversations');

      // Storage: the total, the 10 biggest (the planted 3 MB one first) with size and folder; its trash button goes through the app's removal
      expect(await page.getAttribute('.sp-convos .st-toggle', 'aria-expanded')).toBe('false');
      await page.click('.sp-convos .st-toggle');
      await page.waitForSelector('.sp-convos .st-panel .st-row');
      expect(await page.textContent('.sp-convos .st-total')).toMatch(/^[\d.]+ (KB|MB) in \d+ conversations$/);
      expect(await page.getAttribute('.sp-convos .st-row >> nth=0', 'data-id')).toBe(sid(1));
      expect(await page.textContent('.sp-convos .st-row >> nth=0 >> .st-size')).toBe('3 MB');
      expect(await page.textContent('.sp-convos .st-row >> nth=0 >> .st-dir')).toMatch(/^~\/(\S+\/)?p16-store$/); // (the bridge's home is a folder above the test's HOME)
      expect(await page.locator('.sp-convos .st-row').count()).toBeLessThanOrEqual(10);
      await shot('16b-storage');
      fs.rmSync(big);
      await page.click('.sp-convos .st-row >> nth=0 >> .st-trash');
      await toastSaid('Moved 1 conversation to the Trash');
      expect((await trashed()).at(-1)).toEqual([sid(1)]);
      await until(async () => (await page.locator(`.sp-convos .st-row[data-id="${sid(1)}"]`).count()) === 0, 5_000, 'the storage view read again');
      await page.click('.sp-convos .st-toggle');
      await page.waitForSelector('.sp-convos .st-panel', { state: 'detached' });

      // deep search: no switch without the permission (and the daemon refuses), then the switch; the hits filter the rows, with N matches
      expect(await page.locator('.sp-convos .conv-deep').count()).toBe(0);
      await expect(page.evaluate(() => window.jaffer.call('claude.search', { q: 'needle-word' }))).rejects.toThrow();
      await patch({ permissions: { deepSearch: true } });
      await page.waitForSelector('.sp-convos .conv-deep');
      expect(await page.textContent('.sp-convos .conv-deep')).toBe('Search text');
      await page.click('.sp-convos .conv-deep');
      expect(await page.getAttribute('.sp-convos .conv-deep', 'aria-pressed')).toBe('true');
      await page.fill('.sp-convos .conv-search input', 'NEEDLE-word');
      await until(async () => JSON.stringify(await ids()) === JSON.stringify([sid(2), sid(4)].sort()), 5_000, 'the rows with the text');
      expect(await row(2).locator('.conv-hits').textContent()).toBe('2 matches');
      expect(await row(4).locator('.conv-hits').textContent()).toBe('1 match');
      expect(await row(3).count()).toBe(0); // (only in a tool call: never searched)
      await shot('16c-deep-search');
      await page.fill('.sp-convos .conv-search input', 'ne');
      await until(async () => ((await page.textContent('.sp-convos .conv-deep-note')) ?? '').includes('3 to 64'), 3_000, 'the note for a short query');
      await page.click('.sp-convos .conv-deep');
      await page.fill('.sp-convos .conv-search input', 'Store');
      await until(async () => (await ids()).length >= 5 && (await page.locator('.sp-convos .conv-hits').count()) === 0, 3_000, 'the title search back');
      await patch({ permissions: { deepSearch: false } });
      await until(async () => (await page.locator('.sp-convos .conv-deep').count()) === 0, 3_000, 'the switch gone');

      // Remove… → Older than 30/60/90 days: counts of all the conversations on disk, a click asks the app for the oldest 200, a toast says how many more
      const [o30, o60, o90] = [await old(30), await old(60), await old(90)];
      expect(o90.total).toBeGreaterThanOrEqual(203);
      expect(o90.ids).toHaveLength(200);
      expect(o30.total).toBeGreaterThan(o60.total); // (the planted 40 and 70 days old ones)
      expect(o60.total).toBeGreaterThan(o90.total);
      // (fix round) the menu asks the daemon once for all three counts; a click asks once more, for that age's ids as they are now
      await page.evaluate(() => {
        const w = window as any;
        w.__oldReal = w.jaffer.call;
        w.__oldCalls = [];
        w.jaffer.call = (m: string, p: any) => (m === 'claude.old' && w.__oldCalls.push(p?.days), w.__oldReal(m, p));
      });
      const oldCalls = () => page.evaluate(() => (window as any).__oldCalls as number[]);
      await page.click('.sp-convos .conv-remove');
      await page.waitForSelector('.ctx-menu');
      await until(async () => (await menuItems()).length === 4, 3_000, 'the Older than items');
      await sleep(200);
      expect((await oldCalls()).length).toBe(1);
      expect((await menuItems()).slice(1)).toEqual([`Older than 30 days (${o30.total})`, `Older than 60 days (${o60.total})`, `Older than 90 days (${o90.total})`]);
      expect(await page.textContent('.ctx-menu .ctx-note')).toContain('includes pinned and hidden');
      await page.click(`.ctx-menu [role="menuitem"] >> text=Older than 90 days`);
      await toastSaid(`${o90.total - 200} more: repeat`);
      expect((await oldCalls()).slice(1)).toEqual([90]);
      await page.evaluate(() => { const w = window as any; w.jaffer.call = w.__oldReal; });
      expect((await trashed()).at(-1)).toEqual(o90.ids);
      expect((await trashed()).at(-1)![0]).toBe(sid(1201)); // (the oldest first)
    } finally {
      await page.evaluate(() => { const w = window as any; if (w.__oldReal) w.jaffer.call = w.__oldReal; delete w.__oldReal; });
      await patch({ permissions: { deepSearch: false } });
      await page.fill('.sp-convos .conv-search input', '').catch(() => undefined);
      for (const d of [proj, oldProj]) fs.rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

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
    // an Enter that ends an IME composition (Japanese, Chinese, ...) runs nothing: the palette stays open
    await page.$eval('.palette input', (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await sleep(200);
    expect(await page.locator('.palette input').count()).toBe(1);
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
    expect(await page.$$eval('.settings-nav button', (b) => b.map((x) => x.textContent?.trim()))).toEqual(['Appearance', 'Terminal', 'Claude Code', 'Privacy and permissions', 'Help', 'Updates', 'Reset']); // (1.4.0: Privacy and permissions, Help)
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
    // 1.2.0: answering permission prompts from the notification is one switch, experimental and off by default (its words avoid the above);
    // 1.4.0: it lives in Privacy and permissions now (one place), and Claude Code points to it
    expect(await page.locator('.settings .field', { hasText: 'Answer permission prompts from the notification' }).count()).toBe(0);
    expect(await page.textContent('.settings')).toContain('in Privacy and permissions');
    await page.click('.settings-nav button:has-text("Privacy and permissions")');
    const approvalsField = page.locator('.settings .field', { hasText: 'Answer permission prompts from the notification' });
    expect(await approvalsField.count()).toBe(1);
    expect(await approvalsField.textContent()).toMatch(/Experimental\. Claude Code waits up to 20 s .* its own prompt appears as usual/);
    expect(await approvalsField.locator('input[type="checkbox"]').isChecked()).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  });

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

  // 1.1.0, the side panel (spec features 1 and 2)
  const panelCfg = async () => (await page.evaluate(() => window.jaffer.call('config.get'))).panel;
  const cols = () => page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.cols as number);
  /** Counts the window's pty.resize calls from here on. */
  const countResizes = () =>
    page.evaluate(() => {
      const w = window as any;
      w.__resizes = [];
      if (!w.__resizeSpy) {
        const orig = w.jaffer.call;
        w.jaffer.call = (m: string, p: unknown) => (m === 'pty.resize' && w.__resizes.push(p), orig(m, p));
        w.__resizeSpy = true;
      }
    });
  const resizes = () => page.evaluate(() => (window as any).__resizes.length as number);

  // 1.4.0: up to four terminals, only by the person's own split (spec features 2-5). Replaces 'there is exactly one session'.
  it('terminals: split up to four, focus, close and restart', async () => {
    // (no Escape first: readline would read it and the next key as one Meta key, and eat the first letter typed)
    await clipStub();
    const mainBefore = ((await page.evaluate(() => window.jaffer.call('pane.list'))) as { cwd: string }[])[0]!.cwd; // (main goes back there at the end)
    try {
      const dirs = ['split-a', 'split-b', 'split-c', 'split-d'].map((d) => path.join(env.userHome, d));
      for (const d of dirs) fs.mkdirSync(d, { recursive: true });
      const ids = () => page.$$eval('.panes > .pane', (els) => els.map((e) => (e as HTMLElement).dataset.pane ?? ''));
      const focused = () => page.evaluate(() => (window as any).__jaffer.activePane() as string);
      const outlined = () => page.$$eval('.pane[data-focused]', (els) => els.map((e) => (e as HTMLElement).dataset.pane ?? ''));
      const textOf = (id: string) =>
        page.evaluate((p) => {
          const t = (window as any).__jaffer.terminals.get(p)?.term;
          if (!t) return '';
          const b = t.buffer.active;
          let out = ''; // (wrapped rows joined: a long folder in the prompt wraps in a narrow terminal)
          for (let i = 0; i < b.length; i++) {
            const l = b.getLine(i)!;
            out += (l.isWrapped ? '' : '\n') + l.translateToString(true);
          }
          return out;
        }, id);
      const keyboardIn = () => page.evaluate(() => (document.activeElement?.closest('.pane') as HTMLElement | null)?.dataset.pane ?? null);
      const focusOn = async (id: string) => {
        await until(async () => (await focused()) === id && (await keyboardIn()) === id && (await outlined()).join() === ((await ids()).length > 1 ? id : ''), 5_000, `${id} to have the keyboard`);
      };
      const chipName = (id: string) => page.locator(`.pane[data-pane="${id}"] .pn-chip .pn-name`).textContent();
      const closeBtn = (id: string) => page.locator(`.pane[data-pane="${id}"] .pn-chip .pn-x`);
      const daemonPanes = () => page.evaluate(() => window.jaffer.call('pane.list')) as Promise<{ id: string; pid: number; cwd: string; cols: number; rows: number; busy: string | null; alive: boolean }[]>;
      const prompts = (id: string) => until(async () => /❯/.test(await textOf(id)), 15_000, `the prompt in ${id}`);
      const run = async (id: string, line: string, done: RegExp) => {
        await focusOn(id);
        await enter(line);
        await until(async () => done.test(await textOf(id)), 10_000, `${line} in ${id}`);
      };
      /** Every pane where the grid puts it: equal parts of the `.panes` box, within 2 px, none overlapping. */
      const geometry = async (n: number) => {
        const g = await page.evaluate(() => {
          const box = (e: Element) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          };
          return { all: box(document.querySelector('.panes')!), count: (document.querySelector('.panes') as HTMLElement).dataset.count, cells: [...document.querySelectorAll('.panes > .pane')].map(box) };
        });
        expect(g.count).toBe(String(n));
        expect(g.cells).toHaveLength(n);
        const grid = paneGrid(n);
        const P = g.all;
        grid.cells.forEach((c, i) => {
          const b = g.cells[i]!;
          const want = { x: P.x + ((c.col - 1) * P.w) / grid.cols, y: P.y + ((c.row - 1) * P.h) / grid.rows, w: P.w / grid.cols, h: (c.rows * P.h) / grid.rows };
          for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(b[k] - want[k]), `pane ${i + 1} of ${n}: ${k} ${b[k]} vs ${want[k]}`).toBeLessThanOrEqual(2);
        });
        if (n === 1) {
          // the one terminal's screen fills its pane (no leftover bands above or below)
          const fill = await page.evaluate(() => ({ pane: document.querySelector('.pane')!.getBoundingClientRect().height, screen: document.querySelector('.pane .xterm-screen')!.getBoundingClientRect().height }));
        expect(fill.pane).toBeGreaterThan(600); // (the one terminal takes the window's height, not a sliver)
          expect(fill.screen).toBeGreaterThan(fill.pane - 60);
        }
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            const a = g.cells[i]!;
            const b = g.cells[j]!;
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            expect(ox > 0.5 && oy > 0.5, `panes ${i + 1} and ${j + 1} of ${n} overlap`).toBe(false);
          }
      };
      /** Each xterm's size is the size its shell has, and the screen fits the pane's box (one terminal per box, no leftover band). */
      const sizes = async () => {
        const shown = await page.evaluate(() =>
          [...(window as any).__jaffer.terminals.entries()].map(([id, h]: [string, any]) => {
            const term = document.querySelector(`.term[data-pane="${id}"]`)!.getBoundingClientRect();
            const screen = document.querySelector(`.term[data-pane="${id}"] .xterm-screen`)!.getBoundingClientRect();
            return { id, cols: h.term.cols, rows: h.term.rows, term: { w: term.width, h: term.height }, screen: { w: screen.width, h: screen.height } };
          }),
        );
        const pty = await daemonPanes();
        for (const s of shown) {
          const p = pty.find((x) => x.id === s.id);
          if (!p || p.cols !== s.cols || p.rows !== s.rows) return false;
          if (s.screen.w > s.term.w || s.screen.h > s.term.h || s.screen.w < s.term.w - 60 || s.screen.h < s.term.h - 50) return false;
        }
        return shown.length === pty.length && shown;
      };
      /** pty.resize calls per pane since `countResizes()`. */
      const resizesBy = () => page.evaluate(() => (window as any).__resizes.reduce((m: Record<string, number>, r: { pane: string }) => ((m[r.pane] = (m[r.pane] ?? 0) + 1), m), {}) as Record<string, number>);

      // one terminal: no split controls of 1.3 and the old menu ids do nothing; it fills its area
      expect(await ids()).toEqual(['main']);
      expect(await page.$('button[title^="Split"], .divider, .pane-head')).toBeNull();
      await menu('split-right');
      await menu('split-down');
      await sleep(400);
      expect(await page.$$('.term .xterm')).toHaveLength(1);
      expect(await daemonPanes()).toHaveLength(1);
      await geometry(1);
      expect((await page.locator('.pane').boundingBox())!.height).toBeGreaterThan(600);
      expect(await closeBtn('main').getAttribute('aria-label')).toBe('Restart terminal');
      await page.click('.term');
      await run('main', `cd '${dirs[0]}'`, /split-a ❯ *$/m);
      await until(async () => (await chipName('main')) === 'split-a', 5_000, 'the chip to follow cd');

      // ⌘D: one more terminal in the focused one's folder takes the keyboard; the one whose box changed refits once (one pty.resize, not one per pixel)
      let n = 1;
      const shrinks: Record<string, string> = { p2: 'main', p3: 'p2', p4: 'main' }; // (2: side by side; 3: the right one splits; 4: the left one splits)
      for (const id of ['p2', 'p3', 'p4']) {
        await sleep(300);
        await countResizes();
        await menu('split-terminal');
        n++;
        await until(async () => (await ids()).length === n, 10_000, `${n} panes`);
        expect(await ids()).toEqual(['main', 'p2', 'p3', 'p4'].slice(0, n));
        await prompts(id);
        await focusOn(id);
        await until(async () => (await chipName(id)) === `split-${'abcd'[n - 2]}`, 5_000, `${id} to start in the folder of the one it was split from`);
        await until(sizes, 5_000, `every terminal's size to match its box at ${n}`);
        await sleep(400);
        const r = await resizesBy();
        for (const old of (await ids()).filter((x) => x !== id)) expect(r[old] ?? 0, `pty.resize of ${old} when ${id} came`).toBeLessThanOrEqual(1);
        expect(r[shrinks[id]!], `${shrinks[id]} refits once when ${id} comes`).toBe(1);
        expect(r[id] ?? 0, `${id} resizes at most once after it attached`).toBeLessThanOrEqual(1);
        await geometry(n);
        await run(id, `cd '${dirs[n - 1]}'`, new RegExp(`split-${'abcd'[n - 1]} ❯ *$`, 'm'));
        await until(async () => (await chipName(id)) === `split-${'abcd'[n - 1]}`, 5_000, `${id}'s chip`);
      }
      await shot('16-four-terminals');
      // a fifth is refused with a toast
      await menu('split-terminal');
      await toastSaid('At most four terminals.');
      await sleep(300);
      expect(await ids()).toHaveLength(4);
      expect(await daemonPanes()).toHaveLength(4);
      // each chip: its folder, a close button, a dot only where a Claude runs
      for (const [i, id] of ['main', 'p2', 'p3', 'p4'].entries()) {
        expect(await chipName(id)).toBe(`split-${'abcd'[i]}`);
        expect(await closeBtn(id).getAttribute('aria-label')).toBe('Close terminal');
      }
      expect(await page.locator('.titlebar button:not(.panel-toggle)').count()).toBe(0); // (the chips are in the panes, not the title bar)

      // ⌘1..⌘4, ⌘] and ⌘[ (both wrap) move the keyboard and the outline
      for (const [key, want] of [['focus-terminal-1', 'main'], ['focus-terminal-3', 'p3'], ['next-terminal', 'p4'], ['next-terminal', 'main'], ['prev-terminal', 'p4'], ['focus-terminal-2', 'p2']] as const) {
        await menu(key);
        await focusOn(want);
      }
      // typing goes only to the focused terminal
      await enter('echo ONLY-IN-P2-$((40+51))');
      await until(async () => /^ONLY-IN-P2-91/m.test(await textOf('p2')), 5_000, 'the marker in p2');
      for (const id of ['main', 'p3', 'p4']) expect(await textOf(id), id).not.toContain('ONLY-IN-P2');
      // the title bar follows the focused terminal
      await until(async () => /split-b/.test((await page.textContent('.session-pill')) ?? ''), 5_000, 'the title bar to show p2');
      await menu('focus-terminal-3');
      await until(async () => /split-c/.test((await page.textContent('.session-pill')) ?? ''), 5_000, 'the title bar to show p3');

      // a paste of several lines asks, and Paste puts the lines into the terminal they were pasted into, wherever the focus is by then
      await patch({ terminal: { pasteGuard: true } });
      await menu('focus-terminal-2');
      await focusOn('p2');
      const pasted = Array.from({ length: 14 }, (_, i) => `echo PASTE-P2-${i + 1}`).join('\n') + '\n';
      await page.evaluate((t) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        document.querySelector('.term[data-pane="p2"] .xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, pasted);
      await page.waitForSelector('.paste-bar');
      expect(await page.textContent('.paste-bar b')).toBe('Paste 14 lines?');
      await menu('focus-terminal-3');
      await focusOn('p3');
      await page.locator('.paste-bar .btn.primary').click();
      await page.waitForSelector('.paste-bar', { state: 'detached' });
      await focusOn('p3'); // (the keyboard stays with the focused terminal)
      await page.evaluate(() => window.jaffer.call('pty.write', { pane: 'p2', data: '\r' })); // (a shell with bracketed paste holds pasted lines until Enter)
      await until(async () => /^PASTE-P2-14/m.test(await textOf('p2')), 8_000, 'the pasted lines to run in p2');
      expect(await textOf('p3')).not.toContain('PASTE-P2');

      // a turn of a Claude in a terminal that is not focused still counts, and its summary says where; moving the focus counts nothing
      await endClaude();
      await menu('focus-terminal-1');
      await focusOn('main');
      const turns = () => page.evaluate(() => (window as any).__jaffer.turns() as number);
      const t0 = await turns();
      const fg = { id: 'fg-main', pane: 'main', state: 'working', turnStartedAtAgo: 5_000 };
      const bg = { id: 'bg-p2', pane: 'p2', turnStartedAtAgo: 25_000 };
      await inject([fg, { ...bg, state: 'working' }]);
      await inject([fg, { ...bg, state: 'idle' }]);
      await inject([fg, { ...bg, state: 'idle', cost: { usd: 0.02, at: 93 } }]);
      await until(async () => (await turns()) === t0 + 1, 5_000, "p2's turn to count");
      await until(async () => (await toastCount('split-b: Claude finished in 25s')) === 1, 5_000, "the summary naming p2's folder");
      for (const k of ['focus-terminal-2', 'focus-terminal-1']) await menu(k);
      await focusOn('main');
      await sleep(500);
      expect(await turns()).toBe(t0 + 1);
      expect(await toastCount('Claude finished in')).toBe(1);
      await inject([]);

      // resume types only into the focused, idle terminal; a busy focused one gets nothing typed (copied, and why)
      const sid = '00000093-aaaa-4bbb-8ccc-ddddeeeeffff';
      const pdir = path.join(env.userHome, '.claude', 'projects', '-split-a');
      fs.mkdirSync(pdir, { recursive: true });
      const at = Date.now();
      const line = (type: string, t: number, extra: object) => JSON.stringify({ type, cwd: dirs[0], timestamp: new Date(t).toISOString(), ...extra });
      fs.writeFileSync(path.join(pdir, `${sid}.jsonl`), [line('user', at - 2000, { message: { role: 'user', content: 'split resume' } }), line('assistant', at, { message: { id: 'r93', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }] } })].join('\n') + '\n');
      await menu('focus-terminal-2');
      await run('p2', 'sleep 31', /sleep 31/);
      await until(async () => (await daemonPanes()).find((p) => p.id === 'p2')?.busy === 'sleep 31', 5_000, 'p2 to be busy');
      await menu('focus-terminal-1');
      await run('main', 'claude() { echo "RESUMED-IN:$JAFFER_PANE:$*"; }; echo DEFINED-$((90+5))', /^DEFINED-95/m);
      await menu('resume-last');
      await until(async () => /^RESUMED-IN:main:--resume 00000093/m.test(await textOf('main')), 8_000, 'the resume in main');
      for (const id of ['p2', 'p3', 'p4']) expect(await textOf(id), id).not.toContain('RESUMED-IN');
      await sleep(2100); // (the type-once lock)
      await menu('focus-terminal-2');
      await focusOn('p2');
      const p2Before = await textOf('p2');
      await menu('resume-last');
      await toastSaid('sleep 31 is running: command copied');
      expect(await page.evaluate(() => (window as any).__powerClip.written.at(-1))).toBe(`cd '${dirs[0]}' && claude --resume ${sid}`);
      await sleep(400);
      expect(await textOf('p2')).toBe(p2Before);
      expect((await textOf('main')).match(/^RESUMED-IN:/gm)).toHaveLength(1); // (typed once, into main only)

      // ✕ on a terminal that runs something asks first (under its chip); Cancel (the default) and Esc keep it
      await closeBtn('p2').click();
      const ask = page.locator('.pane[data-pane="p2"] .pn-confirm');
      await ask.waitFor();
      expect(await ask.textContent()).toContain('A command is running: sleep 31');
      await until(async () => (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancel', 3_000, 'Cancel to have the keyboard');
      await page.keyboard.press('Enter');
      await ask.waitFor({ state: 'detached' });
      await closeBtn('p2').click();
      await ask.waitFor();
      await until(async () => (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancel', 3_000, 'Cancel to have the keyboard again');
      await page.keyboard.press('Escape');
      await ask.waitFor({ state: 'detached' });
      await sleep(300);
      expect(await ids()).toHaveLength(4);
      expect((await daemonPanes()).find((p) => p.id === 'p2')?.busy).toBe('sleep 31');
      // ⇧⌘W is the same question for the focused terminal. Closed meanwhile from elsewhere, the question goes with it and the keyboard goes
      // to a neighbour; the id opened again starts without the question
      await menu('focus-terminal-2');
      await focusOn('p2');
      await menu('close-terminal');
      await ask.waitFor();
      await page.evaluate(() => window.jaffer.call('pane.close', { pane: 'p2' }));
      await until(async () => (await ids()).join() === 'main,p3,p4', 5_000, 'p2 to close');
      expect((await daemonPanes()).map((p) => p.id)).toEqual(['main', 'p3', 'p4']);
      await focusOn('p3');
      await geometry(3);
      await until(sizes, 5_000, 'the sizes at 3 after a close');
      expect(await page.evaluate(() => (window as any).__jaffer.terminals.has('p2'))).toBe(false);
      await menu('split-terminal');
      await until(async () => (await ids()).join() === 'main,p3,p4,p2', 5_000, 'p2 opened again, last');
      await prompts('p2');
      await sleep(300);
      expect(await page.locator('.pn-confirm').count()).toBe(0);
      // nothing runs: ✕ closes at once, and a double click sends one request
      await page.evaluate(() => {
        const w = window as any;
        w.__closes = 0;
        const orig = w.jaffer.call;
        w.jaffer.call = (m: string, p: unknown) => (m === 'pane.close' && w.__closes++, orig(m, p));
        w.__closeSpyOff = () => (w.jaffer.call = orig);
      });
      await closeBtn('p2').dblclick();
      await until(async () => (await ids()).join() === 'main,p3,p4', 5_000, 'p2 to close at once');
      await sleep(400);
      expect(await page.evaluate(() => (window as any).__closes)).toBe(1);
      await page.evaluate(() => (window as any).__closeSpyOff());
      await closeBtn('p4').click();
      await until(async () => (await ids()).join() === 'main,p3', 5_000, 'p4 to close without a question');
      expect(await page.locator('.pn-confirm').count()).toBe(0);
      await geometry(2);

      // the sticky command header sits over the focused terminal, and follows it when the window is resized
      await focusOn('p3');
      await run('p3', 'seq 1 400', /^400$/m);
      await page.evaluate(() => (window as any).__jaffer.terminals.get('p3').term.scrollLines(-150));
      await page.waitForSelector('.sticky-cmd');
      const stickyOverP3 = async () => {
        const st = (await page.locator('.sticky-cmd').boundingBox())!;
        const p3 = (await page.locator('.pane[data-pane="p3"]').boundingBox())!;
        return Math.abs(st.x - (p3.x + 12)) <= 2 && Math.abs(st.y - (p3.y + 6)) <= 2;
      };
      await until(stickyOverP3, 3_000, 'the header over p3');
      await page.setViewportSize({ width: 1100, height: 860 });
      await until(stickyOverP3, 3_000, 'the header to follow p3 after a resize');
      await page.setViewportSize({ width: 1360, height: 860 });
      await until(stickyOverP3, 3_000, 'the header to follow p3 back');
      await page.evaluate(() => (window as any).__jaffer.terminals.get('p3').term.scrollToBottom());
      await page.waitForSelector('.sticky-cmd', { state: 'detached' });
      // the find bar searches the focused terminal; when the focus moves, the other terminal keeps no marks
      const findMarks = (id: string) => page.locator(`.term[data-pane="${id}"] .xterm-find-result-decoration, .term[data-pane="${id}"] .xterm-find-active-result-decoration`).count();
      await menu('find');
      await page.waitForSelector('.findbar input');
      await page.fill('.findbar input', '399');
      await until(async () => (await findMarks('p3')) > 0, 5_000, 'the match marked in p3');
      await menu('focus-terminal-1');
      await until(async () => (await findMarks('p3')) === 0, 5_000, "p3's marks to go when the focus moves");
      await page.keyboard.press('Escape');
      await page.waitForSelector('.findbar', { state: 'detached' });
      await focusOn('main');

      // a Claude in a terminal (its hooks name the pane): closing that terminal ends that Claude only
      await sendHook('UserPromptSubmit', { session_id: 'split-claude-p3', jaffer_pane: 'p3', prompt: 'hi' });
      await sendHook('UserPromptSubmit', { session_id: 'split-claude-main', jaffer_pane: 'main', prompt: 'hi' });
      const stateOf = async (id: string) => ((await page.evaluate(() => window.jaffer.call('claude.state'))).sessions as { id: string; state: string }[]).find((s) => s.id === id)?.state;
      await until(async () => (await page.locator('.pane[data-pane="p3"] .pn-dot[data-state="working"]').count()) === 1, 5_000, 'p3 chip to show its Claude working');
      await until(async () => (await page.locator('.pane[data-pane="main"] .pn-dot[data-state="working"]').count()) === 1, 5_000, 'main chip to show its own Claude');
      await closeBtn('p3').click();
      const askClaude = page.locator('.pane[data-pane="p3"] .pn-confirm');
      await askClaude.waitFor();
      expect(await askClaude.textContent()).toContain('Claude is running here');
      await askClaude.getByRole('button', { name: 'End terminal' }).click();
      await until(async () => (await ids()).join() === 'main', 5_000, 'p3 to close');
      await until(async () => (await stateOf('split-claude-p3')) === 'ended', 5_000, "p3's Claude to end");
      expect(await stateOf('split-claude-main')).toBe('working');
      await sendHook('SessionEnd', { session_id: 'split-claude-main' });
      await sendHook('SessionEnd', { session_id: 'split-claude-p3' });
      await focusOn('main');
      await geometry(1);

      // the last terminal's ✕ is Restart terminal: a fresh shell in the same folder, a blank screen
      expect(await closeBtn('main').getAttribute('aria-label')).toBe('Restart terminal');
      await enter('echo before-the-restart-94');
      await until(async () => /^before-the-restart-94/m.test(await textOf('main')), 5_000, 'the marker');
      const pid = (await daemonPanes())[0]!.pid;
      await closeBtn('main').click();
      await until(async () => {
        const p = (await daemonPanes())[0];
        return p?.alive && p.pid !== pid;
      }, 10_000, 'a fresh shell');
      expect(await page.locator('.pn-confirm').count()).toBe(0);
      await until(async () => !(await textOf('main')).includes('before-the-restart-94'), 10_000, 'the old screen to go');
      await prompts('main');
      expect(fs.realpathSync((await daemonPanes())[0]!.cwd)).toBe(fs.realpathSync(dirs[0]!));
      await until(async () => (await chipName('main')) === 'split-a', 5_000, 'the same folder');
      expect(await ids()).toEqual(['main']);
    } finally {
      fs.rmSync(path.join(env.userHome, '.claude', 'projects', '-split-a'), { recursive: true, force: true });
      await page.evaluate(() => { const w = window as any; w.__closeSpyOff?.(); delete w.__closeSpyOff; });
      for (const p of (await page.evaluate(() => window.jaffer.call('pane.list'))) as { id: string }[]) if (p.id !== 'main') await page.evaluate((id) => window.jaffer.call('pane.close', { pane: id }), p.id);
      await page.evaluate((d) => window.jaffer.call('pty.write', { pane: 'main', data: `cd '${d}'\r` }), mainBefore);
    }
  }, 120_000);

  it('the side panel: open by default beside the card; ⌘B, the menu, the title bar button, the palette and Settings toggle it, kept in panel.open; closed, nothing of it renders; it slides (not with motion off) and fades in focus mode', async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.workspace > .side-panel');
    expect(await panelCfg()).toEqual({ open: true, width: 300 });
    const card = (await page.locator('.terminal-area').boundingBox())!;
    const panel = (await page.locator('.side-panel').boundingBox())!;
    expect(panel.x).toBeGreaterThan(card.x + card.width); // at the right of the card
    expect(Math.round(panel.width)).toBe(300);
    expect(await page.getAttribute('.titlebar .panel-toggle', 'aria-pressed')).toBe('true');
    const onDisk = () => JSON.parse(fs.readFileSync(env.paths.config, 'utf8')).panel?.open;

    // ⌘B closes it (sliding out first), and the choice is written to the config file
    await page.click('.term');
    await page.keyboard.press('Meta+b');
    expect(await page.locator('.side-panel[data-anim="out"]').count()).toBe(1);
    expect(await page.$eval('.side-panel', (el) => getComputedStyle(el).animationName)).toBe('panel-out');
    await page.waitForSelector('.side-panel', { state: 'detached', timeout: 2_000 });
    expect(await page.locator('.side-panel, .now-card, .sp-convos').count()).toBe(0);
    await until(async () => onDisk() === false, 5_000, 'panel.open false on disk');
    expect(await page.getAttribute('.titlebar .panel-toggle', 'aria-pressed')).toBe('false');
    // the menu item opens it again (sliding in); 250 ms after the key press, a menu toggle would count as that same press
    await sleep(300);
    await menu('toggle-panel');
    await page.waitForSelector('.side-panel[data-anim="in"]');
    expect(await page.$eval('.side-panel', (el) => getComputedStyle(el).animationName)).toBe('panel-in');
    await until(async () => onDisk() === true, 5_000, 'panel.open true on disk');
    // the title bar's button closes it, and the terminal keeps the keyboard
    await page.click('.term');
    await page.click('.titlebar .panel-toggle');
    await page.waitForSelector('.side-panel', { state: 'detached', timeout: 2_000 });
    expect(await page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
    await until(async () => (await panelCfg()).open === false, 5_000, 'panel.open false');
    // the palette opens it
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('side panel');
    expect(await page.textContent('.palette-list')).toContain('Toggle side panel');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.side-panel');
    await until(async () => (await panelCfg()).open === true, 5_000, 'panel.open true');
    // Settings → Appearance → Show the side panel
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    const sw = page.locator('label.field', { hasText: 'Show the side panel' }).locator('input');
    expect(await sw.isChecked()).toBe(true);
    await sw.click();
    await until(async () => (await panelCfg()).open === false, 5_000, 'switched off');
    await page.waitForSelector('.side-panel', { state: 'detached', timeout: 2_000 });
    await sw.click();
    await until(async () => (await panelCfg()).open === true, 5_000, 'switched on');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await page.waitForSelector('.side-panel');
    // motion off: it comes and goes at once, with no slide
    await cfgPatch({ appearance: { animations: false } });
    try {
      // (the daemon answers before the page has taken the new config: wait for the page to be in motion-off before pressing)
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 5_000, 'the page in motion-off');
      await page.click('.term');
      await page.keyboard.press('Meta+b');
      expect(await page.locator('.side-panel').count()).toBe(0); // gone at once
      await page.keyboard.press('Meta+b');
      await page.waitForSelector('.side-panel');
      expect(await page.getAttribute('.side-panel', 'data-anim')).toBeNull();
      // (a style read in the frame the panel mounts in can still be empty: wait for the computed value)
      await until(async () => (await page.$eval('.side-panel', (el) => getComputedStyle(el).animationName)) === 'none', 5_000, 'no animation on the panel');
    } finally {
      await cfgPatch({ appearance: { animations: true } });
    }
    // focus mode: it fades with the other chrome
    await menu('focus-mode');
    await until(async () => (await page.$eval('.side-panel', (el) => getComputedStyle(el).opacity)) === '0.15', 3_000, 'the panel to fade');
    await menu('focus-mode');
    await until(async () => (await page.$eval('.side-panel', (el) => getComputedStyle(el).opacity)) === '1', 3_000, 'the panel to come back');
    expect(await panelCfg()).toEqual({ open: true, width: 300 });
  }, 40_000);

  it('the side panel and the terminal: open, close and a drag of its edge re-fit the terminal once each (it keeps its size while dragged), the width stays in 220..480 and is kept in panel.width, and nothing on the screen is lost', async () => {
    await page.click('.term');
    await page.evaluate(() => window.jaffer.call('pty.write', { data: '\x15echo panel-marker-$((40+2))\r' }));
    await until(async () => /^panel-marker-42/m.test(await termText()), 10_000, 'the marker');
    await countResizes();
    const open = await cols();
    // closing gives the terminal the panel's room: more columns, one resize of the shell
    await page.keyboard.press('Meta+b');
    await until(async () => (await cols()) > open, 3_000, 'more columns with the panel closed');
    const closed = await cols();
    await sleep(400);
    expect(await resizes()).toBe(1);
    expect(await cols()).toBe(closed);
    await countResizes();
    await page.keyboard.press('Meta+b');
    await until(async () => (await cols()) === open, 3_000, 'the columns back with the panel open');
    await sleep(400);
    expect(await resizes()).toBe(1);

    // dragging the edge 100 px to the left: the panel follows, the terminal keeps its size until it is let go, then fits once
    await countResizes();
    const h = (await page.locator('.sp-handle').boundingBox())!;
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x - i * 10, y);
    await sleep(250);
    expect(Math.round((await page.locator('.side-panel').boundingBox())!.width)).toBe(400);
    expect(await page.locator('.sp-handle[data-drag]').count()).toBe(1);
    expect(await cols()).toBe(open); // held while dragging
    expect(await resizes()).toBe(0);
    await page.mouse.up();
    await until(async () => (await cols()) < open, 3_000, 'fewer columns once let go');
    await sleep(400);
    expect(await resizes()).toBe(1);
    await until(async () => (await panelCfg()).width === 400, 5_000, 'panel.width 400');
    // and past its ends it stops at 480 and at 220
    const drag = async (dx: number) => {
      const b = (await page.locator('.sp-handle').boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + dx / 2, b.y + b.height / 2);
      await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2);
      await page.mouse.up();
    };
    await drag(-600);
    await until(async () => (await panelCfg()).width === 480, 5_000, 'panel.width 480');
    expect(Math.round((await page.locator('.side-panel').boundingBox())!.width)).toBe(480);
    await drag(900);
    await until(async () => (await panelCfg()).width === 220, 5_000, 'panel.width 220');
    expect(Math.round((await page.locator('.side-panel').boundingBox())!.width)).toBe(220);
    // the handle also takes the arrow keys
    await page.focus('.sp-handle');
    await page.keyboard.press('ArrowLeft');
    await until(async () => (await panelCfg()).width === 240, 5_000, 'panel.width 240');
    // nothing on the screen was lost to the resizes
    expect(await termText()).toMatch(/^panel-marker-42/m);
    await cfgPatch({ panel: { width: 300 } });
    await until(async () => Math.round((await page.locator('.side-panel').boundingBox())!.width) === 300, 5_000, 'back to 300');
    await page.click('.term');
  }, 40_000);

  it('the side panel keeps the terminal first: a held ⌘B does not flap it, closing it from inside gives the keyboard to the terminal, the arrow keys on its edge write the width once and fit the terminal once, and a narrow window caps it (the terminal keeps 360 px)', async () => {
    if (!(await panelCfg()).open) await menu('toggle-panel');
    await page.waitForSelector('.side-panel');
    // ⌘B held down: only the first press counts (the repeats do nothing)
    await page.click('.term');
    await page.evaluate(() => { for (let i = 0; i < 3; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, repeat: true, bubbles: true, cancelable: true })); });
    await sleep(400);
    expect(await page.locator('.side-panel').count()).toBe(1);
    expect((await panelCfg()).open).toBe(true);
    // closed while its search has the keyboard: the terminal gets it (with the slide, and with motion off)
    const focusIs = () => page.evaluate(() => (document.activeElement?.classList.contains('xterm-helper-textarea') ? 'terminal' : document.activeElement?.matches('.side-panel *') ? 'panel' : 'other'));
    for (const motion of [true, false]) {
      await cfgPatch({ appearance: { animations: motion } });
      await page.focus('.sp-convos .conv-search input');
      expect(await focusIs()).toBe('panel');
      await page.keyboard.press('Meta+b');
      await page.waitForSelector('.side-panel', { state: 'detached' });
      expect(await focusIs(), `motion ${motion}`).toBe('terminal');
      await page.keyboard.press('Meta+b');
      await page.waitForSelector('.side-panel');
      await sleep(250);
    }
    await cfgPatch({ appearance: { animations: true } });
    // the arrow keys on the edge: shown at once, the terminal held, one write of panel.width and one fit after the keys stop
    await until(async () => (await panelCfg()).width === 300, 3_000, 'width 300 to start');
    await sleep(300);
    const before = await cols();
    await countResizes();
    await page.focus('.sp-handle');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    expect(Math.round((await page.locator('.side-panel').boundingBox())!.width)).toBe(360);
    expect((await panelCfg()).width).toBe(300);
    expect(await cols()).toBe(before);
    expect(await resizes()).toBe(0);
    await until(async () => (await panelCfg()).width === 360, 3_000, 'panel.width 360 once the keys stop');
    await until(async () => (await cols()) < before, 3_000, 'the terminal to fit');
    await sleep(400);
    expect(await resizes()).toBe(1);
    await cfgPatch({ panel: { width: 480 } });
    // a narrow window: the panel gives way so the terminal keeps 360 px of it; the kept width is not rewritten
    await page.setViewportSize({ width: 640, height: 520 });
    try {
      await until(async () => Math.round((await page.locator('.side-panel').boundingBox())!.width) === 280, 3_000, 'the panel capped at 640 − 360');
      expect((await page.locator('.terminal-area').boundingBox())!.width).toBeGreaterThanOrEqual(300);
      expect((await panelCfg()).width).toBe(480);
    } finally {
      await page.setViewportSize({ width: 1360, height: 860 });
    }
    await until(async () => Math.round((await page.locator('.side-panel').boundingBox())!.width) === 480, 3_000, 'the kept width back in a wide window');
    await cfgPatch({ panel: { width: 300 } });
    await until(async () => Math.round((await page.locator('.side-panel').boundingBox())!.width) === 300, 3_000, 'back to 300');
    await page.click('.term');
  }, 40_000);

  it('the Now card: not running (⇧⌘C starts it), working (the tool, the time, the progress, the cost, today against the budget, the agents without ids, the counts, the files to reveal), needs you, and a finished turn’s summary', async () => {
    await endClaude();
    await inject([]);
    await page.waitForSelector('.now-card[data-state="off"]');
    expect(await textOf('.now-card')).toContain('Claude is not running');
    expect(await textOf('.now-card')).toContain('⇧⌘C');
    await cfgPatch({ claude: { typicalTurnMs: 60_000, dailyBudgetUsd: 5 } });
    try {
      const files = Array.from({ length: 10 }, (_, i) => `/work/app/src/file${i}.ts`);
      const calls = [
        { name: 'Read', category: 'read', startAgo: 120_000, endAgo: 119_000 }, // before this turn: not counted
        { name: 'Read', category: 'read', startAgo: 25_000, endAgo: 24_000 },
        { name: 'Read', category: 'read', startAgo: 20_000, endAgo: 19_000 },
        { name: 'Edit', category: 'write', startAgo: 15_000, endAgo: 14_000 },
        { name: 'Bash', category: 'shell', startAgo: 2_000 },
      ];
      const subagents = [
        { id: 'agent-opaque-id-1', status: 'running', startAgo: 130_000, tool: 'Read' },
        { id: 'agent-opaque-id-2', status: 'done', startAgo: 90_000 },
      ];
      await inject([{ id: 'now-1', state: 'working', turnStartedAtAgo: 30_000, tool: { name: 'Bash', id: 'n1' }, calls, files, subagents, live: { input: 1000, output: 500, usd: 0.03, at: 1 } }], { usd: 4, date: 'today' });
      await page.waitForSelector('.now-card[data-state="working"]');
      expect(await textOf('.now-label')).toBe('Claude is working');
      expect(await textOf('.now-tool')).toBe('Bash');
      expect(await textOf('.now-elapsed')).toMatch(/^3\ds$/);
      const bar = await page.$eval('.now-progress i', (el) => parseFloat((el as HTMLElement).style.width));
      expect(bar).toBeGreaterThanOrEqual(50);
      expect(bar).toBeLessThan(60);
      expect(await textOf('.now-cost')).toBe('≈ $0.03 so far');
      expect(await page.getAttribute('.now-cost', 'title')).toMatch(/estimate.*not billed per token/i);
      expect(await textOf('.now-today > span')).toBe('Today ≈ $4.00 of $5.00');
      expect(await page.getAttribute('.now-today', 'data-level')).toBe('warn');
      expect(await page.$$eval('.now-agents li', (els) => els.map((e) => e.textContent))).toEqual([expect.stringMatching(/^Agent 1 · Read · 2m 1\ds$/)]);
      expect(await textOf('.side-panel')).not.toContain('opaque-id');
      expect(await textOf('.now-counts')).toBe('2 reads · 1 edit · 1 shell');
      expect(await page.$$eval('.now-files button', (els) => els.map((e) => e.textContent))).toEqual(files.slice(0, 8).map((f) => f.split('/').pop()));
      expect(await textOf('.now-more')).toBe('+2 more');
      await page.evaluate(() => ((window as any).__revealed = []));
      await page.locator('.now-files button').first().click();
      await until(async () => (await page.evaluate(() => (window as any).__revealed)).includes(files[0]), 3_000, 'the file revealed in Finder');
      await shot('19a-side-panel-working');

      // needs you: the tool it asks about, no progress bar
      await inject([{ id: 'now-1', state: 'needs-you', turnStartedAtAgo: 40_000, tool: { name: 'Bash', id: 'n1' }, notice: 'Claude needs your permission to use Bash' }]);
      await page.waitForSelector('.now-card[data-state="needs-you"]');
      expect(await textOf('.now-label')).toBe('Claude needs you');
      expect(await textOf('.now-tool')).toBe('Bash');
      expect(await textOf('.now-hint')).toMatch(/terminal/);
      expect(await page.locator('.now-progress').count()).toBe(0);

      // a finished turn (another session: no summary toast from this injection): its summary line
      await inject([{ id: 'now-2', state: 'idle', sinceAgo: 1_000, turnStartedAtAgo: 73_000, cost: { usd: 0.04, at: 7 }, calls: [{ name: 'Read', category: 'read', startAgo: 60_000, endAgo: 59_000 }] }]);
      await page.waitForSelector('.now-card[data-state="idle"]');
      expect(await textOf('.now-summary')).toBe('Claude finished in 1m 12s · 1 read · ≈ $0.04');
      expect(await textOf('.now-cost')).toBe('≈ $0.04');
      // showCost off: no figure anywhere on the card
      await cfgPatch({ claude: { showCost: false } });
      await until(async () => (await page.locator('.now-cost, .now-today').count()) === 0, 5_000, 'the figures to go');
      expect(await textOf('.now-summary')).toBe('Claude finished in 1m 12s · 1 read');
    } finally {
      await cfgPatch({ claude: { showCost: true, typicalTurnMs: 0, dailyBudgetUsd: 0 } });
      await inject([]);
    }
  }, 40_000);

  it('the Now card’s turn bars (two finished turns, a title of time and cost each, none of the cost with showCost off) and "Claude worked … today" (live while it works, hidden for none)', async () => {
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`); // (a window of its own: no turns yet)
    await page.waitForSelector('.term .xterm');
    await endClaude();
    // (today's figures are the test's own, not what the daemon added up over the tests before this one)
    await inject([], { usd: 0, date: 'today', workMs: 0 });
    await page.waitForSelector('.now-card[data-state="off"]');
    expect(await page.locator('.now-turns, .now-worked').count()).toBe(0);
    try {
      // a turn finishes: one bar is no chart
      const finish = async (ago: number, usd: number, at: number) => {
        await inject([{ id: 'bars-1', state: 'working', turnStartedAtAgo: ago }]);
        await inject([{ id: 'bars-1', state: 'idle', turnStartedAtAgo: ago, cost: { usd, at } }]);
      };
      await finish(72_000, 0.04, 11);
      await page.waitForSelector('.now-card[data-state="idle"]');
      expect(await page.locator('.now-turns').count()).toBe(0);
      await finish(30_000, 0.01, 12);
      await page.waitForSelector('.now-turns');
      expect(await page.$$eval('.now-turns rect > title', (els) => els.map((e) => e.textContent))).toEqual(['1m 12s · ≈ $0.04', '30s · ≈ $0.01']);
      expect(await page.getAttribute('.now-turns', 'role')).toBe('img');
      expect(await page.getAttribute('.now-turns', 'aria-label')).toBe('Last 2 turns: the latest took 30s, the longest 1m 12s');
      const hs = await page.$$eval('.now-turns rect', (els) => els.map((e) => Number(e.getAttribute('height'))));
      expect(hs[0]).toBe(28); // the longest fills the chart, the other is shorter
      expect(hs[1]).toBeLessThan(hs[0]!);
      expect(await page.$$eval('.now-turns rect', (els) => els.map((e) => e.getAttribute('data-level')))).toEqual(['high', 'low']);
      const fills = await page.$$eval('.now-turns rect', (els) => els.map((e) => getComputedStyle(e).fill));
      expect(fills[0]).not.toBe(fills[1]); // a cost tint of its own
      expect(await page.locator('.side-panel > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).not.toContain('now-turns'); // (inside the Now card)
      await shot('19c-turn-bars');
      // showCost off: the titles say the time only
      await cfgPatch({ claude: { showCost: false } });
      await until(async () => (await page.$$eval('.now-turns rect > title', (els) => els.map((e) => e.textContent))).join() === '1m 12s,30s', 5_000, 'no cost in the titles');
      // time worked today: the day's total (also without the cost), and while it works the running turn too; none for none
      await inject([{ id: 'bars-1', state: 'idle' }], { usd: 1, date: 'today', workMs: 4_320_000 });
      await until(async () => (await textOf('.now-worked')) === 'Claude worked 1h 12m today', 5_000, 'the day’s time');
      await inject([{ id: 'bars-1', state: 'working', turnStartedAtAgo: 30_000 }], { usd: 1, date: 'today', workMs: 60_000 });
      await until(async () => /^Claude worked 1m 3\ds today$/.test((await textOf('.now-worked')) ?? ''), 5_000, 'the day’s time and the running turn');
      await inject([{ id: 'bars-1', state: 'idle' }], { usd: 1, date: 'today' });
      await until(async () => (await page.locator('.now-worked').count()) === 0, 5_000, 'no line for no time');
    } finally {
      await cfgPatch({ claude: { showCost: true } });
      await inject([]);
    }
  }, 40_000);

  it('the Now card, 1.4.0: the context meter (percent and levels, the tokens alone without a window, one toast at 85 % per session), the last 5 hours, the work-time budget (its level and one toast), the Today list after two finished turns, and project budgets tint the cost by folder', async () => {
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`); // (a window of its own: no turns, no toasts yet)
    await page.waitForSelector('.term .xterm');
    await endClaude();
    const sid = (n: number) => `${String(n).padStart(8, '0')}-cccc-4ddd-8eee-ffff00002222`;
    const T = Date.now();
    // the window's calls for the list and the last 5 hours, stood in for (restored at the end)
    await page.evaluate(
      ([a, b, t]) => {
        const w = window as any;
        w.__ciReal = w.jaffer.call;
        w.jaffer.call = (m: string, p: unknown) =>
          m === 'claude.usage5h'
            ? Promise.resolve({ tokens: 3_200_000, usd: 4.5, files: 2 })
            : m === 'claude.history'
              ? Promise.resolve({ items: [{ id: a, cwd: '/work/budget-a', startedAt: t - 7_200_000, endedAt: t - 3_600_000, durMs: 3_600_000, usd: 9 }, { id: b, cwd: '/work/budget-b', startedAt: t - 7_200_000, endedAt: t - 3_600_000, durMs: 3_600_000, usd: 2 }] })
              : w.__ciReal(m, p);
      },
      [sid(1), sid(2), T] as const,
    );
    try {
      if (!(await page.evaluate(() => window.jaffer.call('config.get'))).panel.open) await cfgPatch({ panel: { open: true } });
      await page.waitForSelector('.side-panel .sp-convos .conv-refresh');
      await page.click('.sp-convos .conv-refresh');
      // the last 5 hours: read with the list, money with showCost, and what it is not
      await until(async () => (await textOf('.now-5h')) === "Last 5 h ≈ $4.50 · 3.2M tokens (estimate, not your plan's limit)", 5_000, 'the last 5 hours');
      expect(await page.getAttribute('.now-5h', 'title')).toMatch(/estimate/i);

      // the context meter: the share of the window, warn from 80 %, danger from 92 %, a meter with its value; the tokens alone without a window
      await inject([{ id: 'ctx-1', state: 'idle', context: { tokens: 620_000, window: 1_000_000, at: T } }]);
      await until(async () => (await textOf('.now-ctx > span')) === 'Context 62% of 1M', 5_000, 'the context meter');
      expect(await page.getAttribute('.now-ctx', 'data-level')).toBe('ok');
      expect(await page.getAttribute('.now-ctx-bar', 'role')).toBe('meter');
      expect(await page.getAttribute('.now-ctx-bar', 'aria-valuenow')).toBe('62');
      expect(await page.getAttribute('.now-ctx', 'title')).toMatch(/estimate/i);
      expect(await toastCount('Context is 85% full')).toBe(0);
      await inject([{ id: 'ctx-1', state: 'idle', context: { tokens: 170_000, window: 200_000, at: T } }]);
      await until(async () => (await page.getAttribute('.now-ctx', 'data-level')) === 'warn', 5_000, 'warn at 85 %');
      await until(async () => (await toastCount('Context is 85% full. Claude compacts it automatically near the limit.')) === 1, 5_000, 'the toast at 85 %');
      await inject([{ id: 'ctx-1', state: 'idle', context: { tokens: 190_000, window: 200_000, at: T } }]);
      await until(async () => (await page.getAttribute('.now-ctx', 'data-level')) === 'danger', 5_000, 'danger from 92 %');
      await sleep(300);
      expect(await toastCount('Context is 85% full')).toBe(1); // once per session
      await shot('19d-context-meter');
      // a compaction brings the meter down: the next time it fills, the toast comes again (once)
      await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.toast button[aria-label="Dismiss"]').forEach((b) => b.click()));
      await until(async () => (await toastCount('Context is 85% full')) === 0, 3_000, 'the toasts dismissed');
      await inject([{ id: 'ctx-1', state: 'working', compacting: true, context: { tokens: 190_000, window: 200_000, at: T } }]);
      await inject([{ id: 'ctx-1', state: 'idle', context: { tokens: 40_000, window: 200_000, at: T } }]);
      await inject([{ id: 'ctx-1', state: 'idle', context: { tokens: 175_000, window: 200_000, at: T } }]);
      await until(async () => (await toastCount('Context is 85% full')) === 1, 5_000, 'the toast again after a compaction');
      await inject([{ id: 'ctx-1', state: 'idle', context: { tokens: 124_000, at: T } }]);
      await until(async () => (await textOf('.now-ctx > span')) === 'Context 124k tokens', 5_000, 'the tokens alone');
      expect(await page.locator('.now-ctx-bar').count()).toBe(0);
      // more than the window the table knows: the tokens alone, no share claimed
      await inject([{ id: 'ctx-1', state: 'idle', context: { tokens: 250_000, window: 200_000, at: T } }]);
      await until(async () => (await textOf('.now-ctx > span')) === 'Context 250k tokens', 5_000, 'no share past the window');
      expect(await page.getAttribute('.now-ctx', 'data-level')).toBe('ok');
      // the cost switch covers the transcripts' numbers: off, no meter and no last 5 hours
      await cfgPatch({ claude: { showCost: false } });
      await until(async () => (await page.locator('.now-ctx, .now-5h').count()) === 0, 5_000, 'no meter and no 5 h line with the cost off');
      await cfgPatch({ claude: { showCost: true } });
      await until(async () => (await page.locator('.now-ctx').count()) === 1 && (await page.locator('.now-5h').count()) === 1, 5_000, 'both back');
      await inject([{ id: 'ctx-1', state: 'idle' }]);
      await until(async () => (await page.locator('.now-ctx').count()) === 0, 5_000, 'nothing without numbers');

      // the work-time budget: the worked line's level, and one toast when it is passed
      await cfgPatch({ claude: { dailyWorkBudgetMin: 60 } });
      await inject([{ id: 'ctx-1', state: 'idle' }], { usd: 0, date: 'today', workMs: 50 * 60_000 });
      await until(async () => (await page.getAttribute('.now-worked', 'data-level')) === 'warn', 5_000, 'warn at 80 %');
      expect(await toastCount('daily limit')).toBe(0);
      await inject([{ id: 'ctx-1', state: 'idle' }], { usd: 0, date: 'today', workMs: 61 * 60_000 });
      await until(async () => (await page.getAttribute('.now-worked', 'data-level')) === 'danger', 5_000, 'danger past it');
      await until(async () => (await toastCount('You have passed your daily limit of 1 h with Claude today.')) === 1, 5_000, 'the toast');
      await inject([{ id: 'ctx-1', state: 'idle' }], { usd: 0, date: 'today', workMs: 70 * 60_000 });
      await sleep(300);
      expect(await toastCount('daily limit')).toBe(1); // once a day

      // the Today list: none before a turn, then the two finished turns (newest first), collapsed until asked
      expect(await page.locator('.now-tl').count()).toBe(0);
      const finish = async (ago: number, usd: number, at: number) => {
        await inject([{ id: 'tl-1', state: 'working', turnStartedAtAgo: ago, calls: [{ name: 'Read', category: 'read', startAgo: ago - 1000, endAgo: ago - 2000 }] }]);
        await inject([{ id: 'tl-1', state: 'idle', turnStartedAtAgo: ago, cost: { usd, at }, calls: [{ name: 'Read', category: 'read', startAgo: ago - 1000, endAgo: ago - 2000 }] }]);
      };
      await finish(72_000, 0.04, 21);
      await finish(30_000, 0.01, 22);
      await until(async () => (await textOf('.now-tl-toggle')) === 'Today (2)', 5_000, 'the Today list');
      expect(await page.getAttribute('.now-tl-toggle', 'aria-expanded')).toBe('false');
      expect(await page.locator('.now-tl-list').count()).toBe(0);
      await page.click('.now-tl-toggle');
      await until(async () => (await page.locator('.now-tl-list li').count()) === 2, 5_000, 'the entries');
      expect(await page.getAttribute('.now-tl-toggle', 'aria-expanded')).toBe('true');
      const entries = await page.$$eval('.now-tl-list li', (els) => els.map((e) => e.textContent));
      expect(entries[0]).toMatch(/^\d\d:\d\d · 30s · 1 read · ≈ \$0\.01$/);
      expect(entries[1]).toMatch(/^\d\d:\d\d · 1m 12s · 1 read · ≈ \$0\.04$/);
      expect(await page.$$eval('.now-tl-list li', (els) => els.map((e) => e.getAttribute('title')))).toEqual(entries); // (the whole line on hover, also when the panel cuts it)

      // project budgets: the cost by folder tints a folder at 80 % and past it, with "of $X"; one toast per folder and week when passed
      await cfgPatch({ claude: { projectBudgets: ['/work/budget-a=10', '/work/budget-b=10'] } });
      await page.click('.sp-convos .conv-refresh');
      if ((await page.getAttribute('.conv-cost-toggle', 'aria-expanded')) !== 'true') await page.click('.conv-cost-toggle');
      const costRow = (dir: string) => page.locator('.conv-cost-row', { hasText: dir });
      await until(async () => (await costRow('/work/budget-a').getAttribute('data-level')) === 'warn', 5_000, 'budget a at 90 %');
      expect(await costRow('/work/budget-a').textContent()).toContain('≈ $9.00 of $10.00');
      expect(await costRow('/work/budget-b').getAttribute('data-level')).toBe('ok');
      expect(await textOf('.conv-cost-note')).toMatch(/30 newest conversations/);
      expect(await toastCount('passed its weekly budget')).toBe(0);
      await cfgPatch({ claude: { projectBudgets: ['/work/budget-a=8', '/work/budget-b=10'] } });
      await until(async () => (await costRow('/work/budget-a').getAttribute('data-level')) === 'danger', 5_000, 'budget a passed');
      await until(async () => (await toastCount('/work/budget-a passed its weekly budget')) === 1, 5_000, 'the budget toast');
      await page.click('.sp-convos .conv-refresh');
      await sleep(400);
      expect(await toastCount('passed its weekly budget')).toBe(1); // once per folder and week
      await shot('19e-budgets');
      await page.click('.conv-cost-toggle');

      // the weekly digest (main sends it once a finished week): a toast with the notification's words and a button that opens the panel
      await cfgPatch({ panel: { open: false } });
      await page.waitForSelector('.side-panel', { state: 'detached' });
      await page.evaluate(() => (window as any).__event('app.digest', { text: 'Last week with Claude: ≈ $12.40, 12h 30m' }));
      const digest = page.locator('.toast', { hasText: 'Last week with Claude: ≈ $12.40, 12h 30m' });
      await digest.waitFor();
      await digest.locator('button', { hasText: 'Open panel' }).click();
      await page.waitForSelector('.side-panel');
      expect((await page.evaluate(() => window.jaffer.call('config.get'))).panel.open).toBe(true);
    } finally {
      await cfgPatch({ panel: { open: true } });
      await page.evaluate(() => { const w = window as any; w.jaffer.call = w.__ciReal; });
      await cfgPatch({ claude: { dailyWorkBudgetMin: 0, projectBudgets: [] } });
      await inject([]);
    }
  }, 60_000);

  it('Settings → Claude Code, 1.4.0: the daily work-time budget, project budgets (one per line) and the weekly summary write their keys', async () => {
    const field = (label: string) => page.locator('label.field', { hasText: label });
    const cfgNow = () => page.evaluate(() => window.jaffer.call('config.get'));
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    try {
      await page.locator('.settings-nav button', { hasText: 'Claude Code' }).click();
      const work = field('Daily work-time budget').locator('input[type=number]');
      await work.fill('90');
      await work.press('Tab');
      await until(async () => (await cfgNow()).claude.dailyWorkBudgetMin === 90, 8_000, 'the work budget');
      await work.fill('-4');
      await work.press('Tab');
      await until(async () => (await cfgNow()).claude.dailyWorkBudgetMin === 0, 8_000, 'a negative budget to be none');
      const lines = field('Project budgets').locator('textarea');
      await lines.fill('~/code/api=20\n\n  /work/web=7.5  \nnot a budget');
      await lines.press('Tab');
      await until(async () => JSON.stringify((await cfgNow()).claude.projectBudgets) === JSON.stringify(['~/code/api=20', '/work/web=7.5', 'not a budget']), 8_000, 'the budget lines');
      await field('Weekly summary').locator('.switch').click();
      await until(async () => (await cfgNow()).notifications.weeklyDigest === false, 8_000, 'the digest off');
      await field('Weekly summary').locator('.switch').click();
      await until(async () => (await cfgNow()).notifications.weeklyDigest === true, 8_000, 'the digest on');
      await lines.fill('');
      await lines.press('Tab');
      await until(async () => (await cfgNow()).claude.projectBudgets.length === 0, 8_000, 'no budgets again');
      expect(await field('Show what each answer cost').locator('small').textContent()).toMatch(/^Reads token counts from your conversation files to show cost, context and recent usage/);
      // an edit kept although Settings closes at once (Esc, no blur first)
      await lines.fill('/work/esc=3');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.settings', { state: 'detached' });
      await until(async () => JSON.stringify((await cfgNow()).claude.projectBudgets) === JSON.stringify(['/work/esc=3']), 8_000, 'the edit kept after Esc');
    } finally {
      if (await page.locator('.settings').count()) await page.keyboard.press('Escape');
      await page.waitForSelector('.settings', { state: 'detached' });
      await cfgPatch({ claude: { dailyWorkBudgetMin: 0, projectBudgets: [] }, notifications: { weeklyDigest: true } });
    }
  }, 40_000);

  it('the Setup section (1.4.0): collapsed at first; open, it lists the focused terminal folder\'s MCP servers (Check runs `claude mcp list` once), skills, rules and memory, plugins, subagents and hooks with a state each; more than 6 fold to a count; another terminal\'s folder refreshes it; nothing overflows at 220 px; nothing is typed', async () => {
    const claudeDir = path.join(env.userHome, '.claude');
    const projA = path.join(env.userHome, 'setup-a');
    const projB = path.join(env.userHome, 'setup-b');
    const put = (p: string, t: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, t));
    const planted = [projA, projB, path.join(claudeDir, 'skills'), path.join(claudeDir, 'plugins')];
    put(path.join(projA, '.mcp.json'), JSON.stringify({ mcpServers: { 'srv-file': { command: 'npx', args: ['--token', 'SECRET-ARG'] } } }));
    put(path.join(projA, '.claude/skills/skill-a/SKILL.md'), '---\nname: skill-a\ndescription: A project skill for the test\n---\n');
    for (let i = 1; i <= 7; i++) put(path.join(claudeDir, `skills/u${i}/SKILL.md`), `---\nname: user-skill-${i}\n---\n`);
    put(path.join(projA, 'CLAUDE.md'), 'Project memory for the test\n');
    put(path.join(projA, '.claude/rules/api.md'), '---\npaths:\n  - "src/**"\n---\nRules\n');
    put(path.join(projA, '.claude/settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo SECRET-HOOK' }, { type: 'command', command: 'true' }] }] } }));
    put(path.join(projA, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'plug-a@market': true } }));
    put(path.join(claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'plug-a@market': [{ version: '1.0.0' }], 'plug-b@market': [{ version: '2.0.0' }] } }));
    put(path.join(projA, '.claude/agents/rev.md'), '---\nname: reviewer-a\n---\n');
    put(path.join(projB, '.mcp.json'), JSON.stringify({ mcpServers: { 'srv-b': { command: 'x' } } }));
    fake.setMcpList('Checking MCP server health…\n\nsrv-file: npx -y thing --token SECRET-ARG - ✓ Connected\nuser-srv: https://example.com/SECRET-URL (HTTP) - ✗ Failed to connect\n');
    fake.setMode('mcp-slow');
    const mcpCalls = () => fake.calls().filter((l) => l.startsWith('mcp list')).length;
    const mcpBefore = mcpCalls();
    const chipName = (id: string) => page.locator(`.pane[data-pane="${id}"] .pn-chip .pn-name`).textContent();
    const ids = () => page.$$eval('.panes > .pane', (els) => els.map((e) => (e as HTMLElement).dataset.pane ?? ''));
    const group = (g: string) => page.locator(`.sx-group[data-group="${g}"]`);
    const items = (g: string) => group(g).locator('.sx-item').evaluateAll((els) => els.map((e) => ({ name: e.querySelector('.sx-name')!.textContent, state: (e.querySelector('.sx-dot') as HTMLElement).dataset.state, danger: (e.querySelector('.sx-dot') as HTMLElement).dataset.danger !== undefined, note: e.querySelector('.sx-note')?.textContent ?? null, tag: e.querySelector('.sx-tag')?.textContent ?? null })));
    const count = (g: string) => group(g).locator('.sx-count').textContent();
    const cd = (pane: string, dir: string) => page.evaluate(([p, d]) => window.jaffer.call('pty.write', { pane: p, data: `\x15cd '${d}'\r` }), [pane, dir]);
    const mainWas = (await page.evaluate(() => window.jaffer.call('pane.list')))[0].cwd as string;
    const panelWas = (await page.evaluate(() => window.jaffer.call('config.get'))).panel;
    await cfgPatch({ panel: { open: true, width: 220 } });
    await page.waitForSelector('.side-panel .sx-setup');
    try {
      // the third section, at the bottom, collapsed: nothing read yet
      expect(await page.$$eval('.side-panel > *', (els) => els.map((e) => e.className.split(' ')[0]).filter((c) => c !== 'wn-card'))).toEqual(['sp-handle', 'now-card', 'sp-convos', 'sx-setup']);
      expect(await page.getAttribute('.sx-setup .sx-head', 'aria-expanded')).toBe('false');
      expect(await page.locator('.sx-body').count()).toBe(0);
      // the main terminal in A, a second one in B (the person's own typing, before the window is watched)
      await cd('main', projA);
      await until(async () => (await chipName('main')) === 'setup-a', 8_000, 'main in setup-a');
      await menu('split-terminal');
      await until(async () => (await ids()).length === 2, 10_000, 'a second terminal');
      await until(async () => (await chipName('p2')) === 'setup-a', 8_000, 'p2 starting in setup-a');
      await cd('p2', projB);
      await until(async () => (await chipName('p2')) === 'setup-b', 8_000, 'p2 in setup-b');
      await menu('focus-terminal-1');
      await until(async () => (await page.evaluate(() => (window as any).__jaffer.activePane())) === 'main', 5_000, 'main focused');
      // from here on the window is watched: what it asks the daemon, and that it types nothing
      await page.evaluate(() => {
        const w = window as any;
        w.__sxCalls = [];
        w.__sxReal = w.jaffer.call;
        w.jaffer.call = (m: string, p: any) => (w.__sxCalls.push(m === 'pty.write' ? `pty.write ${JSON.stringify(p?.data)}` : m), m === 'claude.setup' && w.__sxFail ? Promise.reject(new Error('no')) : w.__sxReal(m, p));
      });
      // (the app's own connection says it is the app, and only it may run the check: the bridge's connection stands in for it)
      await page.evaluate(() => (window as any).__sxReal('hello', { client: 'app', protocol: 1 }));
      const calls = () => page.evaluate(() => (window as any).__sxCalls as string[]);

      await page.click('.sx-setup .sx-head');
      expect(await page.getAttribute('.sx-setup .sx-head', 'aria-expanded')).toBe('true');
      expect(await page.getAttribute('.sx-setup .sx-head', 'aria-controls')).toBe('sx-body');
      await page.waitForSelector('#sx-body[data-loaded] .sx-group[data-group="hooks"]');
      expect(await page.$$eval('.sx-group .sx-ghead span:first-child', (els) => els.map((e) => e.textContent))).toEqual(['MCP servers', 'Skills', 'Rules and memory', 'Plugins', 'Subagents', 'Hooks']);
      expect(await items('mcp')).toEqual([{ name: 'srv-file', state: 'unknown', danger: false, note: 'not checked', tag: null }]);
      expect(await page.textContent('.sx-hint')).toBe('This starts your MCP servers briefly to see if they answer.');
      // 8 skills: folded to the count, Show all opens them
      expect(await count('skills')).toBe('8');
      expect(await group('skills').locator('.sx-item').count()).toBe(0);
      await group('skills').locator('.sx-more').click();
      expect((await items('skills')).map((k) => k.name)).toEqual([...Array.from({ length: 7 }, (_, i) => `user-skill-${i + 1}`), 'skill-a']);
      expect(await group('skills').locator('.sx-item', { hasText: 'skill-a' }).getAttribute('title')).toBe('A project skill for the test · A skill of this project');
      const rules = await items('rules');
      expect(rules).toContainEqual({ name: '~/setup-a/CLAUDE.md', state: 'ok', danger: false, note: '28 B', tag: null });
      expect(rules).toContainEqual({ name: '~/setup-a/.claude/rules/api.md', state: 'ok', danger: false, note: expect.stringMatching(/ B$/), tag: 'scoped' });
      expect(await items('plugins')).toEqual([
        { name: 'plug-a@market', state: 'ok', danger: false, note: '1.0.0', tag: null },
        { name: 'plug-b@market', state: 'off', danger: false, note: 'off', tag: null },
      ]);
      expect((await items('agents')).map((a) => a.name)).toContain('reviewer-a');
      if (await group('hooks').locator('.sx-more', { hasText: 'Show all' }).count()) await group('hooks').locator('.sx-more').click(); // (Jaffer's own hooks are there too)
      expect(Number((await items('hooks')).find((h) => h.name === 'UserPromptSubmit')?.note)).toBeGreaterThanOrEqual(2); // (the project's two, and the user's)
      expect(mcpCalls()).toBe(mcpBefore); // (opening the section starts nothing)

      // Check: busy while it runs, then the states; servers only `claude mcp list` knows are added
      await page.click('.sx-check');
      await until(async () => (await page.getAttribute('.sx-check', 'aria-busy')) === 'true', 3_000, 'the busy button');
      expect(await page.textContent('.sx-check')).toBe('Checking…');
      await until(async () => (await page.textContent('.sx-check')) === 'Check MCP servers', 10_000, 'the check to end');
      expect(await items('mcp')).toEqual([
        { name: 'srv-file', state: 'ok', danger: false, note: 'Connected', tag: null },
        { name: 'user-srv', state: 'attention', danger: true, note: 'Failed to connect', tag: null },
      ]);
      expect(mcpCalls()).toBe(mcpBefore + 1);
      expect(fake.read('mcp.cwd')).toBe(projA);
      expect(await page.textContent('.sx-setup')).not.toMatch(/SECRET|npx|https/);
      await shot('17-setup');

      // nothing overflows sideways at 220 px
      const over = () => page.evaluate(() => {
        const p = document.querySelector('.side-panel')!.getBoundingClientRect();
        const b = document.querySelector('.sx-body') as HTMLElement;
        const out = [...document.querySelectorAll('.sx-setup *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > p.right + 0.5 || r.left < p.left - 0.5); }).map((e) => e.className);
        return { panel: Math.round(p.width), scroll: b.scrollWidth > b.clientWidth, out };
      });
      expect(await over()).toEqual({ panel: 220, scroll: false, out: [] });

      // the other terminal: its folder's list, the check's answer gone; back again: A's list, not checked any more
      await menu('focus-terminal-2');
      await until(async () => (await page.evaluate(() => (window as any).__jaffer.activePane())) === 'p2', 5_000, 'p2 focused');
      expect((await items('mcp')).map((m) => m.name)).not.toContain('srv-file'); // (A's list is gone at once)
      await until(async () => JSON.stringify(await items('mcp')) === JSON.stringify([{ name: 'srv-b', state: 'unknown', danger: false, note: 'not checked', tag: null }]), 8_000, "B's MCP servers");
      expect(await count('skills')).toBe('7');
      expect(await count('plugins')).toBe('2');
      await menu('focus-terminal-1');
      await until(async () => (await items('mcp')).map((m) => `${m.name} ${m.note}`).join() === 'srv-file not checked', 8_000, "A's MCP servers, not checked");
      expect(mcpCalls()).toBe(mcpBefore + 1);
      expect(await over()).toEqual({ panel: 220, scroll: false, out: [] });

      const seen = await calls();
      expect(seen.filter((m) => m.startsWith('pty.write'))).toEqual([]);
      expect(seen.filter((m) => m === 'claude.mcp')).toHaveLength(1);
      expect(seen.filter((m) => m === 'claude.setup').length).toBeGreaterThanOrEqual(3);
      expect(seen.some((m) => /config\.patch/.test(m))).toBe(false); // (read only: nothing changes a setting)

      // collapsed again, it is gone; a read that fails says so (not "Reading…" for ever)
      await page.click('.sx-setup .sx-head');
      expect(await page.locator('.sx-body').count()).toBe(0);
      await page.evaluate(() => ((window as any).__sxFail = true));
      await page.click('.sx-setup .sx-head');
      await until(async () => (await page.textContent('.sx-body')) === 'Could not read the setup of this folder.', 5_000, 'the failed read said');
      await page.evaluate(() => ((window as any).__sxFail = false));
      await page.click('.sx-setup .sx-head');
      expect(await page.locator('.sx-body').count()).toBe(0);
    } finally {
      await page.evaluate(() => {
        const w = window as any;
        if (w.__sxReal) w.jaffer.call = w.__sxReal;
        delete w.__sxReal;
      });
      if ((await page.getAttribute('.sx-setup .sx-head', 'aria-expanded').catch(() => null)) === 'true') await page.click('.sx-setup .sx-head');
      fake.setMode('ok');
      if ((await ids()).includes('p2')) {
        await menu('focus-terminal-2');
        await menu('close-terminal');
        await until(async () => (await ids()).length === 1, 10_000, 'one terminal again');
      }
      await cd('main', mainWas);
      await until(async () => (await page.evaluate(() => window.jaffer.call('pane.list')))[0].cwd === mainWas, 8_000, 'main back in its folder');
      await cfgPatch({ panel: panelWas });
      for (const p of planted) fs.rmSync(p, { recursive: true, force: true });
    }
  }, 90_000);

  it('Explain (1.4.0): with permissions.explain off there is no Explain button and claude.explain is never asked, and Ask Claude to explain only copies its prompt; on, after a finished turn the button asks the helper, the card shows its answer above Now and Dismiss takes it away; a failure is one calm line; nothing is typed', async () => {
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.term .xterm');
    await endClaude();
    fake.setMode('ok');
    const panelWas = (await page.evaluate(() => window.jaffer.call('config.get'))).panel;
    await cfgPatch({ panel: { open: true, width: 320 }, permissions: { explain: false } });
    const sid = '0000000e-aaaa-4bbb-8ccc-ddddeeee0007';
    const dir = path.join(env.userHome, '.claude', 'projects', '-explain');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix SECRET-PROMPT' } }), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I fixed **a.ts**; run the tests next.' }] } })].join('\n') + '\n');
    const helperRuns = () => fake.calls().filter((l) => l.startsWith('-p')).length;
    const runsBefore = helperRuns();
    await page.evaluate(() => {
      const w = window as any;
      w.__exCalls = [];
      w.__exReal = w.jaffer.call;
      w.jaffer.call = (m: string, p: any) => (w.__exCalls.push(m), m === 'claude.explain.supported' && w.__exUnsupported ? Promise.resolve({ supported: false }) : w.__exReal(m, p));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async (t: string) => void (w.__exClip = t) } });
    });
    const calls = () => page.evaluate(() => (window as any).__exCalls as string[]);
    try {
      // no Claude yet: neither button
      expect(await page.locator('.now-explain, .now-ask').count()).toBe(0);
      await sendHook('UserPromptSubmit', { session_id: sid, transcript_path: file, jaffer_pane: 'main', prompt: 'go' });
      await sendHook('Stop', { session_id: sid, transcript_path: file, jaffer_pane: 'main' });
      await page.waitForSelector('.now-card[data-state="idle"] .now-ask');
      // off: only Ask Claude to explain, which copies the prompt and says so
      expect(await page.locator('.now-explain').count()).toBe(0);
      expect(await page.textContent('.now-ask')).toBe('Ask Claude to explain');
      await page.click('.now-ask');
      await toastSaid('Copied. Paste it in the terminal.');
      expect(await page.evaluate(() => (window as any).__exClip)).toBe('Explain what you just did in this session in plain words, for someone new to this: what, why, and what I might do next.');
      expect(await page.locator('.ex-card').count()).toBe(0);

      // on: the button; a click asks the helper and the card shows its answer (as elements, never HTML) between What's New and Now
      await cfgPatch({ permissions: { explain: true } });
      await page.waitForSelector('.now-explain');
      expect(await page.textContent('.now-explain')).toBe('Explain the last answer');
      fake.setMode('explain-slow');
      fake.setExplainOut('It **fixed** a.ts.\n\n- Run `npm test` next\n<img src=x onerror=alert(1)>');
      await page.click('.now-explain');
      await page.waitForSelector('.ex-card[aria-busy="true"]');
      expect(await page.textContent('.ex-card')).toContain('Asking Claude…');
      await page.waitForSelector('.ex-card .ex-body', { timeout: 15_000 });
      expect(await page.locator('.side-panel > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]).filter((c) => c !== 'wn-card'))).toEqual(['sp-handle', 'ex-card', 'now-card', 'sp-convos', 'sx-setup']);
      expect(await page.textContent('.ex-body strong')).toBe('fixed');
      expect(await page.textContent('.ex-body code')).toBe('npm test');
      expect(await page.locator('.ex-body img').count()).toBe(0);
      expect(await page.textContent('.ex-body')).toContain('<img src=x onerror=alert(1)>');
      expect(await page.textContent('.ex-card')).toContain('Uses your Claude subscription');
      expect(await page.textContent('.ex-card')).toContain('Explained by a separate Claude run; check important details.');
      expect(helperRuns()).toBe(runsBefore + 1);
      expect(fake.read('explain.stdin')).toContain('I fixed **a.ts**; run the tests next.');
      expect(fake.read('explain.stdin')).not.toContain('SECRET');
      expect(fake.read('explain.argv').split('\n')).toEqual(['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text', '--permission-prompts', 'none', '--safe-mode']);
      expect(fake.read('explain.env')).toBe('|||||1'); // (the daemon here runs with an API key: never passed on)
      await shot('18-explain');
      await page.click('.ex-card .ex-dismiss');
      await until(async () => (await page.locator('.ex-card').count()) === 0, 3_000, 'the card to go');

      // Cancel while it waits: the card goes and the late answer is ignored
      await sleep(5_200); // (5 s between two of one session)
      await page.click('.now-explain');
      await page.waitForSelector('.ex-card[aria-busy="true"] .ex-cancel');
      await page.click('.ex-cancel');
      expect(await page.locator('.ex-card').count()).toBe(0);
      await until(async () => helperRuns() === runsBefore + 2, 5_000, 'the second run');
      await sleep(1_500);
      expect(await page.locator('.ex-card').count()).toBe(0);

      // a failure: one calm line, never what the helper printed
      await sleep(5_200);
      fake.setMode('explain-fail');
      await page.click('.now-explain');
      await until(async () => (await page.locator('.ex-card .ex-error').count()) > 0, 10_000, 'the calm line');
      expect(await page.textContent('.ex-error')).toBe('Claude could not explain it this time. Check that you are signed in, then try again.');
      expect(await page.textContent('.ex-card')).not.toContain('SECRET');
      await page.click('.ex-card .ex-dismiss');

      // off again: everything goes, and nothing was typed
      await cfgPatch({ permissions: { explain: false } });
      await until(async () => (await page.locator('.now-explain').count()) === 0, 3_000, 'the button to go');
      const asked = await calls();
      expect(asked.filter((m) => m === 'claude.explain')).toHaveLength(3);
      expect(asked).toContain('claude.explain.supported'); // (fix round: asked when the switch went on)
      expect(asked).not.toContain('pty.write');

      // (fix round) a Claude Code that cannot run the helper: no Explain button (Ask Claude to explain stays), and the Privacy hint says why
      await page.evaluate(() => void ((window as any).__exUnsupported = true));
      await cfgPatch({ permissions: { explain: true } });
      await until(async () => (await calls()).filter((m) => m === 'claude.explain.supported').length >= 2, 5_000, 'the probe');
      await sleep(300);
      expect(await page.locator('.now-explain').count()).toBe(0);
      expect(await page.locator('.now-ask').count()).toBe(1);
      await page.keyboard.press('Meta+,');
      await page.waitForSelector('.settings');
      await page.click('.settings-nav button:has-text("Privacy and permissions")');
      expect(await page.locator('.settings .pv-list .field small').first().textContent()).toContain('Your Claude Code cannot run a helper without tools and without saving it: update Claude Code to use this.');
      await page.keyboard.press('Escape');
      await until(async () => (await page.locator('.settings').count()) === 0, 3_000, 'Settings to close');
      await cfgPatch({ permissions: { explain: false } });
    } finally {
      fake.setMode('ok');
      fs.rmSync(path.join(fake.dir, 'explain-out'), { force: true });
      await page.evaluate(() => {
        const w = window as any;
        if (w.__exReal) w.jaffer.call = w.__exReal;
        delete w.__exReal;
        delete w.__exUnsupported;
      });
      await cfgPatch({ panel: panelWas, permissions: { explain: false } });
      await sendHook('SessionEnd', { session_id: sid });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('seasonal touches: the mole and the scenes dress by data-season (a fake season only with ?debug), off with the setting, none outside the dates', async () => {
    const page_ = (q: string) => page.goto(`${url}?${q}&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`).then(() => page.waitForSelector('.term .xterm'));
    try {
      await page_('debug=1&season=winter');
      await page.waitForSelector('.pet[data-season="winter"]');
      expect(await page.locator('.pet[data-role="main"] .pet-season[data-season="winter"]').count()).toBe(1);
      expect(await page.locator('.pet-helper[data-season]').count()).toBe(0);
      expect(await page.$eval('.pet-season .ps-c', (el) => getComputedStyle(el).fill)).toBe('rgb(244, 241, 234)'); // (the brim is snow-white whatever the theme's text colour)
      await shot('19d-season-winter');
      await page_('debug=1&season=halloween');
      await page.waitForSelector('.pet[data-season="halloween"] .pet-season[data-season="halloween"]');
      await page_('debug=1&season=valentine');
      await page.waitForSelector('.pet[data-season="valentine"] .pet-season[data-season="valentine"]');
      // the scenes: the attribute and a few dots, drifting only with motion on
      await cfgPatch({ appearance: { companion: 'matrix' } });
      await page.waitForSelector('.scene[data-season="valentine"] .sc-flake');
      expect(await page.locator('.scene .sc-flake').count()).toBe(9);
      const anim = () => page.$eval('.scene .sc-flake', (el) => getComputedStyle(el).animationName);
      expect(await anim()).toBe('sc-rise');
      await cfgPatch({ appearance: { animations: false } });
      await until(async () => (await anim()) === 'none', 5_000, 'the dots to stand still with Animations off');
      await cfgPatch({ appearance: { animations: true } });
      // the setting off: no attribute, no accessory, no dots
      await cfgPatch({ appearance: { seasonal: false } });
      await until(async () => (await page.locator('.scene[data-season], .sc-flake').count()) === 0, 5_000, 'no season with the setting off');
      await cfgPatch({ appearance: { companion: 'mole' } });
      await page.waitForSelector('.pet[data-role="main"]');
      expect(await page.locator('.pet[data-season], .pet-season').count()).toBe(0);
      await cfgPatch({ appearance: { seasonal: true } });
      await page.waitForSelector('.pet[data-season="valentine"]');
      // `season=none`: nothing, whatever the date is
      await page_('debug=1&season=none');
      await page.waitForSelector('.pet[data-role="main"]');
      expect(await page.locator('.pet[data-season]').count()).toBe(0);
      // without ?debug the query is ignored: the date decides
      const fake = (['halloween', 'winter', 'valentine'] as const).find((x) => x !== seasonOf(new Date()))!;
      await page_(`season=${fake}`);
      await page.waitForSelector('.pet[data-role="main"]');
      expect(await page.getAttribute('.pet[data-role="main"]', 'data-season')).toBe(seasonOf(new Date()));
    } finally {
      await cfgPatch({ appearance: { companion: 'mole', seasonal: true, animations: true } });
      await page_('debug=1');
    }
  }, 60_000);

  it("What's New: after an update the card shows the notes not seen yet at the top of the side panel and a toast opens it; Dismiss keeps updates.seenVersion; All versions lists the history; the menu id opens it any time; never HTML", async () => {
    const version: string = await page.evaluate(() => window.jaffer.appInfo().then((a: { version: string }) => a.version));
    const cfgOf = () => page.evaluate(() => window.jaffer.call('config.get'));
    const reload = async () => {
      await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
      await page.waitForSelector('.term .xterm');
    };
    const frames = (n: number) => page.evaluate((k) => new Promise<void>((r) => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const firstText = (md: string) => {
      const b = parseMd(md).find((x) => x.kind !== 'ul')!;
      return (b as { inline: { text: string }[] }).inline.map((i) => i.text).join('').slice(0, 30);
    };
    // the first start wrote the running version when the person pressed Get started: no card, no toast
    expect((await cfgOf()).updates.seenVersion).toBe(version);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.side-panel');
    expect(await page.locator('.wn-card').count()).toBe(0);

    // (whatever happens below, the seen version and the panel are as they were for the tests after this one)
    const panelWas = (await cfgOf()).panel.open;
    try {
      // an update: the notes after 1.0.0 are unseen (the newest ones up to this version, at most five)
      const unseen = unseenNotes(RELEASE_NOTES, '1.0.0', version);
      expect(unseen.length).toBeGreaterThan(0);
      await cfgPatch({ updates: { seenVersion: '1.0.0' }, panel: { open: false } });
      await page.waitForSelector('.side-panel', { state: 'detached' });
      await reload();
      // the toast says so, and its button opens the panel with the card
      await toastSaid(`Jaffer updated to ${version}`);
      expect(await page.locator('.side-panel').count()).toBe(0);
      await page.locator('.toast', { hasText: `Jaffer updated to ${version}` }).locator('.toast-act', { hasText: "What's new" }).click();
      await page.waitForSelector('.side-panel > .wn-card');
      expect(await page.$$eval('.side-panel > *', (els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sp-handle', 'wn-card', 'now-card', 'sp-convos', 'sx-setup']); // the card is the one new child, above Now (1.4.0: Setup, the third section, at the bottom)
      expect(await page.locator('.sp-convos, .now-card').count()).toBe(2);
      const text = (await page.textContent('.wn-card')) ?? '';
      expect(text).toContain(`What's new in ${unseen[0]!.version}`);
      for (const n of unseen) expect(text.replace(/\s+/g, ' ')).toContain(firstText(n.md));
      expect(text).not.toMatch(/\*\*|`/); // (marks are rendered, never shown)
      expect(text).not.toContain('Updating from 0.2.x'); // the standard last line is not in the notes
      expect(await page.locator('.wn-card details').count()).toBe(0);
      expect(await page.locator('.wn-card button', { hasText: 'Dismiss' }).count()).toBe(1);
      await shot('02e-whats-new');

      // All versions: every bundled version, the newest open
      await page.click('.wn-card button:has-text("All versions")');
      await page.waitForSelector('.wn-card details');
      expect(await page.locator('.wn-card details').count()).toBe(RELEASE_NOTES.length);
      expect(await page.$$eval('.wn-card details', (els) => els.map((e) => (e as HTMLDetailsElement).open))).toEqual(RELEASE_NOTES.map((_, i) => i === 0));
      expect(await page.textContent('.wn-card .wn-title')).toBe('All versions');
      expect(await page.locator('.wn-card button', { hasText: 'All versions' }).count()).toBe(0);

      // the panel already open after an update: the card is there, so no toast
      await reload();
      await page.waitForSelector('.side-panel > .wn-card');
      await frames(2); // (the toast is set before the first render, so it would be in this one)
      expect(await page.locator('.toast-text', { hasText: 'Jaffer updated' }).count()).toBe(0);

      // Dismiss: the card goes, this version counts as seen, and a reload shows neither card nor toast
      await page.click('.wn-card button:has-text("Dismiss")');
      await page.waitForSelector('.wn-card', { state: 'detached' });
      await until(async () => (await cfgOf()).updates.seenVersion === version, 5_000, 'updates.seenVersion written');
      expect(await page.locator('.side-panel').count()).toBe(1);
      await cfgPatch({ panel: { open: true } });
      await reload();
      await page.waitForSelector('.side-panel');
      await frames(2);
      expect(await page.locator('.wn-card').count()).toBe(0);
      expect(await page.locator('.toast-text', { hasText: 'Jaffer updated' }).count()).toBe(0);

      // Help → What's New… (the menu id) opens it any time, even with the panel closed: the history, and Close leaves the seen version alone
      await cfgPatch({ panel: { open: false } });
      await page.waitForSelector('.side-panel', { state: 'detached' });
      await menu('whats-new');
      await page.waitForSelector('.side-panel > .wn-card');
      expect(await page.textContent('.wn-card .wn-title')).toBe('All versions');
      await page.click('.wn-card button:has-text("Close")');
      await page.waitForSelector('.wn-card', { state: 'detached' });
      expect((await cfgOf()).updates.seenVersion).toBe(version);
      expect(await page.locator('.side-panel').count()).toBe(1);
      await page.click('.term');
    } finally {
      await cfgPatch({ updates: { seenVersion: version }, panel: { open: panelWas } });
    }
  }, 60_000);

  it('the layout lines up at any window size: the pill is centred in the title bar and on the window, the card has even margins, the mole sits inside, nothing overflows', async () => {
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const cy = (b: { y: number; height: number }) => b.y + b.height / 2;
    const cx = (b: { x: number; width: number }) => b.x + b.width / 2;
    const measure = async (w: number, h: number) => {
      const bar = await box('.titlebar');
      const pill = await box('.session-pill');
      const card = await box('.terminal-area');
      const pet = await box('.pet-corner');
      const panel = open ? await box('.side-panel') : null;
      const where = `${w}x${h}${open ? '' : ' (panel closed)'}`;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5), `no sideways scroll at ${where}`).toBe(true);
      expect(Math.abs(cy(pill) - cy(bar)), `pill centred in the title bar at ${where}`).toBeLessThan(1.5);
      expect(Math.abs(cx(pill) - w / 2), `pill centred on the window at ${where}`).toBeLessThan(2);
      const left = card.x;
      const bottom = h - (card.y + card.height);
      expect(Math.abs(left - bottom), `card margins even (left ${left}, bottom ${bottom}) at ${where}`).toBeLessThan(1.5);
      expect(pet.x + pet.width, `mole inside the card at ${where}`).toBeLessThanOrEqual(card.x + card.width);
      expect(pet.y + pet.height, `mole inside the card at ${where}`).toBeLessThanOrEqual(card.y + card.height);
      // 1.1.0: open, the side panel is the card's right neighbour: the same gap between them, the same top and bottom, the margin on its right
      const right = panel ?? card;
      expect(Math.abs(w - (right.x + right.width) - left), `right margin equals the left one at ${where}`).toBeLessThan(1.5);
      if (panel) {
        expect(Math.abs(panel.x - (card.x + card.width) - left), `the gap between the card and the panel at ${where}`).toBeLessThan(1.5);
        expect(Math.abs(panel.y - card.y) + Math.abs(panel.height - card.height), `panel and card level at ${where}`).toBeLessThan(1.5);
      }
    };
    let open = true;
    for (const [w, h] of [[1360, 860], [900, 640], [660, 520]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(200);
      await measure(w, h);
      if (w < 1000) await shot(`15-layout-${w}`);
    }
    await page.setViewportSize({ width: 1360, height: 860 });
    await menu('toggle-panel');
    await page.waitForSelector('.side-panel', { state: 'detached' });
    open = false;
    await sleep(200);
    await measure(1360, 860);
    await menu('toggle-panel');
    await page.waitForSelector('.side-panel');
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

  it('a terminal host that comes back with fewer terminals: only the terminals it has attach again (a gone one never asks, no "No such pane")', async () => {
    const panesNow = () => page.$$eval('.panes > .pane', (els) => els.map((e) => (e as HTMLElement).dataset.pane ?? ''));
    try {
      await menu('split-terminal');
      await until(async () => (await panesNow()).length === 2, 10_000, 'two terminals');
      await sleep(600);
      // the host came back with only its first terminal: its list answers a little later, and every attach is recorded
      await page.evaluate(() => {
        const w = window as any;
        w.__upReal = w.jaffer.call;
        w.__upAttach = [];
        w.jaffer.call = (m: string, p: any) =>
          m === 'pane.list' ? new Promise((r) => setTimeout(() => r([{ id: 'main' }]), 300)) : (m === 'session.attach' && w.__upAttach.push(p?.pane), w.__upReal(m, p));
      });
      await page.evaluate(() => (window as any).__event('daemon.up', {}));
      await until(async () => JSON.stringify(await panesNow()) === JSON.stringify(['main']), 5_000, 'only the first terminal left');
      await sleep(500);
      expect(await page.evaluate(() => (window as any).__upAttach)).toEqual(['main']);
      expect(await page.textContent('.panes')).not.toContain('No such pane');
    } finally {
      await page.evaluate(() => { const w = window as any; if (w.__upReal) w.jaffer.call = w.__upReal; delete w.__upReal; });
      for (const p of (await page.evaluate(() => window.jaffer.call('pane.list'))) as { id: string }[]) if (p.id !== 'main') await page.evaluate((id) => window.jaffer.call('pane.close', { pane: id }), p.id);
    }
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
    await until(async () => !(await page.evaluate(() => document.documentElement.classList.contains('theme-fade'))), 15_000, 'the fade to end');
    await page.emulateMedia({ colorScheme: 'dark' });
    await until(async () => (await rootVar('--bg-solid')) === themeBg('jaffer-dark'), 5_000, 'the dark theme in dark mode');
    // the terminal's own colours follow (they switch at once)
    expect(await page.evaluate(() => String((window as any).__jaffer.terminals.get('main').term.options.theme.background))).toContain('18,21,27');
    // the light theme is a choice, and Animations off swaps without a fade
    await until(async () => !(await page.evaluate(() => document.documentElement.classList.contains('theme-fade'))), 15_000, 'the last fade to end');
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

  // ---- 1.4.0 Learn: the glossary, the ⓘ buttons, the tour and first-time tips
  const keysInTerminal = () => until(async () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')), 3_000, 'the terminal to have the keys again');
  const onDisk = () => JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
  const fresh = async () => {
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.term .xterm');
  };
  const inView = (sel: string) =>
    page.$eval(sel, (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
    });

  it('the glossary (1.4.0): the palette and the Help menu open it, the search filters, a click shows more, an ⓘ\'s More opens it at that entry; Esc closes it and the terminal has the keys again', async () => {
    await fresh();
    await page.click('.term');
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('glossary');
    await until(async () => (await page.locator('.pal-row.sel .pal-title').textContent()) === 'Glossary', 3_000, 'the Glossary action');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.lr-glossary');
    expect(await page.evaluate(() => document.activeElement?.matches('.lr-glossary input'))).toBe(true);
    expect(await page.textContent('.modal-head h3')).toBe('Glossary');
    expect(await page.locator('.lr-entry').count()).toBe(GLOSSARY.length);
    expect(await page.locator('.lr-more').count()).toBe(0);
    await sleep(300); // (the dialog's entrance has settled)
    await shot('40a-glossary');
    await page.keyboard.type('compact');
    await until(async () => (await page.locator('.lr-entry').count()) < GLOSSARY.length, 3_000, 'the search');
    const ids = await page.$$eval('.lr-entry', (els) => els.map((e) => (e as HTMLElement).dataset.id));
    expect(ids).toEqual(searchGlossary('compact').map((e) => e.id));
    expect(ids).toContain('compaction');
    await page.click('.lr-entry[data-id="compaction"] .lr-term');
    await until(async () => (await page.textContent('.lr-entry[data-id="compaction"] .lr-more')) === glossaryEntry('compaction')!.more, 3_000, 'more of it');
    expect(await page.getAttribute('.lr-entry[data-id="compaction"] .lr-term', 'aria-expanded')).toBe('true');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.lr-glossary', { state: 'detached' });
    await keysInTerminal();
    // the Help menu's Glossary…
    await menu('glossary');
    await page.waitForSelector('.lr-glossary');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.lr-glossary', { state: 'detached' });
    // a deep link: Settings → Companion size's ⓘ → More in the glossary: that entry is open, in view and has the keyboard
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings .field', { hasText: 'Companion size' }).locator('.lr-info').click();
    await page.waitForSelector('.lr-pop[data-id="companion"]');
    await page.click('.lr-pop .lr-more-link');
    await page.waitForSelector('.lr-glossary .lr-entry[data-id="companion"][data-open]');
    expect(await page.locator('.settings').count()).toBe(0);
    expect(await page.textContent('.lr-entry[data-id="companion"] .lr-more')).toBe(glossaryEntry('companion')!.more);
    await until(async () => (await page.evaluate(() => document.activeElement?.closest('.lr-entry')?.getAttribute('data-id'))) === 'companion', 3_000, 'the entry to have the keyboard');
    const box = await page.evaluate(() => {
      const r = document.querySelector('.lr-entry[data-id="companion"] .lr-term')!.getBoundingClientRect();
      const l = document.querySelector('.lr-list')!.getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
    });
    expect(box).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.lr-glossary', { state: 'detached' });
    await keysInTerminal();
  }, 40_000);

  it('the ⓘ buttons (1.4.0): beside the Now card\'s words, the panel\'s sections, the Setup groups and three Settings fields, each opens a popover with its own entry (Enter and Space too); Esc and a click outside close it; none in the title bar', async () => {
    await fresh();
    await endClaude();
    await cfgPatch({ panel: { open: true } });
    const push = (d: object) => page.evaluate((x) => (window as any).__event('claude.approvals', x), d);
    try {
      const T = Date.now();
      for (const [ago, at] of [[72_000, 1], [30_000, 2]] as const) {
        await inject([{ id: 'lr-1', state: 'working', turnStartedAtAgo: ago }]);
        await inject([{ id: 'lr-1', state: 'idle', turnStartedAtAgo: ago, cost: { usd: 0.02, at } }]);
      }
      await inject([{ id: 'lr-1', state: 'idle', cost: { usd: 0.02, at: 2 }, context: { tokens: 300_000, window: 1_000_000, at: T } }], { usd: 1, date: 'today', workMs: 600_000 });
      await push({ items: [{ id: 'lr-ap', sessionId: 'lr-1', tool: 'Bash', detail: 'npm test', allowable: true, expiresAt: Date.now() + 20_000 }] });
      await page.waitForSelector('.now-turns');
      await page.waitForSelector('.now-card .ap-ask');
      await page.click('.sx-head');
      await page.waitForSelector('.sx-body[data-loaded]');
      expect(await page.locator('.titlebar .lr-info').count()).toBe(0); // (no ⓘ in the title bar, not even in its approval chip: the cost card says where to look)
      const want: [string, string][] = [
        ['.now-head', 'session'],
        ['.now-cost', 'cost-estimate'],
        ['.now-ctx', 'context-window'],
        ['.now-worked', 'turn'],
        ['.lr-line', 'turn'],
        ['.ap-ask', 'permission-prompt'],
        ['.conv-head', 'transcript'],
        ['.sx-group[data-group="mcp"]', 'mcp'],
        ['.sx-group[data-group="skills"]', 'skill'],
        ['.sx-group[data-group="rules"]', 'rules'],
        ['.sx-group[data-group="plugins"]', 'plugin'],
        ['.sx-group[data-group="agents"]', 'subagent'],
        ['.sx-group[data-group="hooks"]', 'hook'],
      ];
      for (const [where, id] of want) {
        const b = page.locator(`.side-panel ${where} .lr-info`).first();
        expect(await b.getAttribute('data-id'), where).toBe(id);
        expect(await b.getAttribute('aria-label'), where).toBe(`What is ${glossaryEntry(id)!.title}?`);
        expect(await b.getAttribute('aria-expanded'), where).toBe('false');
        await b.scrollIntoViewIfNeeded();
        await b.click();
        await page.waitForSelector(`.lr-pop[data-id="${id}"]`);
        expect(await page.textContent('.lr-pop p'), where).toBe(glossaryEntry(id)!.short);
        expect(await page.getAttribute('.lr-pop', 'role')).toBe('dialog');
        expect(await b.getAttribute('aria-expanded'), where).toBe('true');
        expect(await inView('.lr-pop'), `${where}: the popover on screen`).toBe(true);
        expect(await page.locator('.lr-pop').count()).toBe(1);
        if (id === 'session') await shot('40b-info-popover');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.lr-pop', { state: 'detached' });
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id), `${where}: the keyboard back on the button`).toBe(id);
      }
      // the words beside them are as they were (the ⓘ adds no text)
      expect(await textOf('.now-worked')).toBe('Claude worked 10m 0s today');
      expect(await textOf('.now-ctx > span')).toBe('Context 30% of 1M');
      // the keyboard: Enter and Space open it; a click outside closes it
      const ctx = page.locator('.now-ctx .lr-info');
      await ctx.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.lr-pop[data-id="context-window"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.lr-pop', { state: 'detached' });
      await page.keyboard.press('Space');
      await page.waitForSelector('.lr-pop[data-id="context-window"]');
      await page.mouse.click(200, 400); // (the terminal)
      await page.waitForSelector('.lr-pop', { state: 'detached' });
      // and three fields of Settings: Esc closes the popover, not Settings
      await page.keyboard.press('Meta+,');
      await page.waitForSelector('.settings');
      await page.click('.settings-nav button:has-text("Privacy and permissions")');
      expect(await page.$$eval('.settings .pv-list .lr-info', (els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual(['transcript', 'permission-prompt']);
      // a field with an ⓘ keeps its label (the ⓘ sits outside it): the switch is named by its words, and a click on them toggles it
      const deep = page.getByRole('checkbox', { name: 'Search the text of past conversations', exact: true });
      const asks = page.getByRole('checkbox', { name: 'Answer permission prompts from the notification', exact: true });
      expect([await deep.count(), await asks.count()]).toEqual([1, 1]);
      expect(await page.locator('.settings label.field:has(button), .settings label:has(.lr-info)').count()).toBe(0);
      const before = (await page.evaluate(() => window.jaffer.call('config.get'))).permissions.deepSearch;
      await page.locator('.settings .pv-list label', { hasText: 'Search the text of past conversations' }).click();
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).permissions.deepSearch === !before, 5_000, 'a click on the words to toggle the switch');
      await page.locator('.settings .pv-list label', { hasText: 'Search the text of past conversations' }).click();
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).permissions.deepSearch === before, 5_000, 'and back');
      await page.click('.settings .pv-list .lr-info[data-id="permission-prompt"]');
      await page.waitForSelector('.lr-pop[data-id="permission-prompt"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.lr-pop', { state: 'detached' });
      expect(await page.locator('.settings').count()).toBe(1);
      await page.click('.settings-nav button:has-text("Appearance")');
      expect(await page.getByRole('combobox', { name: 'Companion size', exact: true }).count()).toBe(1);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.settings', { state: 'detached' });
    } finally {
      await push({ items: [] });
      await inject([]);
    }
  }, 60_000);

  it('the tour (1.4.0): Take the tour runs all eight steps over real elements (Next, Back, → and ←, a spotlight on screen), Try it opens the palette (the tour comes back after Esc) and splits a terminal, Settings shows on Privacy; Done, Skip and Esc end it with tour.done; it types nothing and closes what it opened', async () => {
    await fresh();
    await endClaude();
    await cfgPatch({ panel: { open: false }, tour: { done: false } });
    await page.waitForSelector('.side-panel', { state: 'detached' });
    const mainText = await termText();
    const at = (id: string) => page.waitForSelector(`.lr-tour[data-step="${id}"][data-found]`);
    /** The spotlight: on screen, not empty, and over its element. */
    const spot = async (target: string) => {
      // (settled: the panel slides in and a dialog pops up, and the spotlight follows them)
      await until(
        async () => {
          const h = await page.locator('.lr-hole').boundingBox();
          const t = await page.locator(`[data-tour="${target}"]`).boundingBox();
          const vp = page.viewportSize()!;
          if (!h || !t || h.width <= 10 || h.height <= 10) return false;
          if (!(h.x >= 0 && h.y >= 0 && h.x + h.width <= vp.width + 0.5 && h.y + h.height <= vp.height + 0.5)) return false; // on screen
          return Math.abs(h.x - Math.max(0, t.x - 6)) <= 1 && Math.abs(h.y - Math.max(0, t.y - 6)) <= 1; // over its element
        },
        5_000,
        `the spotlight on ${target}`,
      );
      expect(await inView('.lr-card'), `${target}: the card on screen`).toBe(true);
      await until(() => page.evaluate(() => !!document.activeElement?.closest('.lr-card')), 3_000, `${target}: the keyboard in the card`);
    };
    try {
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.palette input');
      await page.keyboard.type('take the tour');
      await until(async () => (await page.locator('.pal-row.sel .pal-title').textContent()) === 'Take the tour', 3_000, 'the tour action');
      await page.keyboard.press('Enter');
      await at('terminal');
      await spot('panes');
      expect(await page.textContent('.lr-card h3')).toBe(TOUR_STEPS[0]!.title);
      expect(await page.getAttribute('.lr-dots', 'aria-label')).toBe('Step 1 of 8');
      expect(await page.locator('.lr-back').isDisabled()).toBe(true);
      await shot('41a-tour');
      await page.keyboard.press('ArrowRight');
      await at('now');
      await page.waitForSelector('.side-panel'); // (the panel, opened to show it)
      await spot('now');
      await page.click('.lr-back');
      await at('terminal');
      await page.keyboard.press('ArrowRight');
      await at('now');
      await page.keyboard.press('ArrowLeft');
      await at('terminal');
      await page.keyboard.press('ArrowRight');
      await at('now');
      await page.click('.lr-next');
      await at('conversations');
      await spot('conversations');
      await page.click('.lr-next');
      await at('palette');
      await spot('titlebar');
      // Try it: the palette, and the tour waits; Esc closes the palette and the tour is back where it was
      await page.click('.lr-try');
      await page.waitForSelector('.palette input');
      expect(await page.locator('.lr-tour').count()).toBe(0);
      await page.keyboard.press('Escape');
      await at('palette');
      await page.click('.lr-next');
      await at('split');
      expect(await page.textContent('.lr-try')).toBe('Try it');
      await page.click('.lr-try');
      await until(async () => (await page.locator('.panes > .pane').count()) === 2, 10_000, 'a second terminal');
      await until(async () => page.evaluate(() => !!document.activeElement?.closest('.lr-card')), 3_000, 'the keyboard back in the card');
      await at('split');
      await spot('panes');
      await page.keyboard.press('Enter');
      await at('setup');
      await page.waitForSelector('.sx-body'); // (expanded to show it)
      await spot('setup');
      await page.click('.lr-next');
      await at('privacy');
      await page.waitForSelector('.settings');
      await spot('settings-privacy');
      expect(await page.locator('.settings-nav button.on').textContent()).toBe('Privacy and permissions');
      expect(await page.locator('.lr-lines li').count()).toBe(5);
      expect(await page.textContent('.lr-try')).toBe('Open Settings');
      await shot('41b-tour-privacy');
      await page.click('.lr-next');
      await at('learn');
      expect(await page.locator('.settings').count()).toBe(0);
      await spot('now-info');
      expect(await page.textContent('.lr-next')).toBe('Done');
      await page.click('.lr-next');
      await page.waitForSelector('.lr-tour', { state: 'detached' });
      await until(async () => onDisk().tour?.done === true, 5_000, 'tour.done on disk');
      await page.waitForSelector('.side-panel', { state: 'detached' }); // (what it opened is closed again)
      await keysInTerminal();
      expect(onDisk().panel.open).toBe(false);
      // Settings → Help → Start the tour; Esc skips it
      await cfgPatch({ tour: { done: false } });
      await page.keyboard.press('Meta+,');
      await page.waitForSelector('.settings');
      await page.click('.settings-nav button:has-text("Help")');
      await page.click('.settings .lr-start');
      await at('terminal');
      expect(await page.locator('.settings').count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.lr-tour', { state: 'detached' });
      await until(async () => onDisk().tour?.done === true, 5_000, 'tour.done after Esc');
      // the Help menu's Take the Tour; Skip tour ends it
      await cfgPatch({ tour: { done: false } });
      await menu('start-tour');
      await at('terminal');
      await page.click('.lr-skip');
      await page.waitForSelector('.lr-tour', { state: 'detached' });
      await until(async () => onDisk().tour?.done === true, 5_000, 'tour.done after Skip');
      expect(await termText()).toBe(mainText); // nothing was typed
    } finally {
      const extra = await page.evaluate(() => window.jaffer.call('pane.list')) as { id: string }[];
      for (const p of extra) if (p.id !== 'main') await page.evaluate((id) => window.jaffer.call('pane.close', { pane: id }), p.id);
      await until(async () => (await page.locator('.panes > .pane').count()) === 1, 10_000, 'one terminal again');
      await cfgPatch({ panel: { open: true }, tour: { done: true } });
    }
  }, 90_000);

  it('first run ends with one offer of the tour (1.4.0): "Take a 1-minute tour?" with Start; none once the tour is done', async () => {
    const onboard = async () => {
      await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
      await page.waitForSelector('.onboard[data-step="choices"]', { timeout: 20_000 });
      await page.locator('.onboard .choices label', { hasText: 'Start Claude Code in the terminal now' }).locator('.switch').click(); // (nothing typed)
      await page.click('.onboard .btn.primary');
      await page.waitForSelector('.onboard[data-step="privacy"]');
      await page.click('.onboard .btn.primary');
      await page.waitForSelector('.onboard', { state: 'detached' });
      await page.waitForSelector('.term .xterm');
    };
    const offers = () => page.locator('.toast', { hasText: 'Take a 1-minute tour?' }).count();
    try {
      await cfgPatch({ onboarded: false, tour: { done: false } });
      await onboard();
      await until(async () => (await offers()) === 1, 5_000, 'the offer');
      await sleep(500);
      expect(await offers()).toBe(1); // once
      await page.locator('.toast', { hasText: 'Take a 1-minute tour?' }).locator('.toast-act', { hasText: 'Start' }).click();
      await page.waitForSelector('.lr-tour[data-step="terminal"]');
      expect(await offers()).toBe(0); // (the offer goes with its answer)
      await page.keyboard.press('Escape');
      await page.waitForSelector('.lr-tour', { state: 'detached' });
      await until(async () => onDisk().tour?.done === true, 5_000, 'tour.done');
      // the tour done: first run again makes no offer
      await cfgPatch({ onboarded: false });
      await onboard();
      await sleep(800);
      expect(await offers()).toBe(0);
    } finally {
      await cfgPatch({ onboarded: true, tour: { done: true } });
    }
  }, 60_000);

  it('first-time tips (1.4.0): the first compaction raises one "What is compaction?" toast (Explain opens the glossary there), a second none, tips.seen keeps it on disk; another tip within 90 s waits, and none while the window is away; Don\'t show tips stops them; Settings → Help switches them and Show tips again clears what was seen', async () => {
    await fresh();
    await endClaude();
    const tips = (q: string) => page.locator('.toast', { hasText: q }).count();
    try {
      await cfgPatch({ tips: { enabled: true, seen: [] } });
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).tips.enabled === true, 3_000, 'tips on');
      await sendHook('SessionStart', { session_id: 'tip-1' });
      await sleep(300);
      await sendHook('PreCompact', { session_id: 'tip-1' });
      await until(async () => (await tips('What is compaction?')) === 1, 5_000, 'the compaction tip');
      const toastOf = page.locator('.toast', { hasText: 'What is compaction?' });
      expect(await toastOf.locator('.toast-act').allTextContents()).toEqual(['Explain', "Don't show tips"]);
      expect(await page.locator('.toast-text', { hasText: 'Claude is compacting its context' }).count()).toBe(1); // (the compaction's own toast, as before)
      await until(async () => onDisk().tips.seen.includes('compaction'), 5_000, 'tips.seen on disk');
      await shot('42-tip');
      await toastOf.locator('.toast-act', { hasText: 'Explain' }).click();
      await page.waitForSelector('.lr-glossary .lr-entry[data-id="compaction"][data-open]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.lr-glossary', { state: 'detached' });
      await toastOf.locator('button[aria-label="Dismiss"]').click();
      // the same again: none
      await sendHook('UserPromptSubmit', { session_id: 'tip-1' });
      await sleep(300);
      await sendHook('PreCompact', { session_id: 'tip-1' });
      await until(async () => (await page.locator('.toast-text', { hasText: 'Claude is compacting its context' }).count()) >= 1, 5_000, 'the compaction again');
      await sleep(400);
      expect(await tips('What is compaction?')).toBe(0);
      // another tip within 90 s: not now, and not counted as seen
      await sendHook('SessionEnd', { session_id: 'tip-1' });
      await sleep(500);
      await inject([{ id: 'tip-2', state: 'idle' }]);
      await inject([{ id: 'tip-2', state: 'needs-you', tool: { name: 'Bash' } }]);
      await sleep(500);
      expect(await tips('What is a permission prompt?')).toBe(0);
      expect(onDisk().tips.seen).toEqual(['compaction']);
      // a new window (the 90 s are the window's), but away (not focused): no tip, nothing counted as seen
      await inject([]);
      await fresh();
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await inject([{ id: 'tip-3', state: 'idle' }]);
      await inject([{ id: 'tip-3', state: 'needs-you', tool: { name: 'Bash' } }]);
      await sleep(500);
      expect(await tips('What is a permission prompt?')).toBe(0);
      expect(onDisk().tips.seen).toEqual(['compaction']);
      // back in front: the permission tip (a new prompt); Don't show tips
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await inject([]);
      await inject([{ id: 'tip-3', state: 'needs-you', tool: { name: 'Bash' } }]);
      await until(async () => (await tips('What is a permission prompt?')) === 1, 5_000, 'the permission tip');
      await page.locator('.toast', { hasText: 'What is a permission prompt?' }).locator('.toast-act', { hasText: "Don't show tips" }).click();
      await until(async () => onDisk().tips.enabled === false, 5_000, 'tips off on disk');
      expect(onDisk().tips.seen).toEqual(['compaction', 'permission']);
      await inject([]);
      await fresh();
      await inject([{ id: 'tip-4', state: 'working', subagents: [{ id: 'a1', status: 'running', startAgo: 1000 }] }]);
      await sleep(600);
      expect(await tips('What is a subagent?')).toBe(0);
      // Settings → Help: the switch and Show tips again
      await page.keyboard.press('Meta+,');
      await page.waitForSelector('.settings');
      await page.click('.settings-nav button:has-text("Help")');
      const sw = page.locator('.settings .field', { hasText: 'Show tips' }).locator('input[type=checkbox]');
      expect(await sw.isChecked()).toBe(false);
      await page.locator('.settings .field', { hasText: 'Show tips' }).locator('.switch').click();
      await until(async () => onDisk().tips.enabled === true, 5_000, 'tips on again');
      expect(await page.textContent('.settings .field:has(.lr-again) small')).toBe('2 shown so far; each shows once');
      await page.click('.settings .lr-again');
      await until(async () => onDisk().tips.seen.length === 0, 5_000, 'tips.seen cleared');
      await until(async () => page.locator('.settings .lr-again').isDisabled(), 3_000, 'nothing left to clear');
      expect(await page.locator('.settings .lr-open').count()).toBe(1);
      await page.click('.settings .lr-open');
      await page.waitForSelector('.lr-glossary');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.lr-glossary', { state: 'detached' });
    } finally {
      await inject([]);
      await cfgPatch({ tips: { enabled: false, seen: [] } });
    }
  }, 60_000);

  // 1.4.1 (spec item 3): screen reader support follows terminal.screenReader and what macOS reports
  it('screen reader: on exposes the terminal text to VoiceOver in every pane, off does not, auto follows the app.accessibility event, and the Settings select writes the key', async () => {
    const trees = () => page.locator('.term .xterm-accessibility').count();
    const assistive = (on: boolean) => page.evaluate((v) => (window as any).__event('app.accessibility', v), on);
    try {
      await assistive(false);
      await cfgPatch({ terminal: { screenReader: 'auto' } });
      await sleep(200);
      expect(await trees()).toBe(0); // (auto, nothing reported: off)
      await assistive(true);
      await until(async () => (await trees()) === 1, 5_000, 'auto to follow a screen reader being reported');
      await assistive(false);
      await until(async () => (await trees()) === 0, 5_000, 'auto to follow the screen reader going away');
      await cfgPatch({ terminal: { screenReader: 'on' } });
      await until(async () => (await trees()) === 1, 5_000, 'on to expose the text');
      await cfgPatch({ terminal: { screenReader: 'off' } });
      await assistive(true);
      await sleep(300);
      expect(await trees()).toBe(0); // (off wins over a reported screen reader)
      await cfgPatch({ terminal: { screenReader: 'banana' } });
      await until(async () => (await trees()) === 1, 5_000, 'an unknown value to count as auto');
      await assistive(false);
      await until(async () => (await trees()) === 0, 5_000, 'an unknown value to follow the screen reader going away');
      // every pane, also one opened after the setting
      await cfgPatch({ terminal: { screenReader: 'on' } });
      await menu('split-terminal');
      await until(async () => (await page.locator('.panes > .pane').count()) === 2, 10_000, 'a second pane');
      await until(async () => (await trees()) === 2, 5_000, 'both panes to expose their text');
      await menu('close-terminal');
      await until(async () => (await page.locator('.panes > .pane').count()) === 1, 10_000, 'the second pane to close');
      // the select
      await cfgPatch({ terminal: { screenReader: 'auto' } });
      await openSettings('Appearance');
      const field = page.locator('label.field', { hasText: 'Screen reader support' });
      expect(await field.locator('select option').allTextContents()).toEqual(['Auto', 'On', 'Off']);
      expect(await field.textContent()).toContain('Exposes terminal text to VoiceOver. Slower with lots of output. Auto turns it on when macOS reports a screen reader.');
      expect(await field.locator('select').inputValue()).toBe('auto');
      await field.locator('select').selectOption('on');
      await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).terminal.screenReader === 'on', 5_000, 'the select to reach the config');
      await until(async () => (await trees()) === 1, 5_000, 'the select to expose the text');
      await closeSettings();
    } finally {
      await assistive(false);
      await cfgPatch({ terminal: { screenReader: 'auto' } });
      if ((await page.locator('.panes > .pane').count()) > 1) await menu('close-terminal');
      await until(async () => (await trees()) === 0, 5_000, 'the screen reader tree to go away again');
    }
  }, 60_000);

  // 1.4.1 (spec item 4): OSC 8 links open only with ⌘, only http(s), through openExternal
  it('OSC 8 links: ⌘-click opens an http(s) link, a click alone and every other link do nothing, anything else says so once', async () => {
    const opened = () => page.evaluate(() => (window as any).__opened as string | undefined);
    const reset = () => page.evaluate(() => ((window as any).__opened = undefined));
    const activate = (meta: boolean, uri: string) =>
      page.evaluate(([m, u]) => (window as any).__jaffer.terminals.get('main').term.options.linkHandler.activate({ metaKey: m } as MouseEvent, u, { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }), [meta, uri] as const);
    const note = () => page.locator('.toast-text', { hasText: 'Only web links open from the terminal.' }).count();
    await page.click('.term');
    await enter(`printf '\\e]8;;https://example.com/x\\e\\\\LINKTEXT\\e]8;;\\e\\\\\\n'`);
    const where = await until(
      () =>
        page.evaluate(() => {
          const b = (window as any).__jaffer.terminals.get('main').term.buffer.active;
          for (let y = b.length - 1; y >= 0; y--) if (b.getLine(y)!.translateToString(true) === 'LINKTEXT') return { row: y - b.viewportY };
          return null;
        }),
      10_000,
      'the printed link text',
    );
    const click = async (meta: boolean) => {
      const box = (await page.locator('.term .xterm-screen').boundingBox())!;
      const dims = await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term._core._renderService.dimensions.css.cell);
      await page.mouse.move(box.x + 3.5 * dims.width, box.y + (where.row + 0.5) * dims.height);
      await sleep(250); // (the link is found on hover)
      if (meta) await page.keyboard.down('Meta');
      await page.mouse.down();
      await page.mouse.up();
      if (meta) await page.keyboard.up('Meta');
    };
    await reset();
    await click(false);
    await sleep(300);
    expect(await opened()).toBeUndefined();
    await click(true);
    await until(async () => (await opened()) === 'https://example.com/x', 3_000, 'the OSC 8 link to open on ⌘-click');
    // the handler itself
    await reset();
    await activate(false, 'https://example.com/y');
    expect(await opened()).toBeUndefined(); // (no ⌘)
    expect(await note()).toBe(0); // (and nothing said about it)
    await activate(true, 'http://example.com/z');
    expect(await opened()).toBe('http://example.com/z');
    await reset();
    await activate(true, 'javascript:alert(1)');
    await activate(true, 'file:///etc/passwd');
    await activate(true, 'https://user:pass@example.com/');
    await activate(true, 'https://example.com/' + 'a'.repeat(2100));
    await activate(true, 'vscode://file/etc/passwd');
    expect(await opened()).toBeUndefined();
    expect(await note()).toBe(1); // (once, however many)
    expect(await page.evaluate(() => (window as any).__jaffer.terminals.get('main').term.options.linkHandler.allowNonHttpProtocols)).toBe(false);
  }, 40_000);

  // (last) Every run starts from its own temporary home, daemon, bridge and browser; within a run the tests share one page and one daemon.
  // What the 1.2.0 tests change is put back: no test after them, and no state a later run could be handed, starts from it.
  it('the run leaves nothing of the 1.2.0 tests behind: no approval waits, no stand-in for the window\'s calls, the seen version, the switches and the panel as a first start leaves them', async () => {
    const version: string = await page.evaluate(() => window.jaffer.appInfo().then((a: { version: string }) => a.version));
    expect(await page.evaluate(() => window.jaffer.call('claude.approvals', {}))).toEqual({ items: [] });
    expect(await page.locator('.ap-ask, .modal, .palette').count()).toBe(0);
    expect(await page.evaluate(() => String((window as any).jaffer.call))).not.toMatch(/__(hist|rev|ap|ob|ci|ex|priv|old|sx|up)Real|__closes/); // (every wrapper restored; 1.4.0: ci, ex, priv, old, sx, up and the close spy)
    // (1.4.0) one terminal, the permission switches, tags, hidden and budgets as they were, the tour done and tips off (the tests turned them so)
    expect(await page.locator('.panes > .pane').count()).toBe(1);
    expect(((await page.evaluate(() => window.jaffer.call('pane.list'))) as unknown[]).length).toBe(1);
    const c = await page.evaluate(() => window.jaffer.call('config.get'));
    expect(c.permissions).toEqual({ explain: false, deepSearch: false, resumeTyping: true, trash: true });
    expect([c.history.tags, c.history.hidden, c.claude.projectBudgets]).toEqual([[], [], []]);
    expect([c.tour.done, c.tips.enabled]).toEqual([true, false]);
    expect(c.claude.approvals).toBe(false);
    expect(c.updates.seenVersion).toBe(version);
    expect(c.panel.open).toBe(true);
    // and the window, loaded again, starts from nothing of it
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.term .xterm');
    await sleep(300);
    expect(await page.locator('.ap-ask, .wn-card, .toast').count()).toBe(0);
  }, 30_000);
});

void ensureDaemon;
