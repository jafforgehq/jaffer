import { describe, expect, it } from 'vitest';
import { resumeAction, resumeLine, shellQuote } from '../src/shared/resume-action';

const ID = '01234567-89ab-4cde-8f01-23456789abcd';
const DIR = '/Users/maya/code/api';
const why = (r: ReturnType<typeof resumeAction>) => ('why' in r ? r.why : '');

describe('resume a past conversation (1.1.1): what a click types, or copies and why', () => {
  it('shellQuote: single quotes, a quote inside written as \'\\\'\'', () => {
    expect(shellQuote('/a b')).toBe("'/a b'");
    expect(shellQuote("/it's")).toBe("'/it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });

  it('idle, same folder: Ctrl-E Ctrl-U Ctrl-X Ctrl-K (the whole line goes, wherever the cursor is, and zsh\'s whole buffer), `claude --resume <id>`, Enter', () => {
    expect(resumeAction({ cwd: DIR, busy: null }, { id: ID, cwd: DIR })).toEqual({ kind: 'type', text: `\x05\x15\x18\x0bclaude --resume ${ID}\r` });
    expect(resumeAction({ cwd: DIR }, { id: ID, cwd: DIR })).toEqual({ kind: 'type', text: `\x05\x15\x18\x0bclaude --resume ${ID}\r` });
  });

  it('idle, another folder: `cd \'<folder>\' && claude --resume <id>`, the folder single-quoted (spaces, quotes, $, backticks stay inert)', () => {
    expect(resumeAction({ cwd: '/tmp', busy: '' }, { id: ID, cwd: DIR })).toEqual({ kind: 'type', text: `\x05\x15\x18\x0bcd '${DIR}' && claude --resume ${ID}\r` });
    expect(resumeAction({ cwd: '/tmp' }, { id: ID, cwd: "/Users/maya/it's a dir" })).toEqual({ kind: 'type', text: `\x05\x15\x18\x0bcd '/Users/maya/it'\\''s a dir' && claude --resume ${ID}\r` });
    expect(resumeAction({ cwd: '/tmp' }, { id: ID, cwd: '/x/$(touch y)`z`' })).toEqual({ kind: 'type', text: `\x05\x15\x18\x0bcd '/x/$(touch y)\`z\`' && claude --resume ${ID}\r` });
    expect(resumeAction({ cwd: '' }, { id: ID, cwd: DIR }).kind).toBe('type'); // (the shell's folder not known yet: the cd is harmless)
  });

  it('Claude running: nothing typed, the command copied, and why', () => {
    for (const busy of ['claude', 'claude --resume x', '/usr/local/bin/claude -c', 'FOO=1 claude']) {
      expect(resumeAction({ cwd: DIR, busy }, { id: ID, cwd: DIR }), busy).toEqual({ kind: 'copy', text: `claude --resume ${ID}`, why: 'Claude is already running here: quit it first (/exit)' });
    }
    expect(resumeAction({ cwd: '/tmp', busy: 'claude' }, { id: ID, cwd: DIR })).toEqual({ kind: 'copy', text: `cd '${DIR}' && claude --resume ${ID}`, why: 'Claude is already running here: quit it first (/exit)' });
  });

  it('another command running: nothing typed, the command copied, the command named (redacted; a sensitive one not named)', () => {
    expect(resumeAction({ cwd: DIR, busy: 'npm run dev' }, { id: ID, cwd: DIR })).toEqual({ kind: 'copy', text: `claude --resume ${ID}`, why: 'npm run dev is running: command copied' });
    const r = resumeAction({ cwd: DIR, busy: 'export GITHUB_TOKEN=abc12345xyz && make' }, { id: ID, cwd: DIR });
    expect(r.kind).toBe('copy');
    expect(why(r)).not.toContain('abc12345xyz');
    expect(why(r)).toMatch(/is running: command copied$/);
    const s = resumeAction({ cwd: DIR, busy: 'ssh-keygen -t ed25519' }, { id: ID, cwd: DIR });
    expect(why(s)).toBe('A command is running: command copied');
    expect(why(resumeAction({ cwd: DIR, busy: 'command' }, { id: ID, cwd: DIR }))).toBe('A command is running: command copied'); // (the shell gave no command text)
    expect(why(resumeAction({ cwd: DIR, busy: `make ${'x'.repeat(200)}` }, { id: ID, cwd: DIR })).length).toBeLessThanOrEqual(80);
  });

  it('no folder, or an odd one (relative, a newline or other control character, over 4096): only `claude --resume <id>` is copied', () => {
    for (const cwd of [undefined, '', 'relative/dir', '/a\nb', '/a\rb', '/a\x1bb', '/a\x9bb', '/a\x7fb', `/${'a'.repeat(4096)}`, 42 as never]) {
      expect(resumeAction({ cwd: DIR }, { id: ID, cwd }), JSON.stringify(cwd)).toEqual({ kind: 'copy', text: `claude --resume ${ID}`, why: 'Folder unknown: command copied' });
    }
    expect(resumeAction({ cwd: DIR }, { id: ID, cwd: `/${'a'.repeat(4095)}` }).kind).toBe('type');
  });

  it('a folder with a backslash is unknown too (it never goes on a command line): only `claude --resume <id>` is copied', () => {
    for (const cwd of ["/tmp/a\\';id;#", '/tmp/a\\', '/tmp/x\\ny']) {
      expect(resumeAction({ cwd: '/tmp' }, { id: ID, cwd }), cwd).toEqual({ kind: 'copy', text: `claude --resume ${ID}`, why: 'Folder unknown: command copied' });
      expect(resumeLine({ cwd: '/tmp' }, { id: ID, cwd })).toBe(`claude --resume ${ID}`);
    }
  });

  it('a bad id: nothing typed, nothing copied', () => {
    for (const id of ['', 'abc', `${ID}; rm -rf ~`, `${ID}\n`, '$(touch x)', 7 as never]) {
      expect(resumeAction({ cwd: DIR }, { id, cwd: DIR }), JSON.stringify(id)).toEqual({ kind: 'none', why: 'That conversation has no valid id.' });
      expect(resumeLine({ cwd: DIR }, { id, cwd: DIR })).toBeNull();
    }
  });

  it('resumeLine (the copy button): the same command as a click would run, never the clearing keys or Enter', () => {
    expect(resumeLine({ cwd: DIR }, { id: ID, cwd: DIR })).toBe(`claude --resume ${ID}`);
    expect(resumeLine({ cwd: '/tmp', busy: 'claude' }, { id: ID, cwd: DIR })).toBe(`cd '${DIR}' && claude --resume ${ID}`);
    expect(resumeLine({ cwd: '/tmp' }, { id: ID, cwd: '/a\nb' })).toBe(`claude --resume ${ID}`);
  });

  it('1 MB and 8 MB command lines and folders are read only to a head, quickly', () => {
    for (const n of [1, 8]) {
      const huge = 'a '.repeat((n * 1024 * 1024) / 2);
      const t0 = performance.now();
      expect(resumeAction({ cwd: DIR, busy: `claude ${huge}` }, { id: ID, cwd: DIR }).kind).toBe('copy');
      expect(why(resumeAction({ cwd: DIR, busy: `make ${huge}` }, { id: ID, cwd: DIR })).length).toBeLessThanOrEqual(80);
      expect(why(resumeAction({ cwd: `/${huge}` }, { id: ID, cwd: `/${'b'.repeat(n * 1024 * 1024)}` }))).toBe('Folder unknown: command copied');
      expect(resumeAction({ cwd: `/${huge}` }, { id: ID, cwd: DIR }).kind).toBe('type');
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});
