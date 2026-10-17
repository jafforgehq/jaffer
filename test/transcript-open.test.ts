import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTranscript, openTranscriptSync } from '../src/core/claude/transcript-open';
import { makeEnv, type TestEnv } from './helpers/env';

/** (1.4.1) The one way a transcript is opened: inside `realpath(<claudeDir>/projects)`, a regular `.jsonl` file, no link at the end. */

let env: TestEnv;
let claudeDir: string;
let projects: string;
beforeEach(() => {
  env = makeEnv();
  claudeDir = path.join(env.userHome, '.claude');
  projects = path.join(claudeDir, 'projects');
  fs.mkdirSync(path.join(projects, '-p'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.cleanup();
});

/** Opens, closes what came back, and says what it was. */
async function open(file: string): Promise<number | null> {
  const t = await openTranscript(claudeDir, file);
  const s = openTranscriptSync(claudeDir, file); // (the sync twin, for the stop-line watch, says the same)
  if (s) fs.closeSync(s.fd);
  if (!t) {
    expect(s).toBeNull();
    return null;
  }
  await t.fh.close();
  expect(s?.st.size).toBe(t.size);
  return t.size;
}

const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

describe('openTranscript', () => {
  it('opens a regular .jsonl file inside the projects folder and says its size', async () => {
    const file = path.join(projects, '-p', 'a.jsonl');
    fs.writeFileSync(file, 'abc\n');
    const t = (await openTranscript(claudeDir, file))!;
    expect(t.size).toBe(4);
    const buf = Buffer.alloc(4);
    await t.fh.read(buf, 0, 4, 0);
    expect(buf.toString()).toBe('abc\n');
    await t.fh.close();
  });

  it('refuses a path that leaves the projects folder with `..`, a file next to it, and the projects folder itself', async () => {
    fs.writeFileSync(path.join(claudeDir, 'outside.jsonl'), 'x\n');
    expect(await open(path.join(projects, '-p', '..', '..', 'outside.jsonl'))).toBeNull();
    expect(await open(path.join(claudeDir, 'outside.jsonl'))).toBeNull();
    expect(await open(projects)).toBeNull();
    fs.writeFileSync(path.join(env.root, 'elsewhere.jsonl'), 'x\n');
    expect(await open(path.join(env.root, 'elsewhere.jsonl'))).toBeNull();
  });

  it('refuses a link to a file outside the projects folder, and follows a link inside it to a real file inside', async () => {
    const out = path.join(env.root, 'secret.jsonl');
    fs.writeFileSync(out, 'secret\n');
    fs.symlinkSync(out, path.join(projects, '-p', 'out.jsonl'));
    expect(await open(path.join(projects, '-p', 'out.jsonl'))).toBeNull();
    // a link inside resolves to a real file inside: that real file is what is opened, never the link itself
    const real = path.join(projects, '-p', 'real.jsonl');
    fs.writeFileSync(real, 'ok\n');
    fs.symlinkSync(real, path.join(projects, '-p', 'in.jsonl'));
    expect(await open(path.join(projects, '-p', 'in.jsonl'))).toBe(3);
  });

  it('refuses a folder, a missing file and a file that is not a .jsonl transcript', async () => {
    fs.mkdirSync(path.join(projects, '-p', 'dir.jsonl'));
    expect(await open(path.join(projects, '-p', 'dir.jsonl'))).toBeNull();
    expect(await open(path.join(projects, '-p', 'missing.jsonl'))).toBeNull();
    fs.writeFileSync(path.join(projects, '-p', 'notes.txt'), 'x\n');
    expect(await open(path.join(projects, '-p', 'notes.txt'))).toBeNull();
    expect(await open('')).toBeNull();
  });

  it('refuses a FIFO at once (opening one would block a thread of the daemon for ever)', async () => {
    const fifo = path.join(projects, '-p', 'pipe.jsonl');
    execFileSync('mkfifo', [fifo]);
    expect(await within(open(fifo), 2_000)).toBeNull();
  });

  it('refuses everything when there is no projects folder, and follows a projects folder that is itself a link (as the list does)', async () => {
    expect(await openTranscript(path.join(env.root, 'no-claude'), path.join(env.root, 'no-claude', 'projects', '-p', 'a.jsonl'))).toBeNull();
    const realDir = path.join(env.root, 'real-claude');
    fs.mkdirSync(path.join(realDir, 'projects', '-q'), { recursive: true });
    fs.writeFileSync(path.join(realDir, 'projects', '-q', 'b.jsonl'), 'hello\n');
    const linked = path.join(env.root, 'linked-claude');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(realDir, 'projects'), path.join(linked, 'projects'));
    const t = (await openTranscript(linked, path.join(linked, 'projects', '-q', 'b.jsonl')))!;
    expect(t.size).toBe(6);
    await t.fh.close();
    // ...but a file of that real folder is not inside another Claude folder's projects
    expect(await open(path.join(realDir, 'projects', '-q', 'b.jsonl'))).toBeNull();
  });

  it('refuses a file swapped in between the check and the open (its device and inode are not those it checked)', async () => {
    const file = path.join(projects, '-p', 'a.jsonl');
    const other = path.join(projects, '-p', 'b.jsonl');
    fs.writeFileSync(file, 'abc\n');
    fs.writeFileSync(other, 'other\n');
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((_p: fs.PathLike, ...a: [never]) => realOpen(other, ...a)) as typeof fs.promises.open);
    expect(await openTranscript(claudeDir, file)).toBeNull();
    const realOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((_p: fs.PathLike, ...a: [never]) => realOpenSync(other, ...a)) as typeof fs.openSync);
    expect(openTranscriptSync(claudeDir, file)).toBeNull();
  });
});
