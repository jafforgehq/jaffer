import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../helpers/env';
import { MockAnthropic } from '../helpers/mock-anthropic';
import { ensureDaemon, tryConnect } from '../../src/core/daemon-client';

/**
 * Drives the real renderer in headless Chromium against the real daemon (through the dev bridge),
 * with a mock Anthropic API behind it. Screenshots land in $JAFFER_SHOTS (default: a temp dir).
 */
const root = path.resolve(__dirname, '../..');
const shots = process.env.JAFFER_SHOTS ?? path.join(process.env.TMPDIR ?? '/tmp', 'jaffer-shots');
const CHROME = [process.env.JAFFER_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => p && fs.existsSync(p));

let env: TestEnv;
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
  mock = new MockAnthropic();
  const mockUrl = await mock.listen();
  bridge = spawn(process.execPath, [path.join(root, 'dist/dev/bridge.cjs')], {
    env: { ...process.env, JAFFER_HOME: env.home, HOME: env.userHome, SHELL: '/bin/bash', ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000', ANTHROPIC_BASE_URL: mockUrl, JAFFER_BRIDGE_TOKEN: 'tok' },
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
  it('shows first-run consent, then the terminal', async () => {
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.onboard', { timeout: 20_000 });
    await shot('01-onboarding');
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.onboard', { state: 'detached' });
    await page.waitForSelector('.term .xterm');
    const cfg = await page.evaluate(() => window.jaffer.call('config.get'));
    expect(cfg.onboarded).toBe(true);
    expect(cfg.memory.enabled).toBe(true);
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
  }, 30_000);

  it('settings dialog opens and reflects the configuration', async () => {
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    expect(await page.textContent('.settings')).toContain('Claude Code');
    await shot('08-settings');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  });

  it('splits the terminal into a second pane that shares the session', async () => {
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).__menu('split-right'));
    await page.waitForSelector('.split.row');
    await until(async () => (await page.$$('.term .xterm')).length === 2, 10_000, 'two terminals');
    await shot('09-split');
    const panes = await page.evaluate(() => window.jaffer.call('pane.list'));
    expect(panes).toHaveLength(2);
  }, 30_000);

  it('reconnecting the page restores the same session (nothing was lost)', async () => {
    const before = await page.evaluate(() => window.jaffer.call('pane.list'));
    await page.goto(`${url}?debug=1&renderer=${process.env.JAFFER_RENDERER ?? 'dom'}`);
    await page.waitForSelector('.term .xterm');
    await until(async () => /hello-from-the-ui/.test(await termText()), 15_000, 'restored screen');
    const after = await page.evaluate(() => window.jaffer.call('pane.list'));
    expect(after.map((p: any) => p.pid)).toEqual(before.map((p: any) => p.pid));
    // and the agent conversation is still there (open the agent panel if the memory panel was showing)
    if (!(await page.$('.thread'))) await page.click('.titlebar .icon-btn[title^="Agent"]');
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
});

void ensureDaemon;
