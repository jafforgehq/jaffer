import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../helpers/env';
import { tryConnect } from '../../src/core/daemon-client';

/** /voice: the palette action, voice mode ready, a finished turn read aloud (prose only), Esc, the Now-card line. Fake worker and fake `claude.reply`; no audio models, no network. */
const root = path.resolve(__dirname, '../..');
const CHROME = [process.env.JAFFER_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => p && fs.existsSync(p));

let env: TestEnv;
let bridge: ChildProcess;
let browser: Browser;
let page: Page;
let url = '';

async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 10_000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const claude = (state: string, extra: object = {}) => page.evaluate(([s, x]) => (window as any).__event('claude.state', { sessions: [{ id: 'voice-1', state: s, since: Date.now(), startedAt: Date.now(), turns: 1, calls: [], counts: {}, files: [], ...(x as object) }] }), [state, extra] as const);
const spoken = () => page.evaluate(() => (window as any).__w.spoken as string[]);
const runVoiceAction = async () => {
  await page.keyboard.press('Meta+p');
  await page.waitForSelector('.palette input');
  await page.keyboard.type('voice');
  await page.keyboard.press('Enter');
};
const finishTurn = async () => { await claude('working'); await claude('idle'); };

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
  // the stand-ins go in before the page's scripts: a Worker that loads at once and holds every sentence until released, and a reply the test sets
  await page.addInitScript(() => {
    const w = window as any;
    w.__w = { spoken: [] as string[], release: [] as Array<() => void>, reply: 'Done.' };
    w.Worker = class {
      onmessage: any = null;
      onerror: any = null;
      onmessageerror: any = null;
      postMessage(m: any) {
        queueMicrotask(() => {
          if (m.type === 'load') this.onmessage?.({ data: { type: 'ready' } });
          else if (m.type === 'speak') { w.__w.spoken.push(m.text); w.__w.release.push(() => this.onmessage?.({ data: { type: 'done', id: m.id } })); }
        });
      }
      terminate() {}
    };
  });
  await page.goto(`${url}?renderer=dom`);
  await page.waitForSelector('.terminal-area', { timeout: 20_000 });
  await page.evaluate(() => {
    const w = window as any;
    const orig = w.jaffer.call.bind(w.jaffer);
    w.jaffer.call = (m: string, p: unknown) => (m === 'claude.reply' ? Promise.resolve({ ok: true, text: w.__w.reply }) : orig(m, p));
    w.jaffer.voice = { status: async () => ({ complete: true, missing: [] }), download: async () => {}, cancel: async () => {}, file: async () => new Uint8Array(), remove: async () => {} };
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  bridge?.kill();
  const c = await tryConnect(env.paths);
  await c?.call('app.shutdown', {}).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  env?.cleanup();
});

describe('/voice speech output', () => {
  it('with the switch off: opens Settings → Privacy and says why; no voice line, nothing new in the title bar', async () => {
    const titlebar = await page.locator('.titlebar button, .titlebar [role="button"]').count();
    await runVoiceAction();
    await page.waitForSelector('#pv-voice');
    expect(await page.textContent('.toasts')).toMatch(/Voice is off/);
    expect(await page.locator('.voice-line').count()).toBe(0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    expect(await page.locator('.titlebar button, .titlebar [role="button"]').count()).toBe(titlebar);
  });

  it('on and ready: the mode becomes ready and the Now card shows the voice line', async () => {
    await page.evaluate(() => (window as any).jaffer.call('config.patch', { permissions: { voice: true } }));
    // the two conditions /voice checks, as the page sees them: the switch on in its config and the files ready (Settings looks at the disk)
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.click('.settings-nav button:has-text("Privacy")');
    await page.waitForSelector('#pv-voice:checked');
    await page.waitForSelector('.vc-status[data-state="ready"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
    await runVoiceAction();
    await page.waitForSelector('.now-card .voice-line');
    await until(async () => /Voice on/.test((await page.textContent('.voice-line')) ?? ''), 8000, 'Voice on');
    expect(await page.locator('.titlebar .voice-line').count()).toBe(0);
  });

  it('a finished turn speaks the prose only; Esc stops the speech', async () => {
    await page.evaluate(() => { (window as any).__w.reply = 'I fixed the build. Then I ran the tests.\n```sh\nrm -rf SECRET-CODE\n```\nSee /etc/SECRET-PATH/file.txt now.'; });
    await claude('idle');
    await finishTurn();
    await until(async () => (await spoken()).length > 0, 8000, 'speak called');
    await page.waitForSelector('.voice-line[data-mode="speaking"]');
    expect((await spoken()).join(' ')).toContain('I fixed the build.');
    expect((await spoken()).join(' ')).not.toMatch(/SECRET|rm -rf|etc/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.voice-line[data-mode="ready"]');
    expect(await page.textContent('.voice-line')).toMatch(/Voice on/);
  });

  it('a code-only reply speaks nothing and shows no error', async () => {
    const n = (await spoken()).length;
    await page.evaluate(() => { (window as any).__w.reply = '```sh\nnpm test\n```'; });
    await finishTurn();
    await new Promise((r) => setTimeout(r, 600));
    expect((await spoken()).length).toBe(n);
    expect(await page.locator('.toast.error').count()).toBe(0);
    expect(await page.textContent('.voice-line')).toMatch(/Voice on/);
  });

  it('a new turn while speaking stops the speech; the Stop button too', async () => {
    await page.evaluate(() => { (window as any).__w.reply = 'First sentence here. Second one follows.'; });
    await finishTurn();
    await page.waitForSelector('.voice-line[data-mode="speaking"]');
    await claude('working');
    await page.waitForSelector('.voice-line[data-mode="ready"]');
    await claude('idle');
    await finishTurn();
    await page.waitForSelector('.voice-line[data-mode="speaking"]');
    await page.click('.voice-line button');
    await page.waitForSelector('.voice-line[data-mode="ready"]');
  });

  it('two Escs in ready leave voice mode (and the line goes)', async () => {
    await page.keyboard.press('Escape');
    expect(await page.locator('.voice-line').count()).toBe(1);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.voice-line', { state: 'detached' });
  });

  it('turning the switch off while voice is on ends it', async () => {
    await runVoiceAction();
    await page.waitForSelector('.voice-line');
    await page.evaluate(() => (window as any).jaffer.call('config.patch', { permissions: { voice: false } }));
    await page.waitForSelector('.voice-line', { state: 'detached' });
  });
});
