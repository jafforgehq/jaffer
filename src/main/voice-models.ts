import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { VOICE_FILES, VOICE_HOSTS, type VoiceFile } from '../shared/voice-manifest';

/**
 * The only network code for voice: downloads the pinned model files over HTTPS from a fixed host
 * list, checks each SHA-256, and writes them under `dir` (`~/.jaffer/voice`, mode 0700). Takes `dir`
 * as an argument and imports no Electron. No retry loop; any failure removes the partial file.
 */
export class VoiceDownloadError extends Error {
  constructor(public code: 'network' | 'checksum' | 'host' | 'aborted', message: string) { super(message); }
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

function checkHost(url: string, hosts: readonly string[]): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new VoiceDownloadError('host', 'Bad address.'); }
  if (u.protocol !== 'https:' || !hosts.includes(u.host)) throw new VoiceDownloadError('host', `Refused host ${u.host}.`);
  return u;
}

async function fetchFollow(url: string, o: { fetchImpl: typeof fetch; hosts: readonly string[]; signal: AbortSignal }): Promise<Response> {
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

async function fetchOne(dir: string, f: VoiceFile, o: { fetchImpl: typeof fetch; hosts: readonly string[]; signal: AbortSignal; add(n: number): void }): Promise<void> {
  const dest = target(dir, f.name);
  const part = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    const res = await fetchFollow(f.url, o);
    const hash = createHash('sha256');
    const out = createWriteStream(part, { mode: 0o600 });
    const done = new Promise<void>((ok, bad) => { out.on('finish', ok); out.on('error', bad); });
    const reader = res.body!.getReader();
    const stop = () => { void reader.cancel().catch(() => {}); };
    o.signal.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) { if (o.signal.aborted) throw new Error('aborted'); break; }
        hash.update(value);
        o.add(value.length);
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      out.end();
      await done;
    } catch (e) { out.destroy(); throw e; } finally { o.signal.removeEventListener('abort', stop); }
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
}): Promise<void> {
  const files = opts.files ?? VOICE_FILES;
  const hosts = opts.hosts ?? VOICE_HOSTS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const total = files.reduce((n, f) => n + f.bytes, 0);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  let done = 0;
  const add = (n: number) => { done += n; opts.onProgress(done, total); };
  // Finished, verified files stay on abort or failure (a later run skips them by hash); only .part goes.
  for (const f of files) {
    if (opts.signal.aborted) throw new VoiceDownloadError('aborted', 'Download stopped.');
    if ((await sha256(target(dir, f.name))) === f.sha256) { add(f.bytes); continue; }
    await fetchOne(dir, f, { fetchImpl, hosts, signal: opts.signal, add });
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

export async function removeVoice(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
