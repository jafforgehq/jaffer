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
  fake = fakeClaude(path.join(env.root, 'bin'), { loggedIn: false, passthrough: CLAUDE });
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
    expect(await page.locator('.onboard .choices').count()).toBe(0);
    expect(await page.getByText('Get started').count()).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('.onboard').count()).toBe(1); // it cannot be dismissed
    await shot('01a-onboarding-signin');

    // signing in (the stand-in `claude auth login` signs in a moment after it starts) moves on to the consent choices
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard[data-step="choices"]', { timeout: 20_000 });
    const choices = (await page.textContent('.onboard')) ?? '';
    expect(choices).not.toMatch(/codex|gemini|other agents/i);
    expect(choices).toContain('Get started');
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
    // Jaffer drove the sign-in itself: nothing was typed into the user's shell
    await until(async () => /❯/.test(await termText()), 20_000, 'the shell prompt');
    expect(await termText()).not.toMatch(/auth login/);
    // a first run starts with just the terminal; Claude's panel is one click (or ⌘J) away and says what it is
    expect(await page.locator('.panel-head').count()).toBe(0);
    await page.click('.seg-btn[title^="Claude"]');
    await page.waitForSelector('.panel-head');
    expect(await page.textContent('.panel-sub')).toMatch(/This chat is separate from the claude you run there/);
  }, 90_000);

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

  it('talks to the agent, runs its command in the shared terminal, and shows the answer', async () => {
    mock.reset().queue({ kind: 'tool', id: 'toolu_ui1', name: 'run_command', input: { command: 'echo agent-ran-this' }, text: 'Let me check.' }, { kind: 'text', text: 'Done — the command printed **agent-ran-this**.' });
    await page.fill('.composer textarea', 'run a quick echo');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.user');
    await until(async () => (await page.$$('.msg.assistant')).length >= 1 && /agent-ran-this/.test((await page.textContent('.thread')) ?? ''), 15_000, 'assistant answer');
    expect(await termText()).toContain('agent-ran-this'); // it really ran in the user's terminal
    expect(await page.$('.tool')).toBeTruthy();
    await until(async () => !(await page.$('.working')), 10_000, 'turn to finish');
    await shot('03-agent');
  }, 40_000);

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

  it('asks for approval in the UI before writing a file, and obeys Allow', async () => {
    const target = path.join(env.userHome, 'ui-approved.txt');
    mock.reset().queue({ kind: 'tool', id: 'toolu_ui2', name: 'write_file', input: { path: target, content: 'written via approval' } }, { kind: 'text', text: 'File written.' });
    await page.fill('.composer textarea', 'please write a file');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.approval');
    expect(fs.existsSync(target)).toBe(false);
    await shot('04-approval');
    await page.click('.approval .btn.primary');
    await until(async () => fs.existsSync(target), 10_000, 'file to be written');
    await until(async () => /File written/.test((await page.textContent('.thread')) ?? ''), 10_000, 'final message');
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

  it('command palette runs actions and can hand free text to the agent', async () => {
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
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

  it.skipIf(!CLAUDE)('the Claude panel runs on a Claude Code login: it says so, asks in the UI, and runs commands in the terminal', async () => {
    const target = path.join(env.userHome, 'claude-made.txt');
    try {
      await page.evaluate(() => window.jaffer.call('config.patch', { agent: { engine: 'claude-code' } }));
      if (!(await page.$('.composer textarea'))) await page.click('.seg-btn[title^="Claude"]');
      await page.waitForSelector('.engine-chip');
      await until(async () => (await page.textContent('.engine-chip'))?.includes('Claude Code login'), 10_000, 'the engine chip');
      const main = (b: any) => (b.tools?.length ?? 0) > 0;
      mock.reset().queue(
        { kind: 'tool', id: 'toolu_cu1', name: 'mcp__jaffer-session__run_command', input: { command: `touch ${target}` }, text: 'Creating the file.', when: main },
        { kind: 'text', text: 'Created **claude-made.txt** in your terminal.', when: main },
      );
      await page.fill('.composer textarea', 'create a file called claude-made.txt');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.approval', { timeout: 60_000 });
      expect(await page.textContent('.approval')).toContain(`touch ${target}`); // the command, before it runs
      expect(fs.existsSync(target)).toBe(false);
      await shot('11-claude-code-engine');
      await page.click('.approval .btn.primary');
      await until(async () => /Created claude-made\.txt/.test((await page.textContent('.thread')) ?? ''), 60_000, 'the answer');
      await until(async () => fs.existsSync(target), 10_000, 'the file').catch(async (e) => {
        const t = await page.evaluate(() => window.jaffer.call('agent.thread', {}));
        throw new Error(`${e.message}; tool rows: ${JSON.stringify(t.items.filter((i: any) => i.kind === 'tool'))}; panes: ${JSON.stringify(await page.evaluate(() => window.jaffer.call('pane.list', {})))}`);
      });
      expect((await termText()).replace(/\n/g, '')).toContain(`touch ${target}`); // it ran in the user's own terminal (a narrow pane wraps the line)
    } finally {
      await page.evaluate(() => window.jaffer.call('config.patch', { agent: { engine: 'auto' } }));
      await until(async () => (await page.evaluate(() => window.jaffer.call('agent.thread', {}))).status.engine === 'api', 10_000, 'back to the API engine');
    }
  }, 150_000);

  it('reconnecting the page restores the same session (nothing was lost)', async () => {
    const before = await page.evaluate(() => window.jaffer.call('pane.list'));
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.term .xterm');
    await until(async () => /hello-from-the-ui/.test(await termText()), 15_000, 'restored screen');
    const after = await page.evaluate(() => window.jaffer.call('pane.list'));
    expect(after.map((p: any) => p.pid)).toEqual(before.map((p: any) => p.pid));
    // and the agent conversation is still there (open the agent panel if the memory panel was showing)
    if (!(await page.$('.thread'))) await page.click('.seg-btn[title^="Claude"]');
    await until(async () => /agent-ran-this/.test((await page.textContent('.thread')) ?? ''), 10_000, 'restored conversation');
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
    await page.waitForSelector('.panel-signin', { timeout: 20_000 });
    expect(await page.textContent('.panel-signin')).toMatch(/signed out/i);
    await shot('01b-panel-signed-out');
    await page.click('.panel-signin .btn.primary');
    await page.waitForSelector('.panel-signin', { state: 'detached', timeout: 20_000 });
    expect(await termText()).not.toMatch(/auth login/);
  }, 60_000);

  it('a failed turn re-checks the login: if Claude turns out to be signed out, the banner comes back', async () => {
    // Any failed turn triggers the re-check. The API engine fails fast on a 401 (Claude Code would retry it first).
    await page.waitForSelector('.engine-chip');
    expect(await page.locator('.panel-signin').count()).toBe(0); // signed in again after the previous test
    fake.setLoggedIn(false);
    const rejected = { kind: 'error' as const, status: 401, message: 'invalid x-api-key', when: (b: any) => JSON.stringify(b.messages ?? []).includes('hello') };
    mock.reset().queue(rejected, rejected);
    await page.fill('.composer textarea', 'hello');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.panel-signin', { timeout: 30_000 }).catch(async (e) => {
      const t = await page.evaluate(() => window.jaffer.call('agent.thread', {}));
      throw new Error(`${e.message}; thread: ${JSON.stringify(t.items.slice(-3))}; engine: ${t.status.engine}; toasts: ${JSON.stringify(await page.locator('.toast').allTextContents())}`);
    });
    await page.click('.panel-signin .btn.primary');
    await page.waitForSelector('.panel-signin', { state: 'detached', timeout: 20_000 });
  }, 90_000);
});

void ensureDaemon;
