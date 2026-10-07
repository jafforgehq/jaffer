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
    expect(text).not.toMatch(/skip/i);
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
    // a first run starts with just the terminal; Claude's panel is one click (or ⌘J) away and says what it is
    expect(await page.locator('.panel-head').count()).toBe(0);
    await page.click('.seg-btn[title^="Claude"]');
    await page.waitForSelector('.panel-head');
    expect(await page.textContent('.panel-sub')).toMatch(/Live view of the Claude running in your terminal/);
  }, 90_000);


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
    await page.click('.seg-btn[title^="Claude"]'); // the tests after this one start from an open panel, as the first run leaves it
    await page.waitForSelector('.panel-head');
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

  it('the title bar and status bar follow the shell (cwd, last command)', async () => {
    await page.keyboard.type('cd /tmp');
    await page.keyboard.press('Enter');
    await until(async () => (await page.textContent('.session-pill .cwd'))?.includes('/tmp'), 10_000, 'cwd in the title bar');
    expect(await page.textContent('.statusbar')).toContain('cd /tmp');
  });

  it('the session rail shows where you are and what just ran, and can be hidden', async () => {
    await page.waitForSelector('.rail');
    const rail = (await page.textContent('.rail')) ?? '';
    expect(rail).toContain('Session live');
    expect(await page.textContent('.rail .cmd-list')).toContain('hello-from-the-ui'); // from the daemon's record of the session
    await page.keyboard.press('Meta+b');
    await page.waitForSelector('.rail', { state: 'detached' });
    await page.keyboard.press('Meta+b');
    await page.waitForSelector('.rail');
  });

  it('marks finished commands in the terminal gutter: green when they worked, red when they failed', async () => {
    await page.click('.term');
    for (const cmd of ['true', 'false']) {
      await page.keyboard.type(cmd, { delay: 8 });
      await page.keyboard.press('Enter');
      await sleep(400);
    }
    await until(async () => (await page.$('.blk.ok')) && (await page.$('.blk.err')), 10_000, 'a green and a red stripe');
    // and the rail records the failure
    await until(async () => /false/.test((await page.textContent('.rail .cmd-row.bad')) ?? ''), 10_000, 'the failed command in the rail');
  }, 30_000);

  it('there is one Claude in the sidebar; the panel header opens the full Claude Code in the terminal', async () => {
    const titles = await page.$$eval('.rail .row-title', (els) => els.map((e) => e.textContent));
    expect(titles.filter((t) => t === 'Claude')).toHaveLength(1);
    expect(titles).not.toContain('Claude Code'); // it used to be listed as a second "agent": it is the same Claude, just another place to use it
    expect((await page.textContent('.rail')) ?? '').not.toContain('click to start');
    // a stand-in `claude` (an alias is a plain command, so the shell reports it), so the test never starts the real program
    await page.click('.term');
    await page.keyboard.type("alias claude='echo opened-claude-code-from-panel'", { delay: 4 });
    await page.keyboard.press('Enter');
    await until(async () => /alias claude/.test((await page.textContent('.rail .cmd-list')) ?? ''), 10_000, 'the stand-in to be defined and the shell idle');
    await page.click('.agent .panel-head button[title^="Open the full Claude Code"]');
    await until(async () => (await termText()).split('\n').some((l) => l.trim() === 'opened-claude-code-from-panel'), 10_000, 'the header button to run claude in the terminal');
    await page.keyboard.type('unalias claude', { delay: 4 });
    await page.keyboard.press('Enter');
  }, 40_000);

  it('the panel is a live companion: no session, then working with its tool, needs you, then idle with the reply', async () => {
    if (!(await page.$('.agent .panel-head'))) await page.click('.seg-btn[title^="Claude"]');
    await page.waitForSelector('.live-empty');
    expect(await page.textContent('.live-empty')).toMatch(/Run .?claude.? in the terminal/);
    expect(await page.textContent('.live-pill')).toBe('No session');
    expect(await page.locator('.agent textarea').count()).toBe(0); // no prompt box: you talk to Claude in the terminal
    expect(await page.locator('.composer').count()).toBe(0);

    await sendHook('UserPromptSubmit', { prompt: 'fix the build, my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    await sendHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' });
    await page.waitForSelector('.live-pill[data-state="working"]');
    expect(await page.textContent('.live-pill')).toBe('Working');
    // the daemon pushes at most every 100 ms, so the tool can arrive a moment after the first event
    await until(async () => /Bash/.test((await page.textContent('.live-now')) ?? '') && /npm test/.test((await page.textContent('.live-now')) ?? ''), 8_000, 'the running tool');
    expect(await page.textContent('.agent')).not.toContain('sk-ant-api03'); // a secret in a prompt never reaches the screen
    expect((await page.textContent('.rail')) ?? '').toMatch(/working/i);
    expect((await page.textContent('.statusbar')) ?? '').toMatch(/working/i);

    await sendHook('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    await page.waitForSelector('.live-pill[data-state="needs-you"]');
    expect(await page.textContent('.live-pill')).toBe('Needs you');
    expect(await page.textContent('.live-needs')).toContain('Claude needs your permission to use Bash');
    expect((await page.textContent('.rail')) ?? '').toMatch(/waiting for you/i);
    await shot('03b-needs-you');

    await sendHook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', duration_ms: 1500 });
    await sendHook('Stop', { last_assistant_message: 'All tests pass now.' });
    await page.waitForSelector('.live-pill[data-state="idle"]');
    expect(await page.textContent('.live-pill')).toBe('Idle');
    expect(await page.locator('.live-needs').count()).toBe(0);
    expect(await page.textContent('.live-activity .live-row[data-status="done"]')).toContain('npm test');
    expect(await page.textContent('.live-reply')).toContain('All tests pass now.');
    await shot('03-agent');
  }, 40_000);

  it('animations: Claude at work looks alive, the Settings switch turns them off, and macOS Reduce motion is respected', async () => {
    const cs = (sel: string, prop: string) => page.$eval(sel, (el, p) => (getComputedStyle(el) as any)[p as string], prop);
    if (!(await page.$('.agent .panel-head'))) await page.click('.seg-btn[title^="Claude"]');
    await sendHook('UserPromptSubmit', { prompt: 'work on it' });
    await sendHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'm1' });
    await sendHook('SubagentStart', { agent_id: 'm-agent-1', agent_type: 'general-purpose' });
    await page.waitForSelector('.live-pill[data-state="working"]');
    await page.waitForSelector('.live-activity .live-row');
    // on by default
    expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('on');
    expect(await cs('.live-pill', 'animationName')).toContain('fx-breathe');
    expect(await cs('.live-activity .live-row', 'animationName')).toContain('fx-slide-in');
    expect(await page.locator('.fx-eq').count()).toBe(1); // the little equaliser beside the status
    const mark = '.live-activity .live-row[data-status="running"] .live-mark';
    expect(await cs(mark, 'animationName')).toContain('blink');
    expect(await page.locator('.fx-agents .fx-dot').count()).toBe(1); // one pulsing dot per running subagent
    await shot('03d-working');
    // off from Settings → Appearance
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('label.field', { hasText: 'Animations' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).appearance.animations === false, 8_000, 'the setting to be saved');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('off');
    expect(await cs('.live-pill', 'animationName')).toBe('none');
    expect(await cs('.live-activity .live-row', 'animationName')).toBe('none');
    expect(await page.locator('.fx-eq').count()).toBe(0);
    expect(await cs(mark, 'animationName')).toBe('none'); // the existing blinking mark is decoration too, so the switch stops it
    expect(await page.locator('.fx-agents .fx-dot').count()).toBe(1); // the count itself stays: it is information, only the pulsing is decoration
    expect(await cs('.fx-agents .fx-dot', 'animationName')).toBe('none');
    // and on again
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.locator('label.field', { hasText: 'Animations' }).locator('.switch').click();
    await until(async () => (await page.evaluate(() => window.jaffer.call('config.get'))).appearance.animations === true, 8_000, 'the setting to be saved again');
    await page.keyboard.press('Escape');
    expect(await cs('.live-pill', 'animationName')).toContain('fx-breathe');
    // macOS "Reduce motion": everything stands still even though the setting is on
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const dur = parseFloat(String(await cs('.live-pill', 'animationDuration')));
    expect(dur).toBeLessThan(0.001);
    await page.emulateMedia({ reducedMotion: null });
    await sendHook('SubagentStop', { agent_id: 'm-agent-1', agent_type: 'general-purpose' });
    await sendHook('Stop', { last_assistant_message: 'done' });
  }, 60_000);

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
    const chip = '.session-card .tag.claude';
    if (!(await page.$('.rail'))) await page.keyboard.press('Meta+b');
    await page.waitForSelector('.rail');
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
    await page.waitForSelector(chip);
    expect(await page.locator(`${bar} .spinner`).count()).toBe(0);
    expect(await page.locator(`${bar} .run-dot`).count()).toBe(1);
    expect(await page.locator(`${chip} .spinner`).count()).toBe(0);
    // it starts working: now it moves
    await sendHook('UserPromptSubmit', { session_id: 'spin-1', prompt: 'go' });
    await page.waitForSelector(`${bar} .spinner`);
    await page.waitForSelector(`${chip} .spinner`);
    expect(await cs(`${bar} .spinner`, 'animationName')).toContain('spin');
    // Animations off: the ring stands still, still visible
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: false } }));
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'off', 8_000, 'motion to be off');
    expect(await cs(`${bar} .spinner`, 'animationName')).toBe('none');
    expect(await cs(`${chip} .spinner`, 'animationName')).toBe('none');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { animations: true } }));
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === 'on', 8_000, 'motion to be on again');
    // the turn ends: calm again, though the program is still running
    await sendHook('Stop', { session_id: 'spin-1', last_assistant_message: 'done' });
    await until(async () => (await page.locator(`${bar} .spinner`).count()) === 0 && (await page.locator(`${chip} .spinner`).count()) === 0, 8_000, 'the spinners to stop');
    expect(await page.locator(`${bar} .run-dot`).count()).toBe(1);
    await page.keyboard.press('Control+c');
    await until(async () => !(await page.$(bar)), 10_000, 'the command to end');
    await sendHook('SessionEnd', { session_id: 'spin-1' });
  }, 60_000);

  it('file paths in the panel are shown relative to where Claude is working', async () => {
    const file = '/work/app/src/auth/session.ts';
    await sendHook('SessionStart', { session_id: 'paths-1', cwd: '/work/app' });
    await sendHook('UserPromptSubmit', { session_id: 'paths-1', cwd: '/work/app', prompt: 'look at the session code' });
    await sendHook('PreToolUse', { session_id: 'paths-1', cwd: '/work/app', tool_name: 'Read', tool_input: { file_path: file }, tool_use_id: 'p1' });
    await until(async () => /src\/auth\/session\.ts/.test((await page.textContent('.live-now')) ?? ''), 8_000, 'the file being read');
    expect(await page.textContent('.live-now')).not.toContain('/work/app/');
    expect(await page.getAttribute('.live-activity .live-row .live-sum', 'title')).toBe(file); // the full path stays one hover away
    await sendHook('SessionEnd', { session_id: 'paths-1' });
  });

  it('the panel lists subagents, and goes back to "No session" when Claude Code ends', async () => {
    await sendHook('SubagentStart', { agent_id: 'agent-1', agent_type: 'general-purpose' });
    await page.waitForSelector('.live-subagents');
    expect(await page.textContent('.live-subagents')).toContain('general-purpose');
    await sendHook('SubagentStop', { agent_id: 'agent-1', agent_type: 'general-purpose' });
    await until(async () => /done/i.test((await page.textContent('.live-subagents')) ?? ''), 8_000, 'the subagent to show as done');
    await sendHook('SessionEnd');
    await page.waitForSelector('.live-pill[data-state="none"]');
    expect(await page.textContent('.live-pill')).toBe('No session');
  });

  it('with Claude Code not connected the empty panel says so, instead of claiming Claude is not running, and Connect fixes it', async () => {
    await page.evaluate(() => window.jaffer.call('setup.claude.remove', {}));
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    if (!(await page.$('.agent .panel-head'))) await page.click('.seg-btn[title^="Claude"]');
    await until(async () => /not connected/i.test((await page.textContent('.live-empty')) ?? ''), 15_000, 'the not-connected message');
    expect(await page.textContent('.live-empty')).not.toMatch(/isn't running/);
    await shot('03c-not-connected');
    await page.click('.live-empty .btn.primary');
    await until(async () => /isn't running/.test((await page.textContent('.live-empty')) ?? ''), 20_000, 'the panel after connecting');
    const status = await page.evaluate(() => window.jaffer.call('setup.claude.status', {}));
    expect(status.hooks).toBe(true);
  }, 60_000);

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
    expect(await page.$$eval('.settings-nav button', (b) => b.map((x) => x.textContent?.trim()))).toEqual(['Appearance', 'Memory', 'Claude Code', 'Updates']);
    // Jaffer runs on a Claude subscription: no API key to enter and no engine to pick, in any section
    for (const section of ['Memory', 'Claude Code']) {
      await page.click(`.settings-nav button:has-text("${section}")`);
      const body = (await page.textContent('.settings')) ?? '';
      expect(body, `Settings > ${section}`).not.toMatch(/api key|Anthropic key|sk-ant/i);
      expect(await page.locator('.settings input[type="password"]').count(), `Settings > ${section}`).toBe(0);
    }
    expect(await page.textContent('.settings')).not.toMatch(/Runs on|Automatic \(|Approvals|Run commands|Always-allowed/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  });

  it('there is exactly one session: no split controls, the shortcuts do nothing, and the daemon refuses to open another', async () => {
    await page.keyboard.press('Escape');
    expect(await page.$('button[title^="Split"]')).toBeNull();
    expect((await page.textContent('.rail')) ?? '').not.toMatch(/Split|Panes/);
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

  it('a lapsed Claude login shows a lasting banner in the panel; signing in clears it and types nothing into the terminal', async () => {
    fake.setLoggedIn(false); // as when the login expires
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`); // a fresh start of the app checks on boot
    if (!(await page.$('.agent .panel-head'))) await page.click('.seg-btn[title^="Claude"]');
    await page.waitForSelector('.panel-signin', { timeout: 20_000 });
    expect(await page.textContent('.panel-signin')).toMatch(/signed out/i);
    await shot('01b-panel-signed-out');
    await page.click('.panel-signin .btn.primary');
    await page.waitForSelector('.panel-signin', { state: 'detached', timeout: 20_000 });
    expect(await termText()).not.toMatch(/auth login/);
  }, 60_000);


  it('a signed-out banner clears by itself when the user signs in elsewhere and comes back to the window', async () => {
    fake.setLoggedIn(false);
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    if (!(await page.$('.agent .panel-head'))) await page.click('.seg-btn[title^="Claude"]');
    await page.waitForSelector('.panel-signin', { timeout: 20_000 });
    fake.setLoggedIn(true); // signed in in another terminal
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // the window comes back to the front
    await page.waitForSelector('.panel-signin', { state: 'detached', timeout: 20_000 });
  }, 60_000);
});

void ensureDaemon;
