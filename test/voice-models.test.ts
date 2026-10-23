import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceFile } from '../src/shared/voice-manifest';
import { VoiceDownloadError, downloadVoice, readVoiceFile, removeVoice, voiceStatus } from '../src/main/voice-models';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const A = Buffer.from('alpha-bytes');
const B = Buffer.from('bravo-bytes-longer');
const file = (name: string, b: Buffer, host = 'good.test'): VoiceFile => ({ name, url: `https://${host}/${name}`, sha256: sha(b), bytes: b.length });
const FILES = [file('a.bin', A), file('sub/b.bin', B)];
const HOSTS = ['good.test', 'cdn.good.test'];
const BODY: Record<string, Buffer> = { 'https://good.test/a.bin': A, 'https://good.test/sub/b.bin': B };

let dir: string;
beforeEach(async () => { dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'jaffer-voice-')), 'voice'); });
afterEach(async () => { await rm(path.dirname(dir), { recursive: true, force: true }); });

const okFetch = (calls: string[] = []): typeof fetch => (async (url: string | URL | Request) => {
  const u = String(url); calls.push(u);
  const b = BODY[u];
  return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response('no', { status: 404 });
}) as typeof fetch;
const opts = (fetchImpl: typeof fetch, extra = {}) => ({ onProgress() {}, signal: new AbortController().signal, fetchImpl, files: FILES, hosts: HOSTS, ...extra });
const code = async (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof VoiceDownloadError ? e.code : String(e)));

describe('voice models', () => {
  it('downloads and verifies every file', async () => {
    const seen: number[] = [];
    await downloadVoice(dir, opts(okFetch(), { onProgress: (d: number) => seen.push(d) }));
    expect(await voiceStatus(dir, FILES)).toEqual({ complete: true, missing: [] });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(seen.at(-1)).toBe(A.length + B.length);
    expect((await readdir(dir, { recursive: true })).some((n) => n.endsWith('.part'))).toBe(false);
  }, 20000);

  it('tightens an existing loose folder to 0700', async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o777);
    await downloadVoice(dir, opts(okFetch()));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('default host policy: hub and .hf.co edges only, https, no userinfo', async () => {
    const via = (to: string) => {
      const f = (async (u: string | URL | Request) => String(u) === 'https://huggingface.co/a.bin'
        ? new Response(null, { status: 302, headers: { location: to } })
        : new Response(new Uint8Array(A), { status: 200 })) as typeof fetch;
      return downloadVoice(dir, { onProgress() {}, signal: new AbortController().signal, fetchImpl: f, files: [file('a.bin', A, 'huggingface.co')] });
    };
    await via('https://cas-bridge.xethub.hf.co/x');
    await removeVoice(dir);
    for (const bad of ['https://huggingface.co.evil.com/x', 'https://evilhf.co/x', 'https://hf.co.evil.com/x', 'http://cas-bridge.xethub.hf.co/x', 'https://u:p@cas-bridge.xethub.hf.co/x', 'https://huggingface.co@evil.com/x']) {
      await removeVoice(dir);
      expect(await code(via(bad)), bad).toBe('host');
    }
  });

  it('a checksum mismatch deletes the file and throws code checksum', async () => {
    const bad = (async () => new Response(new Uint8Array(Buffer.from('xxxxxxxxxxx')), { status: 200 })) as typeof fetch;
    expect(await code(downloadVoice(dir, opts(bad)))).toBe('checksum');
    expect((await voiceStatus(dir, FILES)).complete).toBe(false);
    expect((await readdir(dir, { recursive: true })).filter((n) => n.endsWith('.bin') || n.endsWith('.part'))).toEqual([]);
  });

  it('a host outside the list throws code host, also for redirect hops', async () => {
    expect(await code(downloadVoice(dir, opts(okFetch(), { files: [file('a.bin', A, 'evil.test')] })))).toBe('host');
    const redir = (to: string) => (async () => new Response(null, { status: 302, headers: { location: to } })) as typeof fetch;
    expect(await code(downloadVoice(dir, opts(redir('https://evil.test/x'))))).toBe('host');
    expect(await code(downloadVoice(dir, opts(redir('http://cdn.good.test/x'))))).toBe('host');
    // allowed hop works
    const hop = (async (u: string | URL | Request) => String(u).startsWith('https://good.test/')
      ? new Response(null, { status: 302, headers: { location: `https://cdn.good.test/z/${String(u).split('/').pop()}` } })
      : new Response(new Uint8Array(String(u).endsWith('a.bin') ? A : B), { status: 200 })) as typeof fetch;
    await downloadVoice(dir, opts(hop));
    expect((await voiceStatus(dir, FILES)).complete).toBe(true);
  });

  it('abort removes partial files and throws code aborted', async () => {
    const ac = new AbortController();
    const slow = (async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([1, 2, 3])); setTimeout(() => ac.abort(), 10); },
    }), { status: 200 })) as typeof fetch;
    expect(await code(downloadVoice(dir, opts(slow, { signal: ac.signal })))).toBe('aborted');
    expect((await readdir(dir, { recursive: true })).filter((n) => n.endsWith('.part') || n.endsWith('.bin'))).toEqual([]);
  });

  // F1: a write error (ENOSPC) destroys the stream and it never drains; the wait must not hang the download (and the off switch).
  it('a write error rejects with code disk, removes the .part and does not hang', async () => {
    const createStream = (file: string) => {
      writeFileSync(file, 'x'); // (a .part exists, as with the real stream)
      return new Writable({ highWaterMark: 1, write(_c, _e, cb) { cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); } });
    };
    expect(await code(downloadVoice(dir, opts(okFetch(), { createStream })))).toBe('disk');
    expect((await readdir(dir, { recursive: true })).filter((n) => n.endsWith('.part') || n.endsWith('.bin'))).toEqual([]);
  }, 3000);

  it('an abort during a stalled drain settles as aborted and removes the .part', async () => {
    const ac = new AbortController();
    const createStream = (file: string) => {
      writeFileSync(file, 'x');
      setTimeout(() => ac.abort(), 20);
      return new Writable({ highWaterMark: 1, write() { /* never calls back: the stream never drains */ } });
    };
    expect(await code(downloadVoice(dir, opts(okFetch(), { createStream, signal: ac.signal })))).toBe('aborted');
    expect((await readdir(dir, { recursive: true })).filter((n) => n.endsWith('.part') || n.endsWith('.bin'))).toEqual([]);
  }, 3000);

  // I6: a body longer than the manifest's size is refused as soon as it passes the size, before a byte past it is written.
  it('a body longer than the declared size is refused without writing past it', async () => {
    let written = 0;
    const createStream = (file: string) => { writeFileSync(file, ''); return new Writable({ write(c, _e, cb) { written += c.length; cb(); } }); };
    let pulls = 0; // (64 chunks of 4 bytes: far past A's size, but finite so a failing run still ends)
    const endless = (async () => new Response(new ReadableStream({ pull(c) { if (++pulls > 64) c.close(); else c.enqueue(new Uint8Array(4)); } }), { status: 200 })) as typeof fetch;
    expect(await code(downloadVoice(dir, opts(endless, { createStream })))).toBe('checksum');
    expect(written).toBeLessThanOrEqual(A.length);
    expect((await readdir(dir, { recursive: true })).filter((n) => n.endsWith('.part') || n.endsWith('.bin'))).toEqual([]);
  }, 3000);

  it('readVoiceFile refuses unknown names and wrong sizes', async () => {
    await downloadVoice(dir, opts(okFetch()));
    expect(Buffer.from(await readVoiceFile(dir, 'a.bin', FILES)).equals(A)).toBe(true);
    await expect(readVoiceFile(dir, '../x', FILES)).rejects.toThrow();
    await expect(readVoiceFile(dir, '/etc/passwd', FILES)).rejects.toThrow();
    await writeFile(path.join(dir, 'a.bin'), 'short');
    await expect(readVoiceFile(dir, 'a.bin', FILES)).rejects.toThrow();
  });

  it('a file already present with the right hash is not fetched again', async () => {
    await downloadVoice(dir, opts(okFetch()));
    const calls: string[] = [];
    await downloadVoice(dir, opts(okFetch(calls)));
    expect(calls).toEqual([]);
    await writeFile(path.join(dir, 'a.bin'), 'corrupt-same-len');
    await downloadVoice(dir, opts(okFetch(calls)));
    expect(calls).toEqual(['https://good.test/a.bin']);
  });

  it('removeVoice deletes the folder', async () => {
    await mkdir(dir, { recursive: true });
    await removeVoice(dir);
    await expect(stat(dir)).rejects.toThrow();
  });
});
