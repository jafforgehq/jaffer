import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClaudeWatcher, type ClaudeSession, type TrackedSession } from '../src/core/claude/watcher';

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
const only = (): TrackedSession => {
  const s = w.sessions();
  expect(s).toHaveLength(1);
  return s[0]!;
};

describe('ClaudeWatcher', () => {
  it('SessionStart creates an idle session that knows where its transcript is', () => {
    w.handle(fx('SessionStart'));
    expect(only()).toEqual({ id: 'sess-1', state: 'idle', since: 1_000, subagents: [], transcriptPath: expect.stringContaining('sess-1.jsonl') });
  });

  it('an event for a session it has not seen creates it (hooks installed mid-session)', () => {
    w.handle(fx('UserPromptSubmit', { prompt: 'fix the build' }));
    expect(only()).toMatchObject({ id: 'sess-1', state: 'working' });
  });

  it('UserPromptSubmit → working, and ignores <task-notification> prompts', () => {
    w.handle(fx('SessionStart'));
    w.handle(fx('UserPromptSubmit', { prompt: 'explain this' }));
    expect(only().state).toBe('working');
    w.handle(fx('Stop'));
    w.handle(fx('UserPromptSubmit', { prompt: '<task-notification>agent done</task-notification>' }));
    expect(only().state).toBe('idle');
  });

  it('PreToolUse sets the tool (its name and call id, nothing else); PostToolUse clears it and keeps working', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test')));
    expect(only().tool).toEqual({ name: 'Bash', id: 'toolu_2' });
    w.handle(fx('PostToolUse', { ...bash('npm test'), duration_ms: 1234, tool_response: { stdout: 'ok' } }));
    expect(only().tool).toBeUndefined();
    expect(only().state).toBe('working');
  });

  it('PostToolUseFailure clears the tool too', () => {
    w.handle(fx('PreToolUse', bash('false', 'toolu_3')));
    w.handle(fx('PostToolUseFailure', { tool_use_id: 'toolu_3' }));
    expect(only().tool).toBeUndefined();
  });

  it('overlapping calls: the late result of an earlier call does not clear the tool of a later one; without ids it does', () => {
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_a')));
    w.handle(fx('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x' }, tool_use_id: 'toolu_b' }));
    w.handle(fx('PostToolUse', { ...bash('npm test', 'toolu_a') }));
    expect(only().tool).toEqual({ name: 'Edit', id: 'toolu_b' });
    w.handle(fx('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_b' }));
    expect(only().tool).toBeUndefined();
    w.handle(fx('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_c' }));
    w.handle(fx('PostToolUse', { tool_name: 'Read', tool_use_id: undefined })); // an older Claude Code that sends no call id
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

  it('Stop → idle', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test')));
    w.handle(fx('Stop', { last_assistant_message: 'All done.' }));
    expect(only()).toMatchObject({ state: 'idle', tool: undefined, notice: undefined });
  });

  it('SubagentStart/Stop track subagents', () => {
    w.handle(fx('SubagentStart'));
    expect(only().subagents).toEqual([{ id: 'agent-1', status: 'running', startedAt: 1_000 }]);
    w.handle(fx('SubagentStop'));
    expect(only().subagents).toEqual([{ id: 'agent-1', status: 'done', startedAt: 1_000 }]);
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

  it('hooks still in flight when the session ended never bring it back; only SessionStart does', () => {
    w.handle(fx('PreToolUse', bash('npm test')));
    w.endAll(); // the shell reported that the claude command finished
    expect(only().state).toBe('ended');
    const endedAt = only().since;
    t += 50;
    w.handle(fx('PostToolUse', { ...bash('npm test'), duration_ms: 5 }));
    w.handle(fx('Stop', { last_assistant_message: 'the last reply arrived late' }));
    w.handle(fx('UserPromptSubmit', { prompt: 'late too' }));
    expect(only()).toMatchObject({ state: 'ended', since: endedAt, tool: undefined, notice: undefined });
    w.handle(fx('SessionStart')); // a resumed session
    expect(only().state).toBe('idle');
  });

  it('userAnswered: input while Claude waits means the user is answering, so it is working again (tool kept); other states are untouched', () => {
    w.handle(fx('PreToolUse', bash('rm -rf build')));
    w.handle(fx('Notification'));
    expect(only().state).toBe('needs-you');
    w.userAnswered();
    expect(only()).toMatchObject({ state: 'working', notice: undefined, tool: { name: 'Bash', id: 'toolu_2' } });
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

  it('interrupted: Esc while Claude works fires no Stop hook, so the transcript is what ends the turn: idle and the tool gone', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_a')));
    w.handle(fx('PreToolUse', bash('npm run lint', 'toolu_b')));
    w.handle(fx('PostToolUse', bash('npm run lint', 'toolu_b')));
    w.interrupted('sess-1');
    expect(only()).toMatchObject({ state: 'idle', tool: undefined });
    w.interrupted('sess-1'); // nothing is happening: nothing changes
    expect(only().state).toBe('idle');
    w.handle(fx('UserPromptSubmit', { session_id: 'plain' }));
    w.interrupted('plain'); // Esc during plain generation, no tool at all
    expect(w.sessions().find((x) => x.id === 'plain')!.state).toBe('idle');
    w.interrupted('nobody'); // an unknown session is ignored
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
    expect(only()).toMatchObject({ state: 'working', tool: { name: 'Bash', id: 'toolu_long' } }); // a long build is not silence
    t = 1_000 + 31 * 60_000;
    w.sweep(() => false);
    expect(only()).toMatchObject({ state: 'idle', tool: undefined });
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

  it('keeps nothing the person wrote or Claude answered: no prompt, command, file name, reply or folder, and only a name and an id of the tool', () => {
    const home = '/home/me/secret-project';
    const words = ['PROMPT-SECRET-WORDS', 'cat /home/me/.ssh/id_rsa', 'REPLY-SECRET-WORDS', home, TOKEN, 'plan-the-heist'];
    w.handle(fx('SessionStart', { cwd: home, model: 'claude-opus-5-5' }));
    w.handle(fx('UserPromptSubmit', { prompt: `PROMPT-SECRET-WORDS ${TOKEN}`, cwd: home }));
    w.handle(fx('PreToolUse', bash('cat /home/me/.ssh/id_rsa')));
    w.handle(fx('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: `${home}/a.ts`, old_string: 'plan-the-heist' }, tool_use_id: 'toolu_e' }));
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'plan-the-heist' }));
    w.handle(fx('PostToolUse', { ...bash('cat /home/me/.ssh/id_rsa'), tool_response: { stdout: 'PROMPT-SECRET-WORDS' } }));
    w.handle(fx('Stop', { last_assistant_message: `REPLY-SECRET-WORDS ${TOKEN}` }));
    const state = JSON.stringify(w.sessions());
    for (const word of words) expect(state, word).not.toContain(word);
    expect(Object.keys(JSON.parse(state)[0]).sort()).toEqual(['id', 'since', 'state', 'subagents', 'transcriptPath']); // what is set at all (JSON drops the undefined)
    expect(only().subagents).toEqual([{ id: 'bg-1', status: 'running', startedAt: 1_000 }]);
  });

  it('what leaves the daemon (view) is the same sessions without the transcript path', () => {
    w.handle(fx('PreToolUse', bash('npm test')));
    expect(w.sessions()[0]!.transcriptPath).toContain('sess-1.jsonl');
    const out = w.view();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 'sess-1', state: 'working', since: 1_000, tool: { name: 'Bash', id: 'toolu_2' }, subagents: [] });
    expect(JSON.stringify(out)).not.toContain('.jsonl');
  });

  it('a notice is the wording Claude Code itself uses, redacted and cut', () => {
    w.handle(fx('PreToolUse', bash('x')));
    w.handle(fx('Notification', { message: `Claude needs your permission to use Bash with ${TOKEN} ${'y'.repeat(500)}`, notification_type: 'permission_prompt' }));
    expect(only().state).toBe('needs-you');
    expect(only().notice).not.toContain('sk-ant-api03');
    expect(only().notice!.length).toBeLessThanOrEqual(200);
  });

  it('sessions are capped at 5, newest first', () => {
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
    expect(w.sessions().find((s) => s.id === 'big')!.state).toBe('working');
    expect(JSON.stringify(w.sessions()).length).toBeLessThan(2_000); // the megabyte is not kept
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
