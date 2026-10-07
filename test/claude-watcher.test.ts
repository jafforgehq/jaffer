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

  it('needs-you clears on PostToolUse, Stop, UserPromptSubmit and interrupted', () => {
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
    w.interrupted('sess-1');
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
    expect(only().subagents).toEqual([{ id: 'agent-1', type: 'general-purpose', status: 'running', startedAt: 1_000 }]);
    w.handle(fx('SubagentStop'));
    expect(only().subagents).toEqual([{ id: 'agent-1', type: 'general-purpose', status: 'done', startedAt: 1_000 }]);
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

  it('userAnswered: input while Claude waits means the user is answering, so it is working again (tool kept); other states are untouched', () => {
    w.handle(fx('PreToolUse', bash('rm -rf build')));
    w.handle(fx('Notification'));
    expect(only().state).toBe('needs-you');
    w.userAnswered();
    expect(only()).toMatchObject({ state: 'working', notice: undefined, tool: { name: 'Bash', summary: 'rm -rf build' } });
    w.handle(fx('Stop'));
    w.userAnswered(); // nothing is waiting: nothing changes
    expect(only().state).toBe('idle');
  });

  it('interrupted also works after the user answered: a declined prompt is noticed even though the panel already shows working', () => {
    w.handle(fx('PreToolUse', bash('rm -rf build')));
    w.handle(fx('Notification'));
    w.userAnswered();
    expect(only().state).toBe('working');
    w.interrupted('sess-1'); // the transcript shows the user declined
    expect(only()).toMatchObject({ state: 'idle', tool: undefined });
  });

  it('interrupted: Esc while Claude works fires no Stop hook, so the transcript is what ends the turn: idle, the tool gone, its row failed', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_a')));
    w.handle(fx('PreToolUse', bash('npm run lint', 'toolu_b')));
    w.handle(fx('PostToolUse', bash('npm run lint', 'toolu_b')));
    w.interrupted('sess-1');
    expect(only()).toMatchObject({ state: 'idle', tool: undefined });
    expect(only().activity.map((a) => [a.id, a.status])).toEqual([['toolu_a', 'failed'], ['toolu_b', 'done']]);
    w.interrupted('sess-1'); // nothing is happening: nothing changes
    expect(only().state).toBe('idle');
    w.handle(fx('UserPromptSubmit', { session_id: 'plain' }));
    w.interrupted('plain'); // Esc during plain generation, no tool at all
    expect(w.sessions().find((x) => x.id === 'plain')!.state).toBe('idle');
    w.interrupted('nobody'); // an unknown session is ignored
  });

  it('Stop settles rows whose PostToolUse never arrived: the turn is over, so nothing is still running', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('sleep 1', 'toolu_lost')));
    w.handle(fx('Stop'));
    expect(only().activity.map((a) => a.status)).toEqual(['done']);
  });

  it('sweep: a turn that went silent (no hook for minutes, transcript not growing) is not working any more', () => {
    w.handle(fx('UserPromptSubmit'));
    t = 1_000 + 4 * 60_000;
    w.sweep(() => false);
    expect(only().state).toBe('working'); // four minutes of silence can still be a long answer
    t = 1_000 + 5 * 60_000 + 1;
    w.sweep(() => true);
    expect(only().state).toBe('working'); // the transcript is still being written
    w.sweep(() => false);
    expect(only().state).toBe('idle');
  });

  it('sweep is patient with a running tool, never touches needs-you, and an event restarts the clock', () => {
    w.handle(fx('PreToolUse', bash('npm run build', 'toolu_long')));
    t = 1_000 + 29 * 60_000;
    w.sweep(() => false);
    expect(only()).toMatchObject({ state: 'working', tool: { name: 'Bash', summary: 'npm run build' } }); // a long build is not silence
    t = 1_000 + 31 * 60_000;
    w.sweep(() => false);
    expect(only()).toMatchObject({ state: 'idle', tool: undefined });
    expect(only().activity[0]!.status).toBe('failed');
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_n')));
    w.handle(fx('Notification'));
    t += 3 * 3600_000;
    w.sweep(() => false);
    expect(only().state).toBe('needs-you'); // waiting for the person can take as long as it takes
    w.handle(fx('PostToolUse', bash('npm test', 'toolu_n')));
    t += 4 * 60_000;
    w.sweep(() => false);
    expect(only().state).toBe('working'); // the PostToolUse restarted the clock
  });

  it('background agents outlive the turn that started them: Stop does not touch them, SubagentStop finishes them', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'general-purpose' }));
    w.handle(fx('SubagentStart', { agent_id: 'bg-2', agent_type: 'Explore' }));
    w.handle(fx('Stop'));
    expect(only().state).toBe('idle');
    expect(only().subagents.map((a) => a.status)).toEqual(['running', 'running']);
    w.handle(fx('SubagentStop', { agent_id: 'bg-1', agent_type: 'general-purpose' }));
    expect(only().subagents.map((a) => a.status)).toEqual(['done', 'running']);
  });

  it('remembers when each background agent started, so the mole can work harder the longer it goes on', () => {
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'Explore' }));
    expect(only().subagents[0]).toMatchObject({ id: 'bg-1', status: 'running', startedAt: 1_000 });
    t = 61_000;
    w.handle(fx('SubagentStart', { agent_id: 'bg-2', agent_type: 'general-purpose' }));
    w.handle(fx('SubagentStop', { agent_id: 'bg-1', agent_type: 'Explore' }));
    expect(only().subagents.map((a) => [a.id, a.status, a.startedAt])).toEqual([['bg-1', 'done', 1_000], ['bg-2', 'running', 61_000]]);
    t = 121_000;
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'Explore' })); // the same agent id working again: a new run
    expect(only().subagents[0]).toMatchObject({ status: 'running', startedAt: 121_000 });
  });

  it('a session that ends leaves no agent running', () => {
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'general-purpose' }));
    w.handle(fx('SessionEnd'));
    expect(only().subagents.map((a) => a.status)).toEqual(['done']);
    w.handle(fx('SubagentStart', { session_id: 'other', agent_id: 'bg-9', agent_type: 'Explore' }));
    w.endAll();
    expect(w.sessions().flatMap((x) => x.subagents).every((a) => a.status === 'done')).toBe(true);
  });

  it('sweep: a background agent that has been silent for half an hour is not running any more, also in an idle session; a recent one stays', () => {
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'general-purpose' }));
    w.handle(fx('Stop'));
    t = 1_000 + 29 * 60_000;
    w.sweep(() => false);
    expect(only().subagents[0]!.status).toBe('running');
    t = 1_000 + 31 * 60_000;
    w.sweep(() => true); // its transcript is still being written: it is alive
    expect(only().subagents[0]!.status).toBe('running');
    w.sweep(() => false);
    expect(only().subagents[0]!.status).toBe('done');
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

describe('ClaudeWatcher cost', () => {
  const turn = (usd: number | undefined) => ({ usd, input: 10, output: 20, cacheRead: 30, cacheWrite: 0, model: 'claude-sonnet-5-5', messages: 1 });

  it('keeps the last answer and a running total over the session', () => {
    w.handle(fx('SessionStart'));
    expect(only().cost).toBeUndefined();
    t = 2_000;
    w.setCost('sess-1', turn(0.05));
    expect(only().cost).toMatchObject({ totalUsd: 0.05, answers: 1, partial: false, at: 2_000, last: { usd: 0.05, output: 20 } });
    w.setCost('sess-1', turn(0.25));
    expect(only().cost).toMatchObject({ totalUsd: 0.3, answers: 2, last: { usd: 0.25 } });
  });

  it('an answer it could not price still counts, and the total says it is a floor', () => {
    w.handle(fx('SessionStart'));
    w.setCost('sess-1', turn(0.1));
    w.setCost('sess-1', turn(undefined));
    expect(only().cost).toMatchObject({ totalUsd: 0.1, answers: 2, partial: true });
  });

  it('tells the listeners, ignores a session it does not know, and hands out copies', () => {
    w.handle(fx('SessionStart'));
    const seen: ClaudeSession[][] = [];
    w.changes.on((s) => seen.push(s));
    w.setCost('nobody', turn(1));
    expect(seen).toHaveLength(0);
    w.setCost('sess-1', turn(1));
    expect(seen).toHaveLength(1);
    only().cost!.last.output = 999;
    expect(only().cost!.last.output).toBe(20);
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
