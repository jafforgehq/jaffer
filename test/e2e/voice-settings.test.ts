import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../helpers/env';
import { tryConnect } from '../../src/core/daemon-client';

/** Settings → Privacy and permissions → "Talk with Claude by voice": consent, progress, cancel on switch-off. Fake `window.jaffer.voice`; no network. */
const root = path.resolve(__dirname, '../..');
const CHROME = [process.env.JAFFER_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => p && fs.existsSync(p));

let env: TestEnv;
let bridge: ChildProcess;
let browser: Browser;
let page: Page;
let url = '';

const onDisk = () => JSON.parse(fs.readFileSync(env.paths.config, 'utf8'));
async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 10_000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Replaces the bridge's voice stand-in with one that logs its calls in `window.__v` and answers as the test says. */
const fakeVoice = (complete: boolean) =>
  page.evaluate((c) => {
    const w = window as any;
    w.__v = { calls: [], complete: c, downloadMode: 'hang' };
    w.jaffer.voice = {
      status: async () => (w.__v.calls.push('status'), { complete: w.__v.complete, missing: [] }),
      download: async () => {
        w.__v.calls.push('download');
        if (w.__v.downloadMode === 'hang') await new Promise<void>((res) => (w.__v.release = res));
      },
      cancel: async () => (w.__v.calls.push('cancel'), w.__v.release?.()),
      file: async () => new Uint8Array(),
      remove: async () => (w.__v.calls.push('remove'), (w.__v.complete = false)),
    };
  }, complete);

async function openPrivacy(): Promise<void> {
  await page.keyboard.press('Meta+,');
  await page.waitForSelector('.settings');
  await page.click('.settings-nav button:has-text("Privacy")');
  await page.waitForSelector('#pv-voice');
}

beforeAll(async () => {
  expect(CHROME, 'a Chromium binary is required (set JAFFER_CHROME)').toBeTruthy();
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'ignore' });
  env = makeEnv();
  fs.mkdirSync(env.home, { recursive: true });
  fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, tips: { enabled: false }, tour: { done: true } }));
  bridge = spawn(process.execPath, [path.join(root, 'dist/dev/bridge.cjs')], {
    env: { ...process.env, JAFFER_HOME: env.home, HOME: env.userHome, SHELL: '/bin/bash', JAFFER_BRIDGE_TOKEN: 'tok' },
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
  page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  await page.goto(`${url}?renderer=dom`);
  await page.waitForSelector('.terminal-area', { timeout: 20_000 });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  bridge?.kill();
  const c = await tryConnect(env.paths);
  await c?.call('app.shutdown', {}).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  env?.cleanup();
});

describe('Settings → Privacy → voice', () => {
  it('asks first (size, microphone, reply reading); Cancel changes nothing; Download and turn on patches, shows progress, ready', async () => {
    await fakeVoice(false);
    await openPrivacy();
    await page.click('#pv-voice');
    const ask = (await page.textContent('.vc-ask'))!;
    expect(ask).toMatch(/about 175 MB/);
    expect(ask).toMatch(/microphone is used only while you dictate with \/voice/);
    expect(ask).toMatch(/reply text.*on this Mac/);
    expect(await page.isChecked('#pv-voice')).toBe(false); // not on until confirmed
    await page.click('.vc-ask button:has-text("Cancel")');
    expect(await page.locator('.vc-ask').count()).toBe(0);
    expect(onDisk().permissions?.voice ?? false).toBe(false);
    expect(await page.evaluate(() => (window as any).__v.calls)).not.toContain('download');

    await page.click('#pv-voice');
    await page.click('.vc-go');
    await until(async () => onDisk().permissions?.voice === true, 5000, 'permissions.voice on disk');
    await until(async () => page.evaluate(() => (window as any).__v.calls.includes('download')), 5000, 'download called');
    await page.evaluate(() => (window as any).__event('voice.progress', { done: 50, total: 200 }));
    await page.waitForSelector('.vc-status[data-state="downloading"]');
    expect(await page.textContent('.vc-status')).toContain('25%');
    expect(await page.getAttribute('.vc-bar', 'aria-valuenow')).toBe('25');
    await page.evaluate(() => { (window as any).__v.complete = true; (window as any).__event('voice.done', {}); });
    await page.waitForSelector('.vc-status[data-state="ready"]');
    await page.waitForSelector('.vc-remove');
  });

  it('turning it off while downloading calls cancel and patches false; a failure shows a sentence and Retry', async () => {
    await page.evaluate(() => { (window as any).__v.calls.length = 0; (window as any).__event('voice.progress', { done: 10, total: 200 }); });
    await page.waitForSelector('.vc-status[data-state="downloading"]');
    await page.click('#pv-voice'); // on -> off
    await until(async () => onDisk().permissions?.voice === false, 5000, 'permissions.voice off on disk');
    const calls = await page.evaluate(() => (window as any).__v.calls as string[]);
    expect(calls).toContain('cancel');
    await until(async () => (await page.locator('.vc-status').count()) === 0, 3000, 'status gone');

    // on again, the download fails
    await page.click('#pv-voice');
    await page.click('.vc-go');
    await until(async () => onDisk().permissions?.voice === true, 5000, 'on again');
    await page.waitForSelector('.vc-status[data-state="downloading"]');
    await page.evaluate(() => (window as any).__event('voice.error', { code: 'checksum' }));
    await page.waitForSelector('.vc-status[data-state="error"]');
    expect(await page.textContent('.vc-err')).toMatch(/did not match/);
    await page.click('.vc-retry');
    await until(async () => page.evaluate(() => (window as any).__v.calls.filter((c: string) => c === 'download').length >= 2), 5000, 'retry downloads');
  });

  it('a download that main skipped without an event ends in an error, never "downloading" for ever; Remove voice files removes', async () => {
    await page.evaluate(() => { const v = (window as any).__v; v.release?.(); v.downloadMode = 'skip'; v.complete = false; });
    await page.evaluate(() => (window as any).jaffer.call('config.patch', { permissions: { voice: false } }));
    await until(async () => (await page.locator('.vc-status').count()) === 0, 3000, 'status gone');
    await page.click('#pv-voice');
    await page.click('.vc-go');
    await page.waitForSelector('.vc-status[data-state="error"]', { timeout: 8000 });
    // files present: a skipped download is simply ready
    await page.evaluate(() => { (window as any).__v.complete = true; });
    await page.click('.vc-retry');
    await page.waitForSelector('.vc-status[data-state="ready"]', { timeout: 8000 });
    await page.click('.vc-remove');
    await until(async () => page.evaluate(() => (window as any).__v.calls.includes('remove')), 5000, 'remove called');
    await page.waitForSelector('.vc-remove', { state: 'detached' });
    await page.waitForSelector('.vc-status[data-state="needs-download"] .vc-download'); // switch still on: Download stays offered
  });

  it('voice on in the config but files missing: a Download button, no new question, then progress', async () => {
    await page.evaluate(() => (window as any).jaffer.call('config.patch', { permissions: { voice: true } }));
    await page.goto(`${url}?renderer=dom`);
    await page.waitForSelector('.terminal-area');
    await fakeVoice(false);
    await page.evaluate(() => { (window as any).__v.downloadMode = 'hang'; });
    await openPrivacy();
    await page.waitForSelector('.vc-status[data-state="needs-download"] .vc-download');
    await page.click('.vc-download');
    expect(await page.locator('.vc-ask').count()).toBe(0);
    await until(async () => page.evaluate(() => (window as any).__v.calls.includes('download')), 5000, 'download called');
    await page.evaluate(() => (window as any).__event('voice.progress', { done: 100, total: 200 }));
    await page.waitForSelector('.vc-status[data-state="downloading"]');
    expect(await page.textContent('.vc-status')).toContain('50%');
  });
});
