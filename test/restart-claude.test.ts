import { describe, expect, it } from 'vitest';
import { restartClaudeText } from '../src/shared/restart-claude';

const CONVERSATION = 'This restarts your shell in the same folder. Claude Code comes back in the same conversation; anything else running in the shell stops.';
const WORKING = 'Claude is working right now: that work stops';
const NONE = 'No Claude Code conversation is running; this only restarts the shell';

describe('restartClaudeText (the question the app asks before it restarts the shell and Claude Code)', () => {
  it('with a conversation: the shell restarts in the same folder and the conversation comes back', () => {
    const t = restartClaudeText({ resumable: true, busy: false });
    expect(t.message).toBe('Restart Claude Code?');
    expect(t.detail).toBe(CONVERSATION);
  });

  it('with a conversation that is working: says so on a line of its own', () => {
    const t = restartClaudeText({ resumable: true, busy: true });
    expect(t.message).toBe('Restart Claude Code?');
    expect(t.detail).toBe(`${CONVERSATION}\n\n${WORKING}.`);
  });

  it('with no conversation: says it only restarts the shell, and promises nothing comes back', () => {
    const t = restartClaudeText({ resumable: false, busy: false });
    expect(t.message).toBe('Restart the shell?');
    expect(t.detail).toBe(`${NONE}.`);
    expect(t.detail).not.toMatch(/comes back/i);
  });

  it('with a Claude that is working but cannot be brought back: does not claim there is none', () => {
    const t = restartClaudeText({ resumable: false, busy: true });
    expect(t.message).toBe('Restart the shell?');
    expect(t.detail).toContain(WORKING);
    expect(t.detail).toContain('this only restarts the shell');
    expect(t.detail).not.toContain(NONE);
    expect(t.detail).not.toMatch(/comes back in the same conversation/i);
  });

  it('is plain text: no markup, no ids, nothing of the conversation', () => {
    for (const resumable of [true, false]) {
      for (const busy of [true, false]) {
        const { message, detail } = restartClaudeText({ resumable, busy });
        expect(`${message}\n${detail}`).not.toMatch(/[<>{}]|--resume|[0-9a-f]{8}-/);
      }
    }
  });
});
