import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../helpers/env';
import { tryConnect } from '../../src/core/daemon-client';

/**
 * Dictation (Task 8): after /voice the microphone opens when Claude is idle, the recording is transcribed and typed into Claude's prompt
 * without Enter, or copied with the reason. Fake microphone (getUserMedia, AudioContext and the worklet node: the frames are posted
 * by the test), fake worker (Whisper answers what the test set), no audio models, no network.
 */
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
const claude = (state: string) => page.evaluate((s) => (window as any).__event('claude.state', { sessions: [{ id: 'dict-1', state: s, since: Date.now(), startedAt: Date.now(), turns: 1, calls: [], counts: {}, files: [] }] }), state);
const finishTurn = async () => { await claude('working'); await claude('idle'); };
/** Runs `fn(window)` in the page. */
const W = <T,>(fn: (w: any) => T) => page.evaluate(`(${fn.toString()})(window)`) as Promise<T>;
const writes = () => W((w) => (w.__w.writes as Array<{ pane: string; data: string }>).slice());
const mode = (m: string) => page.waitForSelector(`.voice-line[data-mode="${m}"]`, { timeout: 8000 });
/** Speech, then 1.5 s of quiet: the fake worklet posts 3 loud and 13 quiet frames of 128 ms. */
const speak = (text: string) => page.evaluate((t) => { const w = (window as any).__w; w.heard = t; w.play(); }, text);
const toasts = async () => (await page.textContent('.toasts')) ?? '';
const runVoiceAction = async () => {
  await page.keyboard.press('Meta+p');
  await page.waitForSelector('.palette input');
  await page.keyboard.type('voice');
  await page.keyboard.press('Enter');
};

beforeAll(async () => {
  expect(CHROME, 'a Chromium binary is required (set JAFFER_CHROME)').toBeTruthy();
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'ignore' });
  env = makeEnv();
  fs.mkdirSync(env.home, { recursive: true });
  fs.writeFileSync(env.paths.config, JSON.stringify({ onboarded: true, tips: { enabled: false }, tour: { done: true }, permissions: { voice: true } }));
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.__w = { writes: [], heard: '', opened: 0, stopped: 0, hold: true, node: null, play: () => w.__w.node?.__play() };
    // the worker: loads at once; Whisper answers `heard`
    w.Worker = class {
      onmessage: any = null; onerror: any = null; onmessageerror: any = null;
      postMessage(m: any) {
        queueMicrotask(() => {
          if (m.type === 'load') this.onmessage?.({ data: { type: 'ready' } });
          else if (m.type === 'transcribe') this.onmessage?.({ data: { type: 'text', id: m.id, text: w.__w.heard } });
          else if (m.type === 'speak') this.onmessage?.({ data: { type: 'done', id: m.id } });
        });
      }
      terminate() {}
    };
    // the microphone: a stream whose track counts stops; the worklet node posts frames when the test says `play`
    navigator.mediaDevices.getUserMedia = async () => {
      w.__w.opened++;
      const track = Object.assign(new EventTarget(), { stop: () => void w.__w.stopped++ }); // (an EventTarget, like a real track: the recorder listens for 'ended')
      return { getTracks: () => [track] } as unknown as MediaStream;
    };
    w.AudioContext = class {
      sampleRate = 16000;
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      close() { return Promise.resolve(); }
    };
    w.AudioWorkletNode = class {
      port: any = { onmessage: null };
      constructor() { w.__w.node = this; }
      __play() {
        const frames = [...Array(3).fill(0.2), ...Array(13).fill(0.001)];
        const next = () => { const r = frames.shift(); if (r === undefined || !this.port.onmessage) return; this.port.onmessage({ data: { rms: r, samples: new Float32Array(2048).fill(r) } }); setTimeout(next, 2); };
        next();
      }
      disconnect() {}
    };
  });
  await page.goto(`${url}?renderer=dom&debug`);
  await page.waitForSelector('.terminal-area', { timeout: 20_000 });
  await page.evaluate(() => {
    const w = window as any;
    const orig = w.jaffer.call.bind(w.jaffer);
    w.jaffer.call = (m: string, p: any) => {
      if (m === 'pty.write') w.__w.writes.push({ pane: p?.pane, data: String(p?.data) });
      return m === 'claude.reply' ? Promise.resolve({ ok: true, text: '```sh\nnpm test\n```' }) : orig(m, p); // (code only: nothing is spoken)
    };
    w.jaffer.voice = { status: async () => ({ complete: true, missing: [] }), download: async () => {}, cancel: async () => {}, file: async () => new Uint8Array(), remove: async () => {}, mic: async () => 'granted' };
    w.__event('voice.done', {}); // (the files are ready)
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

describe('/voice dictation', () => {
  it('Claude idle at /voice: the microphone opens, "run the tests" is typed into the focused terminal exactly, with no Enter', async () => {
    await claude('idle');
    await new Promise((r) => setTimeout(r, 300));
    await runVoiceAction();
    await mode('listening');
    expect(await page.textContent('.voice-line')).toMatch(/Listening…/);
    expect(await page.locator('.titlebar .voice-line').count()).toBe(0);
    const before = (await writes()).length;
    await speak('run the tests');
    await until(async () => (await writes()).slice(before).some((x) => x.data.includes('run the tests')), 8000, 'the typed text');
    await mode('ready');
    const typed = (await writes()).slice(before);
    expect(typed).toEqual([{ pane: 'main', data: 'run the tests' }]);
    expect(typed.some((x) => /[\r\n]/.test(x.data))).toBe(false);
    expect(await W((w) => [w.__w.opened, w.__w.stopped])).toEqual([1, 1]);
  });

  it('Claude started working during the recording: the text is copied with the reason, not typed', async () => {
    await finishTurn();
    await mode('listening');
    const before = (await writes()).length;
    await claude('working');
    await speak('fix the bug');
    await until(async () => /Claude is busy or waiting for you/.test(await toasts()), 8000, 'the busy toast');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('fix the bug');
    expect((await writes()).slice(before).some((x) => x.data.includes('fix the bug'))).toBe(false);
    await mode('ready');
  });

  it('the focus moved to another terminal during the recording: copied, not typed (Review Focus 3)', async () => {
    await claude('idle'); // (working -> idle: a finished turn, the microphone opens)
    await mode('listening');
    const before = (await writes()).length;
    await page.evaluate(() => (window as any).__menu('split-terminal')); // (⌘D comes from the app menu)
    await until(async () => (await page.evaluate(() => (window as any).__jaffer.activePane())) !== 'main', 5000, 'the new terminal focused');
    await speak('open the readme');
    await until(async () => /terminal changed while you spoke/.test(await toasts()), 8000, 'the changed-terminal toast');
    expect((await writes()).slice(before).some((x) => x.data.includes('open the readme'))).toBe(false);
    await mode('ready');
    await page.evaluate(() => (window as any).__menu('focus-terminal-1'));
    await until(async () => (await page.evaluate(() => (window as any).__jaffer.activePane())) === 'main', 5000, 'main focused again');
  });

  it('Whisper noise ([BLANK_AUDIO]) types nothing, copies nothing and shows no toast', async () => {
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await page.evaluate(() => navigator.clipboard.writeText('unchanged'));
    await finishTurn();
    await mode('listening');
    const before = (await writes()).length;
    const toastCount = await page.locator('.toast').count();
    await speak('[BLANK_AUDIO]');
    await mode('ready');
    await new Promise((r) => setTimeout(r, 300));
    expect((await writes()).slice(before)).toEqual([]);
    expect(await page.locator('.toast').count()).toBe(toastCount);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('unchanged');
  });

  it('Esc during listening cancels the recording and stops the microphone; voice stays on', async () => {
    await finishTurn();
    await mode('listening');
    const stopped = await W((w) => w.__w.stopped as number);
    await page.keyboard.press('Escape');
    await mode('ready');
    await until(async () => (await W((w) => w.__w.stopped as number)) === stopped + 1, 3000, 'the track stopped');
  });

  it('turning the setting off while listening closes the microphone and voice ends', async () => {
    await finishTurn();
    await mode('listening');
    const stopped = await W((w) => w.__w.stopped as number);
    await page.evaluate(() => (window as any).jaffer.call('config.patch', { permissions: { voice: false } }));
    await page.waitForSelector('.voice-line', { state: 'detached' });
    await until(async () => (await W((w) => w.__w.stopped as number)) === stopped + 1, 3000, 'the track stopped');
  });
});
