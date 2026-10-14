import { describe, expect, it } from 'vitest';
import { isClaudeCommand, processBadge } from '../src/shared/process-badge';

describe('processBadge: the "something is running" indicator in the toolbar and the sidebar', () => {
  it('shows nothing when no command is running', () => {
    expect(processBadge(null, undefined)).toEqual({ kind: 'none', spin: false });
  });

  it('an ordinary command that runs spins: it is working until it ends', () => {
    expect(processBadge('npm run dev', undefined)).toEqual({ kind: 'command', spin: true });
    expect(processBadge('./bin/test', 'idle')).toEqual({ kind: 'command', spin: true });
  });

  it('Claude Code is a program you sit in, not a job: it spins only while it is actually working', () => {
    expect(processBadge('claude', 'working')).toEqual({ kind: 'claude', spin: true });
    expect(processBadge('claude', 'idle')).toEqual({ kind: 'claude', spin: false });
    expect(processBadge('claude', 'needs-you')).toEqual({ kind: 'claude', spin: false }); // waiting for a person is not work
    expect(processBadge('claude', 'ended')).toEqual({ kind: 'claude', spin: false });
  });

  it('without any hook report (hooks off, or no turn yet) a running Claude does not claim to be working', () => {
    expect(processBadge('claude', undefined)).toEqual({ kind: 'claude', spin: false });
    expect(processBadge('claude --resume', undefined)).toEqual({ kind: 'claude', spin: false });
  });

  it('recognises claude as a word, not inside another name', () => {
    expect(processBadge('FOO=1 claude -c', 'working')).toEqual({ kind: 'claude', spin: true });
    expect(processBadge('claudette --serve', 'working')).toEqual({ kind: 'command', spin: true });
  });
});

describe('isClaudeCommand', () => {
  it('is Claude Code when the command is claude, with its arguments, a prefix of variables, `command`, or a path', () => {
    for (const c of ['claude', 'claude --resume', 'claude -p "fix it"', 'FOO=1 BAR=x claude -c', 'command claude', '/usr/local/bin/claude', '~/.local/bin/claude --model opus', '  claude']) expect(isClaudeCommand(c), c).toBe(true);
  });

  it('is Claude Code after exactly the `cd \'<folder>\' && ` a resume types (1.1.1), quotes in the folder written \'\\\'\'', () => {
    for (const c of ["cd '/Users/maya/code/api' && claude --resume x", "cd '/Users/maya/it'\\''s odd' && claude --resume x", "cd '/a b' && FOO=1 claude", "cd '' && claude"]) {
      expect(isClaudeCommand(c), c).toBe(true);
      expect(processBadge(c, 'working'), c).toEqual({ kind: 'claude', spin: true });
    }
    // only that exact form: not another cd, not a quote left open, not a command after the cd that is not claude
    for (const c of ['cd /a && claude', 'cd "/a" && claude', "cd '/a' ; claude", "cd '/a'&& claude", "cd '/a' && echo claude", "cd '/it's' && claude", "cd '/a' && cd '/b' && claude", " cd '/a' && claude x", "cd '/a\\' && claude"]) expect(isClaudeCommand(c), c).toBe(false);
  });

  it('is not Claude Code when a line merely mentions it', () => {
    for (const c of ['git log --grep claude', 'tail -f ~/.claude/debug.log', 'npm run claude-lint', 'claudette --serve', 'echo claude', 'cat claude.md', 'ls ~/.claude', '', 'claude-code-guide']) expect(isClaudeCommand(c), c).toBe(false);
  });

  it('so a command that only mentions claude still spins like any other command', () => {
    expect(processBadge('git log --grep claude', undefined)).toEqual({ kind: 'command', spin: true });
    expect(processBadge('tail -f ~/.claude/debug.log', 'idle')).toEqual({ kind: 'command', spin: true });
  });
});

describe('isClaudeCommand on a forged line (the terminal can say any command line, at any length, and the window reads it too)', () => {
  const MB = 1_000_000;
  const crafted: Record<string, string> = {
    'a=b ': 'a=b '.repeat((8 * MB) / 4),
    'command ': 'command '.repeat((8 * MB) / 8),
    'A=1 ... claude': 'A=1 '.repeat((8 * MB) / 4) + 'claude',
    'a=\n\t': 'a=\n\t'.repeat((8 * MB) / 4),
    "cd '…": "cd '" + 'a'.repeat(8 * MB),
    "cd '\\'' …": "cd '" + "'\\''".repeat((8 * MB) / 4),
    "cd 'x' && cd 'x' && …": "cd 'x' && ".repeat((8 * MB) / 10),
  };
  for (const [what, line] of Object.entries(crafted)) {
    it(`does not throw and stays fast on 8 MB of ${what}, in isClaudeCommand and in processBadge`, () => {
      const t0 = performance.now();
      expect(() => isClaudeCommand(line)).not.toThrow();
      expect(() => processBadge(line, 'working')).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(500);
    });
  }

  it('reads a line by its head: a line that begins with claude is claude however long it is', () => {
    expect(isClaudeCommand('claude ' + 'x '.repeat(MB))).toBe(true);
    expect(isClaudeCommand(' '.repeat(5000) + 'claude')).toBe(false);
  });

  it('a resume into the longest folder it types (4096 characters, every one a quote) is still Claude; 1 MB and 8 MB cd lines stay fast', () => {
    expect(isClaudeCommand(`cd '${"'\\''".repeat(4095)}x' && claude --resume x`)).toBe(true);
    expect(isClaudeCommand(`cd '${'a'.repeat(4095)}' && claude --resume x`)).toBe(true);
    for (const n of [1, 8]) {
      const t0 = performance.now();
      expect(isClaudeCommand(`cd '${'a'.repeat(n * MB)}' && claude`)).toBe(false);
      expect(isClaudeCommand(`cd '${"'\\''".repeat((n * MB) / 4)}' && claude`)).toBe(false);
      expect(isClaudeCommand(`cd 'x' && claude ${'y '.repeat((n * MB) / 2)}`)).toBe(true);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});

// Moved here from the tests of the resume helpers (gone in 0.6.0): `isClaudeCommand` is the one of them that stays.
describe('reading a `claude` command line that came from the terminal (untrusted text, on the daemon thread)', () => {
  // Output shown in the terminal can forge the shell's marks (OSC 133/633), and with them a "command line" of any length.
  const MB = 1_000_000;
  const hostile = {
    'escaped quotes and no closing one': 'claude ' + '\\"'.repeat(MB / 2),
    'unclosed single quotes after a word': 'claude ' + "a='".repeat(MB / 3),
    'a run of backslashes': 'claude ' + '\\'.repeat(MB),
    'an unclosed double quote': 'claude -c "' + 'x '.repeat(MB / 2),
    'many short words': 'claude ' + 'a '.repeat(MB / 2) + '-p',
    'variables and no claude': 'A=1 '.repeat(MB / 4),
    'a path of slashes and no claude': '/'.repeat(MB),
    'spaces and no claude': ' '.repeat(MB),
  };
  for (const [what, line] of Object.entries(hostile)) {
    it(`stays fast on ${what} (1 MB)`, () => {
      const t0 = performance.now();
      isClaudeCommand(line);
      processBadge(line, 'working');
      expect(performance.now() - t0, what).toBeLessThan(200); // well under that in practice; generous for CI
    });
  }

  // The same lines at 1 MB and 8 MB (a forged mark can carry 10 MB). Unbounded regexes over such lines are slow, and past a few MB they
  // throw RangeError (V8's backtrack stack): so the helper cuts its input to the head itself.
  const crafted: Record<string, (bytes: number) => string> = {
    'variables and no claude (a=b )': (n) => 'a=b '.repeat(n / 4),
    'a run of `command ` words': (n) => 'command '.repeat(n / 8),
    'variables, then claude (A=1 ... claude)': (n) => 'A=1 '.repeat(n / 4) + 'claude',
    'variables that end in a newline and a tab (a=\\n\\t)': (n) => 'a=\n\t'.repeat(n / 4),
  };
  for (const size of [1, 8]) {
    for (const [what, make] of Object.entries(crafted)) {
      it(`never throws and stays fast on ${what} (${size} MB)`, () => {
        const line = make(size * MB);
        const t0 = performance.now();
        expect(() => isClaudeCommand(line), what).not.toThrow();
        expect(performance.now() - t0, what).toBeLessThan(500); // microseconds in practice once cut; generous for CI
      });
    }
  }

  it('cutting the input to the head changes nothing for a normal line, and reads a long one by its head', () => {
    // what is in the head decides, whatever follows it
    const tail = ' x'.repeat(MB);
    expect(isClaudeCommand('claude' + tail)).toBe(true);
    expect(isClaudeCommand('claude --version' + tail)).toBe(true);
    // and a `claude` that only begins after the head is not read as one
    expect(isClaudeCommand(' '.repeat(5000) + 'claude')).toBe(false);
  });
});
