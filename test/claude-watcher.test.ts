import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClaudeWatcher, summarizeTool, type ClaudeSession } from '../src/core/claude/watcher';

const FX = path.resolve(__dirname, 'fixtures/claude-hooks');
/** A real (scrubbed) hook payload, with fields overridden. */
const fx = (name: string, over: Record<string, unknown> = {}) => ({ ...JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8')), ...over });
const bash = (command: string, id = 'toolu_2') => ({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

let t = 1_000;
let w: ClaudeWatcher;
beforeEach(() => {
  t = 1_000;
  w = new ClaudeWatcher({ now: () => t });
});
const only = (): ClaudeSession => {
  const s = w.sessions();
  expect(s).toHaveLength(1);
  return s[0]!;
};

describe('ClaudeWatcher', () => {
  it('SessionStart creates an idle session with the model', () => {
    w.handle(fx('SessionStart'));
    expect(only()).toMatchObject({ id: 'sess-1', state: 'idle', model: 'claude-opus-5-5', cwd: '/work/app', transcriptPath: expect.stringContaining('sess-1.jsonl'), activity: [], subagents: [] });
  });

  it('an event for a session it has not seen creates it (hooks installed mid-session)', () => {
    w.handle(fx('UserPromptSubmit', { prompt: 'fix the build' }));
    expect(only()).toMatchObject({ id: 'sess-1', state: 'working', prompt: 'fix the build' });
  });

  it('UserPromptSubmit → working with a ≤120 char redacted prompt, and ignores <task-notification> prompts', () => {
    w.handle(fx('SessionStart'));
    w.handle(fx('UserPromptSubmit', { prompt: `${'explain this '.repeat(30)}${TOKEN}` }));
    expect(only().state).toBe('working');
    expect(only().prompt!.length).toBeLessThanOrEqual(120);
    w.handle(fx('Stop'));
    w.handle(fx('UserPromptSubmit', { prompt: '<task-notification>agent done</task-notification>' }));
    expect(only().state).toBe('idle');
  });

  it('PreToolUse sets the tool and adds a running activity; PostToolUse completes it with the duration and keeps working', () => {
    w.handle(fx('UserPromptSubmit'));
    t = 2_000;
    w.handle(fx('PreToolUse', bash('npm test')));
    expect(only().tool).toEqual({ name: 'Bash', summary: 'npm test' });
    expect(only().activity).toEqual([{ id: 'toolu_2', name: 'Bash', summary: 'npm test', status: 'running', startedAt: 2_000 }]);
    w.handle(fx('PostToolUse', { ...bash('npm test'), duration_ms: 1234, tool_response: { stdout: 'ok' } }));
    expect(only().tool).toBeUndefined();
    expect(only().state).toBe('working');
    expect(only().activity[0]).toMatchObject({ status: 'done', durMs: 1234 });
  });

  it('PostToolUseFailure marks the entry failed', () => {
    w.handle(fx('PreToolUse', bash('false', 'toolu_3')));
    w.handle(fx('PostToolUseFailure', { tool_use_id: 'toolu_3' }));
    expect(only().activity[0]).toMatchObject({ id: 'toolu_3', status: 'failed' });
    expect(only().tool).toBeUndefined();
  });

  it('permission Notification → needs-you with the message; idle Notification leaves idle', () => {
    w.handle(fx('Stop'));
    w.handle(fx('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }));
    expect(only().state).toBe('idle');
    expect(only().notice).toBeUndefined();
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('rm -rf build')));
    w.handle(fx('Notification'));
    expect(only()).toMatchObject({ state: 'needs-you', notice: 'Claude needs your permission to use Bash' });
  });

  it('async hooks can arrive out of order: a late PostToolUse or permission Notification never makes a finished turn look busy', () => {
    w.handle(fx('PreToolUse', bash('npm test')));
    w.handle(fx('Stop')); // Stop overtakes the last PostToolUse
    w.handle(fx('PostToolUse', { ...bash('npm test'), duration_ms: 50 }));
    expect(only().state).toBe('idle');
    expect(only().activity[0]).toMatchObject({ status: 'done', durMs: 50 });
    w.handle(fx('Notification')); // a permission nudge for a prompt that was already answered
    expect(only()).toMatchObject({ state: 'idle', notice: undefined });
  });

  it('needs-you clears on PostToolUse, Stop, UserPromptSubmit and retractNotice', () => {
    const needs = () => {
      w = new ClaudeWatcher({ now: () => t });
      w.handle(fx('PreToolUse', bash('rm -rf build')));
      w.handle(fx('Notification'));
      expect(only().state).toBe('needs-you');
    };
    needs();
    w.handle(fx('PostToolUse', bash('rm -rf build')));
    expect(only()).toMatchObject({ state: 'working', notice: undefined });
    needs();
    w.handle(fx('Stop'));
    expect(only()).toMatchObject({ state: 'idle', notice: undefined, tool: undefined });
    needs();
    w.handle(fx('UserPromptSubmit'));
    expect(only()).toMatchObject({ state: 'working', notice: undefined });
    needs();
    w.retractNotice('sess-1');
    expect(only()).toMatchObject({ state: 'idle', notice: undefined, tool: undefined });
  });

  it('Stop → idle with the trimmed redacted last reply', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('Stop', { last_assistant_message: `  All done. Your key ${TOKEN} is in the file. ${'x'.repeat(400)}  ` }));
    expect(only().state).toBe('idle');
    expect(only().lastReply!.length).toBeLessThanOrEqual(240);
    expect(only().lastReply).toContain('All done.');
    expect(only().lastReply).not.toContain('sk-ant-api03');
  });

  it('SubagentStart/Stop track subagents', () => {
    w.handle(fx('SubagentStart'));
    expect(only().subagents).toEqual([{ id: 'agent-1', type: 'general-purpose', status: 'running' }]);
    w.handle(fx('SubagentStop'));
    expect(only().subagents).toEqual([{ id: 'agent-1', type: 'general-purpose', status: 'done' }]);
  });

  it('SessionEnd → ended, and ended sessions are dropped after 5 minutes', () => {
    w.handle(fx('SessionStart'));
    w.handle(fx('SessionEnd'));
    expect(only().state).toBe('ended');
    t += 5 * 60_000 - 1;
    expect(w.sessions()).toHaveLength(1);
    t += 2;
    expect(w.sessions()).toHaveLength(0);
  });

  it('hooks still in flight when the session ended still record what happened, but never bring it back; SessionStart does', () => {
    w.handle(fx('PreToolUse', bash('npm test')));
    w.endAll(); // the shell reported that the claude command finished
    expect(only().state).toBe('ended');
    const endedAt = only().since;
    t += 50;
    w.handle(fx('PostToolUse', { ...bash('npm test'), duration_ms: 5 }));
    w.handle(fx('Stop', { last_assistant_message: 'the last reply arrived late' }));
    w.handle(fx('UserPromptSubmit', { prompt: 'late too' }));
    expect(only()).toMatchObject({ state: 'ended', since: endedAt, tool: undefined, notice: undefined });
    expect(only().lastReply).toBe('the last reply arrived late'); // the data is kept
    expect(only().activity[0]).toMatchObject({ status: 'done', durMs: 5 });
    w.handle(fx('SessionStart')); // a resumed session
    expect(only().state).toBe('idle');
  });

  it('endAll ends every session', () => {
    w.handle(fx('UserPromptSubmit', { session_id: 'a' }));
    w.handle(fx('Stop', { session_id: 'b' }));
    w.endAll();
    expect(w.sessions().map((s) => s.state)).toEqual(['ended', 'ended']);
  });

  it('a secret in a prompt or in a Bash command is redacted (sk-ant-… token)', () => {
    w.handle(fx('UserPromptSubmit', { prompt: `use ${TOKEN} for the call` }));
    w.handle(fx('PreToolUse', bash(`curl -H "Authorization: Bearer ${TOKEN}" https://api.example.com`)));
    const s = only();
    expect(JSON.stringify(s)).not.toContain('sk-ant-api03');
    expect(s.tool!.summary).toContain('curl');
  });

  it('a sensitive command (cat ~/.ssh/id_rsa) shows only "Bash"', () => {
    w.handle(fx('PreToolUse', bash('cat ~/.ssh/id_rsa')));
    expect(only().tool).toEqual({ name: 'Bash', summary: '' });
    expect(only().activity[0]).toMatchObject({ name: 'Bash', summary: '' });
    expect(JSON.stringify(only())).not.toContain('id_rsa');
  });

  it('activity is capped at 30 and sessions at 5', () => {
    for (let i = 1; i <= 35; i++) w.handle(fx('PreToolUse', bash(`echo ${i}`, `toolu_${i}`)));
    expect(only().activity).toHaveLength(30);
    expect(only().activity[0]!.id).toBe('toolu_6');
    expect(only().activity[29]!.id).toBe('toolu_35');
    for (let i = 1; i <= 7; i++) {
      t += 10;
      w.handle(fx('SessionStart', { session_id: `s${i}` }));
    }
    expect(w.sessions()).toHaveLength(5);
    expect(w.sessions()[0]!.id).toBe('s7'); // newest change first
  });

  it('garbage, unknown events, a missing session_id and a 1 MB prompt are ignored or truncated without throwing', () => {
    for (const junk of [null, undefined, 'x', 42, [], {}, { hook_event_name: 'Weird', session_id: 's' }, { hook_event_name: 'UserPromptSubmit' }, fx('MessageDisplay'), fx('PostToolBatch')]) {
      expect(() => w.handle(junk)).not.toThrow();
    }
    expect(w.sessions().every((s) => s.state === 'idle')).toBe(true); // unknown events never move state
    expect(() => w.handle(fx('PreToolUse', { tool_name: 'Bash', tool_input: 'ls', tool_use_id: 'x' }))).not.toThrow();
    w.handle(fx('UserPromptSubmit', { session_id: 'big', prompt: 'a'.repeat(1_000_000) }));
    expect(w.sessions().find((s) => s.id === 'big')!.prompt!.length).toBeLessThanOrEqual(120);
  });

  it('changes emits the new snapshot only when something changed', () => {
    const seen: ClaudeSession[][] = [];
    w.changes.on((s) => seen.push(s));
    w.handle(fx('SessionStart'));
    w.handle(fx('SessionStart'));
    w.handle(null);
    w.handle(fx('MessageDisplay'));
    expect(seen).toHaveLength(1);
    w.handle(fx('UserPromptSubmit'));
    expect(seen).toHaveLength(2);
    expect(seen[1]![0]!.state).toBe('working');
  });
});

describe('summarizeTool', () => {
  it('picks the one field that says what the tool is doing', () => {
    expect(summarizeTool('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(summarizeTool('Edit', { file_path: '/work/app/a.ts', old_string: 'x' })).toBe('/work/app/a.ts');
    expect(summarizeTool('Write', { file_path: '/work/app/b.ts' })).toBe('/work/app/b.ts');
    expect(summarizeTool('Read', { file_path: '/work/app/c.ts' })).toBe('/work/app/c.ts');
    expect(summarizeTool('Agent', { description: 'mock sub task' })).toBe('mock sub task');
    expect(summarizeTool('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(summarizeTool('mcp__x__y', { anything: 1 })).toBe('');
    expect(summarizeTool('Bash', 'not an object')).toBe('');
  });
});
