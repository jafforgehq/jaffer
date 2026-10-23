import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertJafferHome } from '../core/reset';
import { VOICE_FILES, type VoiceFile } from '../shared/voice-manifest';

/**
 * The only network code for voice: downloads the pinned model files over HTTPS from a fixed host
 * list, checks each SHA-256, and writes them under `dir` (`~/.jaffer/voice`, mode 0700). Takes `dir`
 * as an argument and imports no Electron. No retry loop; any failure removes the partial file.
 */
export class VoiceDownloadError extends Error {
  constructor(public code: 'network' | 'checksum' | 'host' | 'aborted' | 'disk', message: string) { super(message); }
}

const MAX_HOPS = 3;
const target = (dir: string, name: string) => path.join(dir, name);
const inManifest = (files: readonly VoiceFile[], name: string) => files.find((f) => f.name === name);

async function sha256(file: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(file)).digest('hex'); } catch { return null; }
}

export async function voiceStatus(dir: string, files: readonly VoiceFile[] = VOICE_FILES): Promise<{ complete: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const f of files) {
    let ok = false;
    try { ok = (await stat(target(dir, f.name))).size === f.bytes; } catch { /* absent */ }
    if (!ok) missing.push(f.name);
  }
  return { complete: missing.length === 0, missing };
}

/** Fixed policy: Hugging Face and its `.hf.co` CDN edges (they vary by region). The pinned SHA-256 carries integrity. */
const hubHost = (h: string) => h === 'huggingface.co' || h.endsWith('.hf.co');

function checkHost(url: string, hosts: readonly string[] | undefined): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new VoiceDownloadError('host', 'Bad address.'); }
  if (u.protocol !== 'https:' || u.username || u.password || !(hosts ? hosts.includes(u.host) : hubHost(u.hostname)) || u.port) throw new VoiceDownloadError('host', `Refused host ${u.host || url.slice(0, 80)}.`);
  return u;
}

async function fetchFollow(url: string, o: { fetchImpl: typeof fetch; hosts: readonly string[] | undefined; signal: AbortSignal }): Promise<Response> {
  let cur = checkHost(url, o.hosts).href;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await o.fetchImpl(cur, { redirect: 'manual', signal: o.signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new VoiceDownloadError('network', 'Redirect without a place.');
      cur = checkHost(new URL(loc, cur).href, o.hosts).href;
      continue;
    }
    if (!res.ok || !res.body) throw new VoiceDownloadError('network', `Download answered ${res.status}.`);
    return res;
  }
  throw new VoiceDownloadError('network', 'Too many redirects.');
}

type Opts = { fetchImpl: typeof fetch; hosts: readonly string[] | undefined; signal: AbortSignal; add(n: number): void; createStream: (file: string) => Writable };

/** A write error (ENOSPC on a full disk) as code `disk`: it must never be taken for the network. */
const diskError = (e: unknown) => new VoiceDownloadError('disk', e instanceof Error ? e.message : 'Could not write the file.');

async function fetchOne(dir: string, f: VoiceFile, o: Opts): Promise<void> {
  const dest = target(dir, f.name);
  const part = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    const res = await fetchFollow(f.url, o);
    const hash = createHash('sha256');
    const out = o.createStream(part);
    const done = new Promise<void>((ok, bad) => { out.on('finish', ok); out.on('error', (e) => bad(diskError(e))); });
    done.catch(() => {}); // (awaited below only on the happy path; a write error is also raised by the drain wait)
    const reader = res.body!.getReader();
    const stop = () => { void reader.cancel().catch(() => {}); };
    o.signal.addEventListener('abort', stop, { once: true });
    let got = 0;
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) { if (o.signal.aborted) throw new Error('aborted'); break; }
        got += value.length;
        // A body longer than the manifest says can never match: stop before writing a byte past the size.
        if (got > f.bytes) throw new VoiceDownloadError('checksum', `${f.name} was longer than expected.`);
        hash.update(value);
        o.add(value.length);
        if (out.destroyed) throw diskError(out.errored);
        // Drain, a write error (the stream is destroyed and never drains) or the abort, whichever comes first: `once` rejects on
        // 'error' and on the signal, so a full disk or a cancel can never leave this wait (and the off switch behind it) hanging.
        if (!out.write(value)) await once(out, 'drain', { signal: o.signal }).catch((e) => { throw o.signal.aborted ? e : diskError(e); });
      }
      out.end();
      await done;
    } catch (e) { out.destroy(); void reader.cancel().catch(() => {}); throw e; } finally { o.signal.removeEventListener('abort', stop); }
    if (hash.digest('hex') !== f.sha256) throw new VoiceDownloadError('checksum', `${f.name} did not match its checksum.`);
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    if (o.signal.aborted) throw new VoiceDownloadError('aborted', 'Download stopped.');
    if (e instanceof VoiceDownloadError) throw e;
    throw new VoiceDownloadError('network', e instanceof Error ? e.message : 'Download failed.');
  }
}

export async function downloadVoice(dir: string, opts: {
  onProgress(done: number, total: number): void; signal: AbortSignal;
  fetchImpl?: typeof fetch; files?: readonly VoiceFile[]; hosts?: readonly string[];
  /** Tests only: stands in for the `.part` file's write stream. */
  createStream?: (file: string) => Writable;
}): Promise<void> {
  const files = opts.files ?? VOICE_FILES;
  const hosts = opts.hosts; // undefined: the fixed Hub policy above
  const fetchImpl = opts.fetchImpl ?? fetch;
  const createStream = opts.createStream ?? ((file: string) => createWriteStream(file, { mode: 0o600 }));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  let done = 0;
  const add = (n: number) => { done += n; opts.onProgress(done, total); };
  // Finished, verified files stay on abort or failure (a later run skips them by hash); only .part goes.
  for (const f of files) {
    if (opts.signal.aborted) throw new VoiceDownloadError('aborted', 'Download stopped.');
    if ((await sha256(target(dir, f.name))) === f.sha256) { add(f.bytes); continue; }
    await fetchOne(dir, f, { fetchImpl, hosts, signal: opts.signal, add, createStream });
  }
}

/** Bytes of one manifest file; refuses a name the manifest does not list and a size that differs. */
export async function readVoiceFile(dir: string, name: string, files: readonly VoiceFile[] = VOICE_FILES): Promise<Uint8Array> {
  const f = inManifest(files, name);
  if (!f) throw new Error('Not a voice file.');
  const buf = await readFile(target(dir, f.name));
  if (buf.length !== f.bytes) throw new Error('Voice file has the wrong size.');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** `rm -rf` is only ever pointed at `<Jaffer home>/voice`: the name is `voice` and the parent passes `assertJafferHome` (throws otherwise). */
export function assertVoiceDir(dir: string, userHome: string): string {
  const d = path.resolve(dir);
  if (path.basename(d) !== 'voice') throw new Error('Not the voice folder.');
  assertJafferHome(path.dirname(d), userHome);
  return d;
}

export async function removeVoice(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
