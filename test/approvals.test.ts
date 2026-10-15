import { describe, expect, it } from 'vitest';
import { approvalDetail, approvalTool, APPROVAL_WAIT_MS, decisionOutput } from '../src/core/claude/approvals';

const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

describe('approvals: what Claude Code reads back, and what the notification says', () => {
  it('waits 20 s, less than the 25 s Claude Code gives the hook', () => {
    expect(APPROVAL_WAIT_MS).toBe(20_000);
  });

  it('decisionOutput is exactly the one-line JSON Claude Code takes for a PermissionRequest: allow, or deny with a message; never more', () => {
    expect(decisionOutput('allow')).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
    expect(decisionOutput('deny')).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Jaffer"}}}');
    for (const d of ['allow', 'deny'] as const) {
      const out = decisionOutput(d);
      expect(out).not.toContain('\n');
      expect(out).not.toMatch(/updatedInput|updatedPermissions|interrupt/);
    }
    // anything that is not exactly 'allow' is a deny (the safe answer)
    expect(decisionOutput('ALLOW' as any)).toBe(decisionOutput('deny'));
    expect(decisionOutput(undefined as any)).toBe(decisionOutput('deny'));
  });

  it('a Bash detail is the command, redacted, on one line and at most 120 characters', () => {
    expect(approvalDetail('Bash', { command: 'npm test' })).toBe('npm test');
    const d = approvalDetail('Bash', { command: `curl -H "Authorization: Bearer ${TOKEN}" https://example.com` });
    expect(d).not.toContain('sk-ant-api03');
    expect(d).toContain('curl');
    expect(approvalDetail('Bash', { command: 'echo one\n\techo   two\r\necho three' })).toBe('echo one echo two echo three');
    const long = approvalDetail('Bash', { command: `echo ${'x'.repeat(500)}` });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('a sensitive command is not shown at all, not even redacted', () => {
    expect(approvalDetail('Bash', { command: 'cat ~/.ssh/id_rsa' })).toBe('');
    expect(approvalDetail('Bash', { command: 'printenv' })).toBe('');
    expect(approvalDetail('Bash', { command: ' secret-with-leading-space' })).toBe('');
  });

  it('a secret is redacted before the cut: half a token never shows', () => {
    const d = approvalDetail('Bash', { command: `${'a '.repeat(50)}${TOKEN}` });
    expect(d).not.toMatch(/sk-ant-api0/);
  });

  it('a file tool shows the file name only, never a sensitive one', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'Read']) expect(approvalDetail(tool, { file_path: '/work/app/src/a.ts', content: 'FILE-CONTENT' }), tool).toBe('a.ts');
    expect(approvalDetail('NotebookEdit', { notebook_path: '/work/app/nb.ipynb' })).toBe('nb.ipynb');
    expect(approvalDetail('Write', { file_path: '/home/me/.ssh/authorized_keys' })).toBe('');
    expect(approvalDetail('Edit', { file_path: '/work/app/.env.local' })).toBe('');
    expect(approvalDetail('Write', { file_path: `/work/${'d/'.repeat(3000)}x.ts` })).toBe(''); // past 4096: fails closed
  });

  it('WebFetch shows the host only; other tools show nothing of their input', () => {
    expect(approvalDetail('WebFetch', { url: `https://example.com/path?token=${TOKEN}`, prompt: 'PROMPT' })).toBe('example.com');
    expect(approvalDetail('WebFetch', { url: 'not a url' })).toBe('');
    expect(approvalDetail('Grep', { pattern: 'SECRET-PATTERN' })).toBe('');
    expect(approvalDetail('mcp__srv__tool', { anything: 'SECRET' })).toBe('');
    expect(approvalDetail('Task', { prompt: 'plan-the-heist' })).toBe('');
  });

  it('hostile input: not an object, the wrong kinds, control and direction characters', () => {
    for (const input of [null, undefined, 'npm test', 42, [], ['npm test'], { command: 42 }, { command: ['rm'] }, { file_path: {} }]) {
      expect(approvalDetail('Bash', input), JSON.stringify(input)).toBe('');
      expect(approvalDetail('Edit', input), JSON.stringify(input)).toBe('');
    }
    const d = approvalDetail('Bash', { command: 'echo \u202eevil\u202c \u200bok\u0007\u001b[31m' });
    expect(d).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/);
    expect(approvalTool('Ba\u0000sh\n\u202e')).toBe('Bash');
    expect(approvalTool(42)).toBe('');
    expect(approvalTool(undefined)).toBe('');
    expect(approvalTool('T'.repeat(500))).toHaveLength(64);
  });

  it('bounded: a 1 MB or 8 MB command, path, url or tool name is cut before anything reads it', () => {
    for (const n of [1024 * 1024, 8 * 1024 * 1024]) {
      const big = 'a'.repeat(n);
      for (const [what, run] of [
        ['bash', () => approvalDetail('Bash', { command: big })],
        ['bash spaced', () => approvalDetail('Bash', { command: `${'ab '.repeat(n / 3)}` })],
        ['path', () => approvalDetail('Write', { file_path: `/${big}` })],
        ['url', () => approvalDetail('WebFetch', { url: `https://${big}` })],
        ['tool', () => approvalTool(big)],
      ] as const) {
        const t0 = performance.now();
        const out = run();
        expect(performance.now() - t0, `${what} ${n}`).toBeLessThan(250);
        expect(out.length, `${what} ${n}`).toBeLessThanOrEqual(120);
      }
    }
  });
});
