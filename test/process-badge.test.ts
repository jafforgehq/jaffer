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

  it('is not Claude Code when a line merely mentions it', () => {
    for (const c of ['git log --grep claude', 'tail -f ~/.claude/debug.log', 'npm run claude-lint', 'claudette --serve', 'echo claude', 'cat claude.md', 'ls ~/.claude', '', 'claude-code-guide']) expect(isClaudeCommand(c), c).toBe(false);
  });

  it('so a command that only mentions claude still spins like any other command', () => {
    expect(processBadge('git log --grep claude', undefined)).toEqual({ kind: 'command', spin: true });
    expect(processBadge('tail -f ~/.claude/debug.log', 'idle')).toEqual({ kind: 'command', spin: true });
  });
});

