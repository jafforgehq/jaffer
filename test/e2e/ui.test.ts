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
    // a shortcut must not replace the first-run screen: closing what replaced it would leave first run unfinished
    for (const k of ['Meta+p', 'Meta+,', 'Meta+f']) await page.keyboard.press(k);
    await sleep(300);
    expect(await page.locator('.palette, .settings, .findbar').count()).toBe(0);
    expect(await page.locator('.onboard').count()).toBe(1);
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

  it('Restart Claude Code: in the palette and in Settings → Claude Code, both only ask the app, which asks the person first', async () => {
    // the question is the app's own native dialog (its text is covered by restart-claude.test.ts); here the app is stood in for
    await page.evaluate(() => {
      const w = window as any;
      w.__restartAsked = 0;
      w.__restartAnswer = { cancelled: true };
      w.__origRestart = w.jaffer.restartClaude;
      w.jaffer.restartClaude = async () => {
        w.__restartAsked++;
        return w.__restartAnswer;
      };
    });
    const asked = () => page.evaluate(() => (window as any).__restartAsked as number);
    try {
      // the palette lists it by what it is for
      await page.keyboard.press('Meta+p');
      await page.waitForSelector('.palette input');
      await page.keyboard.type('new version');
      const found = (await page.textContent('.palette-list')) ?? '';
      expect(found).toContain('Restart Claude Code, to use an update');
      expect(found).toContain('Terminal');
      await page.fill('.palette input', 'update claude code');
      expect(await page.locator('.pal-row', { hasText: 'Restart Claude Code, to use an update' }).count()).toBe(1);
      await page.keyboard.press('Enter');
      await until(async () => (await asked()) === 1, 5_000, 'the palette action to ask the app');
      await sleep(300);
      expect(await page.locator('.toast', { hasText: /restarted/i }).count()).toBe(0); // the person said no: nothing is announced
      // the button in Settings → Claude Code
      await page.keyboard.press('Meta+,');
      await page.waitForSelector('.settings');
      await page.locator('.settings-nav button', { hasText: 'Claude Code' }).click();
      const btn = page.locator('.settings button', { hasText: 'Restart Claude Code' });
      expect(await btn.count()).toBe(1);
      await btn.click();
      await until(async () => (await asked()) === 2, 5_000, 'the Settings button to ask the app');
      await sleep(300);
      expect(await page.locator('.toast', { hasText: /restarted/i }).count()).toBe(0);
      // a yes, with a conversation to bring back, is said plainly (the notice with Cancel is the daemon's own)
      await page.evaluate(() => ((window as any).__restartAnswer = { cancelled: false, resumable: true }));
      await btn.click();
      await until(async () => (await asked()) === 3, 5_000, 'the third ask');
      const toast = page.locator('.toast', { hasText: 'Shell restarted' });
      await toast.waitFor();
      expect(await toast.textContent()).toMatch(/same conversation/);
      // with none, only the shell
      await page.evaluate(() => ((window as any).__restartAnswer = { cancelled: false, resumable: false }));
      await btn.click();
      await until(async () => (await asked()) === 4, 5_000, 'the fourth ask');
      await until(async () => (await page.locator('.toast', { hasText: 'Shell restarted' }).allTextContents()).some((t) => !/conversation/.test(t)), 5_000, 'the plain toast');
      // an error from the app is shown, not swallowed
      await page.evaluate(() => {
        (window as any).jaffer.restartClaude = async () => {
          throw new Error('The session daemon is not connected.');
        };
      });
      await btn.click();
      await page.locator('.toast', { hasText: 'The session daemon is not connected.' }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForSelector('.settings', { state: 'detached' });
    } finally {
      await page.evaluate(() => {
        const w = window as any;
        w.jaffer.restartClaude = w.__origRestart;
      });
      // (a failure above must not leave a dialog over the next test; and with none open, Escape would go to the shell)
      for (let i = 0; i < 2 && (await page.locator('.settings, .palette').count()) > 0; i++) await page.keyboard.press('Escape');
    }
  }, 40_000);

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

  it('the Notes tab: opening it never rewrites NOTES.md, what was typed is saved even if the tab is left at once, and it cannot grow without limit', async () => {
    const notes = path.join(env.home, 'memory', 'NOTES.md');
    const tab = (name: string) => page.locator('.tabs button', { hasText: name }).click();
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    const long = 'a line of the person’s own notes\n'.repeat(900); // over the 20 000 characters the tab edits
    fs.writeFileSync(notes, long);
    const before = fs.statSync(notes).mtimeMs;
    await page.keyboard.press('Meta+Shift+M');
    await page.waitForSelector('.memory');
    await tab('Notes');
    await page.waitForSelector('.notes textarea');
    await sleep(1300); // longer than the half second the tab waits before saving
    expect(fs.readFileSync(notes, 'utf8')).toBe(long); // just looking changed nothing: not cut, not rewritten
    expect(fs.statSync(notes).mtimeMs).toBe(before);
    expect(await page.getAttribute('.notes textarea', 'maxlength')).toBe('20000');
    // typed, then the tab is left within the half second: it is saved all the same
    fs.writeFileSync(notes, 'old note\n');
    await tab('Learned');
    await tab('Notes');
    await until(async () => (await page.inputValue('.notes textarea')) === 'old note\n', 8_000, 'the notes to load');
    await page.fill('.notes textarea', 'typed and left at once');
    await tab('Learned');
    await until(async () => fs.readFileSync(notes, 'utf8') === 'typed and left at once', 5_000, 'the notes to be saved on leaving the tab');
    // and again when the whole drawer is closed straight after typing
    await tab('Notes');
    await until(async () => (await page.inputValue('.notes textarea')) === 'typed and left at once', 8_000, 'the notes to load again');
    await page.fill('.notes textarea', 'typed, drawer closed');
    await page.keyboard.press('Meta+Shift+M');
    await until(async () => fs.readFileSync(notes, 'utf8') === 'typed, drawer closed', 5_000, 'the notes to be saved on closing the drawer');
    fs.rmSync(notes, { force: true });
  }, 60_000);

  it('Settings: no label wraps a button, focus goes into the dialog and back, Open at login tells the truth, the colour scheme follows the theme', async () => {
    const dialogFocused = () => page.evaluate(() => !!document.activeElement?.closest('.modal'));
    const nav = (name: string) => page.locator('.settings-nav button', { hasText: name }).click();
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await until(dialogFocused, 3_000, 'the keyboard to move into the dialog'); // the terminal does not keep it behind the dialog
    for (const section of ['Appearance', 'Memory', 'Claude Code', 'Updates', 'Reset']) {
      await nav(section);
      // a <label> around a button forwards a click on its words to the button: "Add memory tools" or "Reset…" by a stray click
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
    // the screen is kept for a restart unless this is switched off
    const keep = page.locator('label.field', { hasText: 'Keep the screen for a restart' });
    const restoreScreen = async () => (await page.evaluate(() => window.jaffer.call('config.get'))).session.restoreScreen;
    expect(await keep.locator('input').isChecked()).toBe(true);
    await keep.locator('.switch').click();
    await until(async () => (await restoreScreen()) === false, 5_000, 'the screen restore to be switched off');
    await keep.locator('.switch').click();
    await until(async () => (await restoreScreen()) === true, 5_000, 'and on again');
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

  it('risky places: the title bar is tinted on a protected branch (amber) and while ssh runs (red), and Settings can turn it off or change the list', async () => {
    const bar = '.titlebar';
    const state = () => page.$eval(bar, (el) => ({ kind: (el as HTMLElement).dataset.danger ?? null, what: (el as HTMLElement).dataset.dangerWhat ?? null, edge: getComputedStyle(el).boxShadow }));
    const repo = (name: string, branch: string) => {
      const dir = path.join(env.userHome, 'danger', name);
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
      return dir;
    };
    const prod = repo('prod-app', 'main');
    const work = repo('work-app', 'feature/login');
    const go = async (dir: string) => {
      await page.click('.term');
      await page.keyboard.press('Control+c');
      await page.keyboard.type(`cd ${dir}`);
      await page.keyboard.press('Enter');
    };
    // a feature branch is calm, main is amber
    await go(work);
    await until(async () => /feature\/login/.test((await page.textContent('.session-pill')) ?? ''), 10_000, 'the feature branch in the title bar');
    expect((await state()).kind).toBeNull();
    expect((await state()).edge).toBe('none');
    await go(prod);
    await until(async () => (await state()).kind === 'branch', 10_000, 'the protected branch to tint the bar');
    expect(await state()).toMatchObject({ kind: 'branch', what: 'main' });
    expect((await state()).edge).not.toBe('none');
    expect(await page.getAttribute('.session-pill', 'title')).toMatch(/protected branch main/);
    // and in words for a screen reader (an aria-label on a plain span is not reliably read): text inside the pill, hidden from the eye
    expect(await page.getAttribute('.session-pill', 'aria-label')).toBeNull();
    expect(await page.textContent('.session-pill .sr-only')).toMatch(/protected branch main/);
    await shot('14i-danger-branch');
    // ssh outranks the branch, names the host, and ends with the command
    await page.keyboard.type('ssh() { sleep 30; }');
    await page.keyboard.press('Enter');
    await sleep(300);
    await page.keyboard.type('ssh deploy@prod-db-1');
    await page.keyboard.press('Enter');
    await until(async () => (await state()).kind === 'ssh', 10_000, 'ssh to tint the bar');
    expect(await state()).toMatchObject({ kind: 'ssh', what: 'prod-db-1' });
    expect(await page.getAttribute('.session-pill', 'title')).toMatch(/ssh to prod-db-1/);
    await shot('14j-danger-ssh');
    await page.keyboard.press('Control+c');
    await until(async () => (await state()).kind === 'branch', 10_000, 'the bar to fall back to the branch when ssh ends');
    await page.keyboard.type('unset -f ssh');
    await page.keyboard.press('Enter');
    // Settings: the switch, and the list
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Appearance' }).click();
    const mark = page.locator('label.field', { hasText: 'Mark risky places' });
    await mark.locator('.switch').click();
    await until(async () => (await state()).kind === null, 5_000, 'the tint to go when switched off');
    expect(await page.locator('label.field', { hasText: 'Protected branches' }).locator('input').isDisabled()).toBe(true);
    await mark.locator('.switch').click();
    await until(async () => (await state()).kind === 'branch', 5_000, 'and to come back');
    const list = page.locator('label.field', { hasText: 'Protected branches' }).locator('input');
    await list.fill('feature/*, staging');
    await list.press('Tab');
    await until(async () => (await state()).kind === null, 5_000, 'main to be calm when it is no longer on the list');
    expect((await page.evaluate(() => window.jaffer.call('config.get'))).safety.protectedBranches).toEqual(['feature/*', 'staging']);
    await page.evaluate(() => window.jaffer.call('config.patch', { safety: { protectedBranches: ['main', 'master', 'production', 'prod', 'release/*'] } }));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await go(work); // leave the terminal somewhere calm for the tests that follow
    await until(async () => (await state()).kind === null, 10_000, 'a calm bar again');
  }, 90_000);

  it('resume: a quiet button when Claude Code can be taken up again, that types only `claude --resume <id>` after a click, hides while the shell is busy, and can be dismissed', async () => {
    const ID = '0b6f1c52-3a3e-4d0e-9f4a-6f0f8c2f6a11';
    const offer = (id: string) => page.evaluate((o) => (window as any).__event('claude.resume', o), { id, cwd: '/tmp', at: Date.now() });
    const chip = '.resume';
    expect(await page.locator(chip).count()).toBe(0); // nothing to resume: nothing shown
    await offer(ID);
    await page.waitForSelector(chip);
    expect(await page.textContent('.resume-go')).toContain('Resume Claude');
    expect(await page.getAttribute('.resume-go', 'title')).toMatch(/claude --resume/);
    await shot('14k-resume');
    // it fits the title bar, in a narrow window too (the words go, the name stays)
    for (const w of [1360, 660]) {
      await page.setViewportSize({ width: w, height: 860 });
      await sleep(250);
      const pill = (await page.locator('.session-pill').boundingBox())!;
      const right = (await page.locator('.tb-right').boundingBox())!;
      expect(pill.x + pill.width, `pill clear of the right side at ${w}px`).toBeLessThanOrEqual(right.x + 1);
      expect(right.x + right.width, `right side inside the window at ${w}px`).toBeLessThanOrEqual(w);
    }
    expect(await page.locator('.resume-label').isVisible()).toBe(false); // 660 px: icon only
    expect(await page.getAttribute('.resume-go', 'aria-label')).toBe('Resume Claude Code');
    await page.setViewportSize({ width: 1360, height: 860 });
    await sleep(250);
    // hidden while something runs in the shell, back when it ends
    await page.click('.term');
    await page.keyboard.type('sleep 30');
    await page.keyboard.press('Enter');
    await until(async () => (await page.locator(chip).count()) === 0, 8_000, 'the button to hide while the shell is busy');
    await page.keyboard.press('Control+c');
    await page.waitForSelector(chip, { timeout: 10_000 });
    // the palette knows it too
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await page.keyboard.type('resume');
    await page.waitForSelector('.palette >> text=Resume the Claude Code conversation');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.palette input', { state: 'detached' });
    // a click types the command for that id and nothing else, and the button goes at once. (A shell function stands in for claude,
    // and says which arguments it was given.)
    await page.click('.term');
    await page.keyboard.type('claude() { echo "stand-in claude got: $*"; }');
    await page.keyboard.press('Enter');
    await sleep(300);
    await page.click('.resume-go');
    await until(async () => (await termText()).includes(`stand-in claude got: --resume ${ID}`), 8_000, 'the command to be typed and run');
    expect(await page.locator(chip).count()).toBe(0);
    // an id that is not an id is never typed
    await offer('abc; echo INJECTED-BY-OFFER');
    await page.waitForSelector(chip);
    await page.click('.resume-go');
    await sleep(600);
    expect(await termText()).not.toContain('INJECTED-BY-OFFER');
    // not now: dismissed, and the daemon is told
    await page.click('.resume-x');
    await until(async () => (await page.locator(chip).count()) === 0, 5_000, 'the dismissed button to go');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.term'))).toBe(true); // focus goes back to the terminal, not to nowhere
    await page.click('.term');
    await page.keyboard.type('unset -f claude');
    await page.keyboard.press('Enter');
    await sleep(300);
    // the setting
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Claude Code' }).click();
    const sw = page.locator('label.field', { hasText: 'Offer to resume Claude Code' });
    const on = async () => (await page.evaluate(() => window.jaffer.call('config.get'))).session.resumeClaude;
    expect(await sw.locator('input').isChecked()).toBe(true);
    await sw.locator('.switch').click();
    await until(async () => (await on()) === false, 5_000, 'the resume offer to be switched off');
    await sw.locator('.switch').click();
    await until(async () => (await on()) === true, 5_000, 'and on again');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  }, 90_000);

  it('auto-resume: a notice with Cancel before Claude is resumed by itself, kept as long as the wait, and its switch under the offer', async () => {
    const ID = '0b6f1c52-3a3e-4d0e-9f4a-6f0f8c2f6a11';
    const send = (e: object) => page.evaluate((x) => (window as any).__event('claude.autoresume', x), e);
    const notice = page.locator('.toast', { hasText: 'Resuming Claude' });
    const asked = async () => (await page.evaluate(() => (window as any).__asked)) as [string, unknown][];
    // what the window asks the daemon, and what the daemon answers
    await page.evaluate(() => {
      const w = window as any;
      w.__origCall = w.jaffer.call;
      w.__asked = [];
      w.jaffer.call = async (m: string, p: unknown) => {
        const r = await w.__origCall(m, p);
        w.__asked.push([m, r]);
        return r;
      };
    });
    try {
      expect(await notice.count()).toBe(0);
      await send({ state: 'pending', id: ID, typesAt: Date.now() + 3000 });
      await notice.waitFor();
      expect(await notice.textContent()).toContain('Resuming Claude in 3 s');
      await shot('14l-autoresume');
      await notice.locator('button', { hasText: 'Cancel' }).click();
      await until(async () => (await asked()).some(([m]) => m === 'claude.autoresume.cancel'), 5_000, 'Cancel to reach the daemon');
      expect((await asked()).find(([m]) => m === 'claude.autoresume.cancel')![1]).toBe(true);
      await until(async () => (await notice.count()) === 0, 5_000, 'the notice to go');
      // a longer wait (a retry) keeps the notice up as long as it runs, not the few seconds of an ordinary toast; typing ends it
      await send({ state: 'pending', id: ID, typesAt: Date.now() + 20_000 });
      await notice.waitFor();
      expect(await notice.textContent()).toContain('Resuming Claude in 20 s');
      await sleep(6_500);
      expect(await notice.count()).toBe(1);
      await send({ state: 'typed', id: ID });
      await until(async () => (await notice.count()) === 0, 5_000, 'the notice to go once it was typed');
      // the daemon ending the notice by itself (the shell got busy, the offer went) takes it away too
      await send({ state: 'pending', id: ID, typesAt: Date.now() + 3000 });
      await notice.waitFor();
      await send({ state: 'cancelled', id: ID });
      await until(async () => (await notice.count()) === 0, 5_000, 'the notice to go when the daemon drops it');
      expect(await page.locator('.toast').count()).toBe(0);
      // a notice that is due already (it reached a window late) never says "in 0 s"
      await send({ state: 'pending', id: ID, typesAt: Date.now() - 500 });
      await notice.waitFor();
      expect(await notice.textContent()).toContain('Resuming Claude in 1 s');
      await send({ state: 'typed', id: ID });
      await until(async () => (await notice.count()) === 0, 5_000, 'the late notice to go once it was typed');
    } finally {
      await page.evaluate(() => {
        const w = window as any;
        w.jaffer.call = w.__origCall;
      });
    }
    // the setting: right under the offer, on by default
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('.settings-nav button', { hasText: 'Claude Code' }).click();
    const sw = page.locator('label.field', { hasText: 'Resume Claude automatically' });
    const offer = page.locator('label.field', { hasText: 'Offer to resume Claude Code' });
    const session = async () => (await page.evaluate(() => window.jaffer.call('config.get'))).session;
    const next = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('.settings .field')];
      return fields[fields.findIndex((f) => f.textContent?.includes('Offer to resume Claude Code')) + 1]?.textContent ?? '';
    });
    expect(next).toContain('Resume Claude automatically');
    expect(await sw.locator('input').isChecked()).toBe(true);
    expect(await sw.locator('input').isDisabled()).toBe(false);
    await sw.locator('.switch').click();
    await until(async () => (await session()).autoResume === false, 5_000, 'auto-resume to be switched off');
    await sw.locator('.switch').click();
    await until(async () => (await session()).autoResume === true, 5_000, 'and on again');
    // it works through the offer: while that is off, it is off and cannot be changed
    await offer.locator('.switch').click();
    await until(async () => (await session()).resumeClaude === false, 5_000, 'the offer to be switched off');
    await until(async () => sw.locator('input').isDisabled(), 5_000, 'the switch to be disabled');
    expect(await sw.locator('input').isChecked()).toBe(false);
    expect((await session()).autoResume).toBe(true); // the choice itself is kept for when the offer comes back
    await offer.locator('.switch').click();
    await until(async () => (await session()).resumeClaude === true, 5_000, 'the offer to be switched on again');
    await until(async () => !(await sw.locator('input').isDisabled()), 5_000, 'the switch to be enabled again');
    expect(await sw.locator('input').isChecked()).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  }, 60_000);

  it('auto-resume: a window that opens while the notice runs asks the daemon, and shows it with Cancel all the same', async () => {
    const ID = '0b6f1c52-3a3e-4d0e-9f4a-6f0f8c2f6a11';
    // The window opens after the daemon announced (a reboot, the app reconnecting after an update): no event reaches it, so it
    // asks `claude.autoresume.state` when it starts. Here the daemon's answer is stood in for, once, on the next page load.
    await page.addInitScript(() => {
      const raw = sessionStorage.getItem('jaffer.test.autoresumeState');
      if (!raw) return;
      sessionStorage.removeItem('jaffer.test.autoresumeState');
      let bridge: any;
      Object.defineProperty(window, 'jaffer', {
        configurable: true,
        get: () => bridge,
        set: (v: any) => {
          const call = v.call;
          let once = true;
          v.call = (m: string, p: unknown) => {
            if (m === 'claude.autoresume.state' && once) {
              once = false;
              return Promise.resolve(JSON.parse(raw));
            }
            return call(m, p);
          };
          bridge = v;
        },
      });
    });
    await page.evaluate((st) => sessionStorage.setItem('jaffer.test.autoresumeState', JSON.stringify(st)), { state: 'pending', id: ID, typesAt: Date.now() + 20_000 });
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.term .xterm');
    const notice = page.locator('.toast', { hasText: 'Resuming Claude' });
    await notice.waitFor({ timeout: 10_000 });
    const secs = Number(/Resuming Claude in (\d+) s/.exec((await notice.textContent()) ?? '')?.[1]);
    expect(secs).toBeGreaterThanOrEqual(10); // the time the daemon announced, less the moment the page took to open
    expect(secs).toBeLessThanOrEqual(20);
    await notice.locator('button', { hasText: 'Cancel' }).click();
    await until(async () => (await notice.count()) === 0, 5_000, 'the notice to go');
  }, 40_000);

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
