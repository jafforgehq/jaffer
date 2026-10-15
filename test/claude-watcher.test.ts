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
    expect(only()).toEqual({ id: 'sess-1', state: 'idle', since: 1_000, startedAt: 1_000, turns: 0, calls: [], counts: {}, files: [], subagents: [], transcriptPath: expect.stringContaining('sess-1.jsonl') });
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

  it('a SessionStart that arrives after the prompt leaves the session working', () => {
    // `claude "<prompt>"` and `claude -p` fire SessionStart and UserPromptSubmit a moment apart, both async: either may land first
    w.handle(fx('UserPromptSubmit', { prompt: 'fix the build' }));
    w.handle(fx('PreToolUse', bash('npm test')));
    const turn = only().turnStartedAt;
    t += 20;
    w.handle(fx('SessionStart'));
    expect(only()).toMatchObject({ state: 'working', tool: { name: 'Bash', id: 'toolu_2' }, turnStartedAt: turn });
    w.handle(fx('Notification')); // and one that lands while Claude waits for the person leaves it waiting
    expect(only().state).toBe('needs-you');
    w.handle(fx('SessionStart'));
    expect(only()).toMatchObject({ state: 'needs-you', notice: expect.stringMatching(/permission/i) });
    w.handle(fx('Stop'));
    expect(only().state).toBe('idle'); // the turn still ends as usual
  });

  it('a SessionStart on a session it does not know, or one that ended, still makes an idle session', () => {
    w.handle(fx('SessionStart'));
    expect(only()).toMatchObject({ state: 'idle', since: 1_000 });
    w.handle(fx('SessionEnd'));
    expect(only().state).toBe('ended');
    t += 50;
    w.handle(fx('SessionStart', { transcript_path: '/tmp/resumed/sess-1.jsonl', source: 'resume' })); // a resumed session
    expect(only()).toMatchObject({ state: 'idle', since: 1_050, transcriptPath: '/tmp/resumed/sess-1.jsonl', tool: undefined, notice: undefined });
    w.handle(fx('Stop'));
    w.handle(fx('SessionStart')); // a SessionStart while idle (after /compact) keeps it idle
    expect(only().state).toBe('idle');
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
    w.handle(fx('SessionStart', { source: 'resume' })); // a resumed session
    expect(only().state).toBe('idle');
  });

  // An async SessionStart can land after its own SessionEnd: `claude -p` that fails within milliseconds. Taken as a new start it would
  // leave an idle session that nothing sweeps, and the companion would show Claude open for good.
  it('a SessionStart that lands just after its own SessionEnd (`claude -p` failing at once) leaves the session ended', () => {
    w.handle(fx('SessionEnd'));
    expect(only().state).toBe('ended');
    const endedAt = only().since;
    t += 100;
    w.handle(fx('SessionStart')); // source: startup, the late one
    expect(only()).toMatchObject({ state: 'ended', since: endedAt });
    w.endAll();
    t += 100;
    w.handle(fx('SessionStart', { source: undefined })); // (a Claude Code that does not say why it started: the same)
    expect(only().state).toBe('ended');
  });

  it('a SessionStart 3 s or more after the end is a new run of that session, and brings it back', () => {
    w.handle(fx('SessionEnd'));
    t += 3_000;
    w.handle(fx('SessionStart'));
    expect(only()).toMatchObject({ state: 'idle', since: t });
  });

  it('a session resumed (or cleared, or compacted) right after it ended comes back at once: Claude Code says it goes on', () => {
    for (const source of ['resume', 'clear', 'compact']) {
      w = new ClaudeWatcher({ now: () => t });
      w.handle(fx('SessionEnd'));
      t += 100;
      w.handle(fx('SessionStart', { source }));
      expect(only().state, source).toBe('idle');
    }
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

  // Changed on purpose for 1.0.0 (the spec narrows the rule): the paths of the files Claude edits or writes are now kept, in memory,
  // redacted and never a sensitive one, with the names, counts, timings and failures of its tool calls. Nothing else of a payload is.
  it('keeps nothing the person wrote or Claude answered: no prompt, command, reply, folder or tool argument; only tool names, counts, timings, failures and the paths it edits (never a sensitive one)', () => {
    const home = '/home/me/secret-project';
    const words = ['PROMPT-SECRET-WORDS', 'cat /home/me/.ssh/id_rsa', '.ssh', 'id_rsa', 'REPLY-SECRET-WORDS', home, TOKEN, 'plan-the-heist', 'heist-description', 'OLD-TEXT', 'NEW-TEXT', 'FILE-CONTENT', 'read-only.ts', 'ERROR-TEXT', 'PERMISSION-SECRET-COMMAND', 'SUGGESTION-SECRET', 'PermissionRequest'];
    w.handle(fx('SessionStart', { cwd: home, model: 'claude-opus-5-5' }));
    w.handle(fx('UserPromptSubmit', { prompt: `PROMPT-SECRET-WORDS ${TOKEN}`, cwd: home }));
    w.handle(fx('PreToolUse', bash('cat /home/me/.ssh/id_rsa')));
    w.handle(fx('PostToolUseFailure', { ...bash('cat /home/me/.ssh/id_rsa'), error: 'ERROR-TEXT' }));
    const read = { tool_name: 'Read', tool_input: { file_path: '/work/app/src/read-only.ts' }, tool_use_id: 'toolu_r' };
    w.handle(fx('PreToolUse', read));
    w.handle(fx('PostToolUse', { ...read, tool_response: { file: { content: 'FILE-CONTENT' } } }));
    const edit = { tool_name: 'Edit', tool_input: { file_path: '/work/app/src/a.ts', old_string: 'OLD-TEXT', new_string: 'NEW-TEXT' }, tool_use_id: 'toolu_e' };
    w.handle(fx('PreToolUse', edit));
    w.handle(fx('PostToolUse', { ...edit, tool_response: { filePath: '/work/app/src/a.ts', originalFile: 'FILE-CONTENT' } }));
    const key = { tool_name: 'Write', tool_input: { file_path: '/home/me/.ssh/authorized_keys', content: 'FILE-CONTENT' }, tool_use_id: 'toolu_k' };
    w.handle(fx('PreToolUse', key));
    expect(only().file).toBeUndefined(); // a sensitive path is not even shown while it is written
    w.handle(fx('PostToolUse', key));
    w.handle(fx('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'heist-description', prompt: 'plan-the-heist', subagent_type: 'plan-the-heist' }, tool_use_id: 'toolu_g' }));
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'plan-the-heist' }));
    // 1.2.0: a PermissionRequest (the approvals hook asks the daemon with `claude.approval`, never the watcher) is not kept either
    // (its shape from Claude Code's docs: no captured payload in the fixtures)
    w.handle({ session_id: 'sess-1', transcript_path: '/home/user/.claude/projects/-work-app/sess-1.jsonl', cwd: home, permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'PERMISSION-SECRET-COMMAND' }, permission_suggestions: [{ type: 'addRules', rules: ['SUGGESTION-SECRET'] }] });
    w.handle(fx('Stop', { last_assistant_message: `REPLY-SECRET-WORDS ${TOKEN}` }));
    const state = JSON.stringify(w.sessions());
    for (const word of words) expect(state, word).not.toContain(word);
    expect(Object.keys(JSON.parse(state)[0]).sort()).toEqual(['calls', 'counts', 'files', 'id', 'since', 'startedAt', 'state', 'subagents', 'transcriptPath', 'turnStartedAt', 'turns']); // what is set at all (JSON drops the undefined)
    for (const call of JSON.parse(state)[0].calls) for (const k of Object.keys(call)) expect(['name', 'category', 'startedAt', 'endedAt', 'failed', 'agentId', 'id']).toContain(k);
    expect(only().files).toEqual(['/work/app/src/a.ts']); // the one path it keeps: a file Claude edited, not one it read, not a key
    expect(only().calls.map((c) => [c.name, c.failed ?? false])).toEqual([['Bash', true], ['Read', false], ['Edit', false], ['Write', false], ['Agent', false]]);
    expect(only().counts).toEqual({ shell: 1, read: 1, write: 2, agent: 1 });
    expect(only().subagents).toEqual([{ id: 'bg-1', status: 'running', startedAt: 1_000 }]);
  });

  it('what leaves the daemon (view) is the same sessions without the transcript path', () => {
    w.handle(fx('PreToolUse', bash('npm test')));
    expect(w.sessions()[0]!.transcriptPath).toContain('sess-1.jsonl');
    const out = w.view();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 'sess-1', state: 'working', since: 1_000, turnStartedAt: 1_000, tool: { name: 'Bash', id: 'toolu_2' }, subagents: [], startedAt: 1_000, turns: 0, calls: [{ name: 'Bash', category: 'shell', startedAt: 1_000 }], counts: { shell: 1 }, files: [] });
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

describe('ClaudeWatcher turn start', () => {
  it('notes when a turn began: at the prompt, and it stays the same through a wait for the person and the work after it', () => {
    w.handle(fx('SessionStart'));
    expect(only().turnStartedAt).toBeUndefined();
    t = 5_000;
    w.handle(fx('UserPromptSubmit'));
    expect(only().turnStartedAt).toBe(5_000);
    t = 6_000;
    w.handle(fx('PreToolUse', bash('rm -rf build')));
    w.handle(fx('Notification')); // needs-you
    expect(only().state).toBe('needs-you');
    t = 90_000;
    w.handle(fx('PostToolUse', bash('rm -rf build'))); // answered: working again, the same turn
    expect(only().state).toBe('working');
    expect(only().turnStartedAt).toBe(5_000);
    w.handle(fx('Stop'));
    expect(only().turnStartedAt).toBe(5_000); // kept after the turn: a notification wants to know how long it was
  });

  it('a new turn, also one nobody prompted (a background agent finished and Claude went on), starts a new count', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('Stop'));
    t = 50_000;
    w.handle(fx('UserPromptSubmit'));
    expect(only().turnStartedAt).toBe(50_000);
    w.handle(fx('Stop'));
    t = 80_000;
    w.handle(fx('PreToolUse', bash('echo again'))); // idle → working with no prompt
    expect(only().turnStartedAt).toBe(80_000);
  });

  it('is a number only, and goes out with the view', () => {
    w.handle(fx('UserPromptSubmit', { prompt: 'SECRET prompt' }));
    expect(w.view()[0]!.turnStartedAt).toBe(1_000);
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

describe('ClaudeWatcher: a turn that did not end on its own', () => {
  it('is marked when it was cut short (Esc or a declined prompt, or a silence that sweeps it to idle), and not when Claude finished it', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('Stop'));
    expect(only().cutShort).toBeUndefined(); // Claude's own Stop: it finished

    w.handle(fx('UserPromptSubmit'));
    w.interrupted('sess-1');
    expect(only().state).toBe('idle');
    expect(only().cutShort).toBe(true);

    w.handle(fx('UserPromptSubmit')); // the next turn starts clean
    expect(only().cutShort).toBeUndefined();
    t += 6 * 60_000;
    w.sweep(() => false); // an API error or a crash: nothing came for minutes
    expect(only().state).toBe('idle');
    expect(only().cutShort).toBe(true);
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('Stop'));
    expect(only().cutShort).toBeUndefined();
  });

  it('is a flag and nothing else, and goes out with the view', () => {
    w.handle(fx('UserPromptSubmit', { prompt: 'SECRET prompt' }));
    w.interrupted('sess-1');
    expect(w.view()[0]!.cutShort).toBe(true);
  });
});

describe('ClaudeWatcher: the tool calls of a turn (names, kinds, timings, failures)', () => {
  it('records each call with its name, its kind and when it ran, and whether it failed; the ids stay in the daemon', () => {
    w.handle(fx('UserPromptSubmit'));
    t = 2_000;
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_a')));
    t = 2_500;
    w.handle(fx('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/app/a.ts' }, tool_use_id: 'toolu_b' }));
    t = 3_000;
    w.handle(fx('PostToolUse', { tool_name: 'Read', tool_use_id: 'toolu_b' }));
    t = 4_000;
    w.handle(fx('PostToolUseFailure', { ...bash('npm test', 'toolu_a'), error: 'exit 1' }));
    const out = w.view()[0]!;
    expect(out.calls).toEqual([
      { name: 'Bash', category: 'shell', startedAt: 2_000, endedAt: 4_000, failed: true },
      { name: 'Read', category: 'read', startedAt: 2_500, endedAt: 3_000 },
    ]);
    expect(out.counts).toEqual({ shell: 1, read: 1 });
    expect(JSON.stringify(w.view())).not.toContain('toolu_');
  });

  it('a result without a call id (an older Claude Code) ends the latest open call; one for a call it never saw ends nothing', () => {
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_a')));
    t = 2_000;
    w.handle(fx('PreToolUse', { tool_name: 'Grep', tool_use_id: 'toolu_b' }));
    t = 3_000;
    w.handle(fx('PostToolUse', { tool_name: 'Grep', tool_use_id: 'toolu_zzz' }));
    expect(only().calls.map((c) => c.endedAt)).toEqual([undefined, undefined]);
    w.handle(fx('PostToolUse', { tool_name: 'Grep', tool_use_id: undefined }));
    expect(only().calls.map((c) => c.endedAt)).toEqual([undefined, 3_000]);
  });

  it('counts every call of the turn, and keeps the last 200 of them', () => {
    w.handle(fx('UserPromptSubmit'));
    for (let i = 0; i < 250; i++) {
      t += 1;
      w.handle(fx('PreToolUse', bash('x', `toolu_${i}`)));
      w.handle(fx('PostToolUse', bash('x', `toolu_${i}`)));
    }
    expect(only().counts).toEqual({ shell: 250 });
    expect(only().calls).toHaveLength(200);
    expect(only().calls[0]!.startedAt).toBe(1_000 + 51); // the 51st call: the first fifty went
  });

  it('a turn that ends closes the calls still open (Esc, a lost result), so none runs on for ever', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_a')));
    t = 5_000;
    w.interrupted('sess-1');
    expect(only().calls[0]).toMatchObject({ endedAt: 5_000 });
    expect(only().calls[0]!.failed).toBeUndefined();
    w.handle(fx('PostToolUseFailure', bash('npm test', 'toolu_a'))); // the result, late: the call already ended
    expect(only().calls[0]).toMatchObject({ endedAt: 5_000 });
    expect(only().calls[0]!.failed).toBeUndefined();
    for (const end of ['Stop', 'SessionEnd']) {
      w = new ClaudeWatcher({ now: () => t });
      w.handle(fx('PreToolUse', bash('npm test', 'toolu_a')));
      t += 10;
      w.handle(fx(end));
      expect(only().calls[0]!.endedAt, end).toBe(t);
    }
  });

  it('the turn starts over at the next prompt (not at a task notification): calls, counts and edited files; they stay readable after Stop', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test')));
    w.handle(fx('PostToolUse', bash('npm test')));
    w.handle(fx('PreToolUse-Edit'));
    w.handle(fx('PostToolUse-Edit'));
    w.handle(fx('Stop'));
    const done = { calls: [expect.objectContaining({ name: 'Bash' }), expect.objectContaining({ name: 'Edit' })], counts: { shell: 1, write: 1 }, files: ['/work/app/src/main.ts'] };
    expect(only()).toMatchObject(done);
    w.handle(fx('UserPromptSubmit', { prompt: '<task-notification>agent done</task-notification>' }));
    expect(only()).toMatchObject(done);
    w.handle(fx('UserPromptSubmit'));
    expect(only()).toMatchObject({ calls: [], counts: {}, files: [] });
  });
});

describe('ClaudeWatcher: the files Claude edits or writes (paths only, redacted, never a sensitive one)', () => {
  it('shows the path while the edit runs, and lists it for the turn once it succeeded (a failed write is not listed)', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse-Edit'));
    expect(only()).toMatchObject({ file: '/work/app/src/main.ts', files: [] });
    w.handle(fx('PostToolUse-Edit'));
    expect(only().file).toBeUndefined();
    expect(only().files).toEqual(['/work/app/src/main.ts']);
    w.handle(fx('PreToolUse-Write'));
    expect(only().file).toBe('/work/app/README.md');
    w.handle(fx('PostToolUseFailure', { tool_name: 'Write', tool_input: { file_path: '/work/app/README.md' }, tool_use_id: 'toolu_w1' }));
    expect(only().file).toBeUndefined();
    expect(only().files).toEqual(['/work/app/src/main.ts']);
  });

  it('all four writing tools count (NotebookEdit by its notebook_path), each path once', () => {
    const done = (tool_name: string, tool_input: object, id: string) => {
      w.handle(fx('PreToolUse', { tool_name, tool_input, tool_use_id: id }));
      w.handle(fx('PostToolUse', { tool_name, tool_input, tool_use_id: id }));
    };
    done('Edit', { file_path: '/work/app/a.ts' }, 't1');
    done('Write', { file_path: '/work/app/b.ts' }, 't2');
    done('MultiEdit', { file_path: '/work/app/c.ts', edits: [] }, 't3');
    done('NotebookEdit', { notebook_path: '/work/app/d.ipynb', new_source: 'x' }, 't4');
    done('Edit', { file_path: '/work/app/a.ts' }, 't5');
    expect(only().files).toEqual(['/work/app/a.ts', '/work/app/b.ts', '/work/app/c.ts', '/work/app/d.ipynb']);
  });

  it('never keeps the path of a read, a search, a command or a sensitive file; redacts the rest; drops one too long to be a path', () => {
    const done = (tool_name: string, tool_input: object, id: string) => {
      w.handle(fx('PreToolUse', { tool_name, tool_input, tool_use_id: id }));
      expect(only().file, `${tool_name} ${JSON.stringify(tool_input).slice(0, 60)}`).toBeUndefined();
      w.handle(fx('PostToolUse', { tool_name, tool_input, tool_use_id: id }));
    };
    done('Read', { file_path: '/work/app/a.ts' }, 't1');
    done('Grep', { pattern: 'x', path: '/work/app' }, 't2');
    done('Bash', { command: 'touch /work/app/a.ts', file_path: '/work/app/a.ts' }, 't3');
    done('Edit', { file_path: '/Users/me/.ssh/config' }, 't4');
    done('Write', { file_path: '/work/app/.env.local' }, 't5');
    done('Edit', { file_path: `/work/app/${'a/'.repeat(3_000)}x.ts` }, 't6');
    done('Edit', { file_path: 42 }, 't7');
    expect(only().files).toEqual([]);
    w.handle(fx('PreToolUse', { tool_name: 'Write', tool_input: { file_path: `/work/app/${TOKEN}.txt` }, tool_use_id: 't8' }));
    expect(only().file).toMatch(/^\/work\/app\//);
    expect(only().file).not.toContain('sk-ant-api03');
  });

  it('lists at most 50 files a turn', () => {
    for (let i = 0; i < 60; i++) {
      w.handle(fx('PreToolUse', { tool_name: 'Write', tool_input: { file_path: `/work/app/f${i}.ts` }, tool_use_id: `t${i}` }));
      w.handle(fx('PostToolUse', { tool_name: 'Write', tool_input: { file_path: `/work/app/f${i}.ts` }, tool_use_id: `t${i}` }));
    }
    expect(only().files).toHaveLength(50);
    expect(only().files[49]).toBe('/work/app/f49.ts');
  });

  it('the path goes with the call: Stop, an interruption, the end of the session and the sweep clear it', () => {
    const editing = () => {
      w = new ClaudeWatcher({ now: () => t });
      w.handle(fx('UserPromptSubmit'));
      w.handle(fx('PreToolUse-Edit'));
      expect(only().file).toBe('/work/app/src/main.ts');
    };
    editing();
    w.handle(fx('Stop'));
    expect(only().file).toBeUndefined();
    editing();
    w.interrupted('sess-1');
    expect(only().file).toBeUndefined();
    editing();
    w.handle(fx('SessionEnd'));
    expect(only().file).toBeUndefined();
    editing();
    t += 31 * 60_000;
    w.sweep(() => false);
    expect(only().file).toBeUndefined();
  });
});

describe('ClaudeWatcher: background agents and their tools', () => {
  it('a call made inside a background agent (agent_id) is that agent\'s: its last tool, and the call says whose it is', () => {
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('SubagentStart', { agent_id: 'bg-1', agent_type: 'Explore' }));
    w.handle(fx('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 'toolu_g', agent_id: 'bg-1', agent_type: 'Explore' }));
    expect(only().subagents[0]).toEqual({ id: 'bg-1', status: 'running', startedAt: 1_000, tool: 'Grep' });
    expect(only().calls[0]).toMatchObject({ name: 'Grep', category: 'read', agentId: 'bg-1' });
    w.handle(fx('PreToolUse', bash('npm test', 'toolu_main'))); // Claude's own call: no agent's
    expect(only().subagents[0]!.tool).toBe('Grep');
    expect(only().calls[1]!.agentId).toBeUndefined();
    w.handle(fx('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_x', agent_id: 'bg-unknown' })); // an agent it never heard start
    expect(only().subagents).toHaveLength(1);
    expect(only().calls[2]!.agentId).toBe('bg-unknown');
  });
});

describe('ClaudeWatcher: compacting', () => {
  it('PreCompact (an eleventh event) marks the session compacting, without changing what it does', () => {
    w.handle(fx('SessionStart'));
    w.handle(fx('PreCompact', { trigger: 'manual' }));
    expect(only()).toMatchObject({ state: 'idle', compacting: true });
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreCompact'));
    expect(only()).toMatchObject({ state: 'working', compacting: true });
    w.handle(fx('SessionStart', { source: 'compact' })); // the compacted session starts again: still the same turn
    expect(only()).toMatchObject({ state: 'working' });
    expect(only().compacting).toBeUndefined();
  });

  it('ends at SessionStart (compact), a prompt, a tool call, Stop or SessionEnd; another SessionStart does not end it', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['SessionStart', { source: 'compact' }],
      ['UserPromptSubmit', {}],
      ['PreToolUse', bash('npm test')],
      ['Stop', {}],
      ['SessionEnd', {}],
    ];
    for (const [ev, over] of cases) {
      w = new ClaudeWatcher({ now: () => t });
      w.handle(fx('PreCompact'));
      expect(only().compacting, ev).toBe(true);
      w.handle(fx(ev, over));
      expect(only().compacting, ev).toBeUndefined();
    }
    w = new ClaudeWatcher({ now: () => t });
    w.handle(fx('PreCompact'));
    w.handle(fx('SessionStart', { source: 'startup' }));
    expect(only().compacting).toBe(true);
  });

  it('a PreCompact after the session ended changes nothing, and a compaction that went quiet for minutes is over', () => {
    w.handle(fx('SessionEnd'));
    w.handle(fx('PreCompact'));
    expect(only().compacting).toBeUndefined();
    w = new ClaudeWatcher({ now: () => t });
    w.handle(fx('PreCompact', { trigger: 'manual' }));
    t += 4 * 60_000;
    w.sweep(() => false);
    expect(only().compacting).toBe(true);
    t += 2 * 60_000;
    w.sweep(() => true); // the transcript is still being written
    expect(only().compacting).toBe(true);
    w.sweep(() => false);
    expect(only().compacting).toBeUndefined();
  });
});

describe('ClaudeWatcher: the session clock', () => {
  it('knows when the session was first heard of and how many prompts it had (not counting task notifications)', () => {
    w.handle(fx('SessionStart'));
    t = 5_000;
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('Stop'));
    w.handle(fx('UserPromptSubmit', { prompt: '<task-notification>agent done</task-notification>' }));
    t = 9_000;
    w.handle(fx('UserPromptSubmit'));
    expect(w.view()[0]).toMatchObject({ startedAt: 1_000, turns: 2 });
    w.handle(fx('PreToolUse', bash('x', 'toolu_x'))); // a call is not a prompt
    expect(only().turns).toBe(2);
  });

  it('a session first heard through a tool call (hooks installed mid-session) starts its clock then, with no prompt counted', () => {
    t = 7_000;
    w.handle(fx('PreToolUse', bash('npm test')));
    expect(only()).toMatchObject({ startedAt: 7_000, turns: 0 });
  });
});

describe('ClaudeWatcher: the answer so far, while Claude works (live tokens)', () => {
  const so = (output: number, usd?: number) => ({ input: 100, output, usd });

  it('keeps the counts the daemon read, with when they changed, and tells the listeners only when they changed', () => {
    w.handle(fx('UserPromptSubmit'));
    const seen: ClaudeSession[][] = [];
    w.changes.on((s) => seen.push(s));
    t = 3_000;
    w.setLive('sess-1', so(500, 0.01));
    expect(only().live).toEqual({ input: 100, output: 500, usd: 0.01, at: 3_000 });
    t = 5_000;
    w.setLive('sess-1', so(500, 0.01)); // nothing new was written
    expect(seen).toHaveLength(1);
    expect(only().live!.at).toBe(3_000);
    w.setLive('sess-1', so(900)); // a model with no known price: tokens, no dollars
    expect(seen).toHaveLength(2);
    expect(w.view()[0]!.live).toEqual({ input: 100, output: 900, at: 5_000 });
    w.setLive('nobody', so(1));
    expect(seen).toHaveLength(2);
  });

  it('only while the session works: waiting for the person keeps the last figure, and Stop, an interruption, the sweep, the end and the next prompt clear it', () => {
    w.setLive('sess-1', so(1)); // a session it does not know
    w.handle(fx('SessionStart'));
    w.setLive('sess-1', so(1)); // idle: no answer is being written
    expect(only().live).toBeUndefined();

    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test')));
    w.setLive('sess-1', so(10));
    w.handle(fx('Notification'));
    expect(only()).toMatchObject({ state: 'needs-you', live: { output: 10 } });
    w.setLive('sess-1', so(20)); // (the daemon pauses meanwhile)
    expect(only().live!.output).toBe(10);
    w.handle(fx('PostToolUse', bash('npm test')));
    w.setLive('sess-1', so(20));
    w.handle(fx('Stop'));
    expect(only().live).toBeUndefined();

    w.handle(fx('UserPromptSubmit'));
    w.setLive('sess-1', so(30));
    w.handle(fx('UserPromptSubmit')); // a new prompt: a new answer
    expect(only().live).toBeUndefined();
    w.setLive('sess-1', so(30));
    w.interrupted('sess-1');
    expect(only().live).toBeUndefined();

    w.handle(fx('UserPromptSubmit'));
    w.setLive('sess-1', so(40));
    t += 6 * 60_000;
    w.sweep(() => false);
    expect(only().live).toBeUndefined();

    w.handle(fx('UserPromptSubmit'));
    w.setLive('sess-1', so(50));
    w.handle(fx('SessionEnd'));
    expect(only().live).toBeUndefined();
  });
});

describe('ClaudeWatcher: a turn Claude finished, and how long it took (the typical turn)', () => {
  it('tells the length of a turn that ended with Stop, also one that waited for the person', () => {
    const lengths: number[] = [];
    w.finished.on((ms) => lengths.push(ms));
    w.handle(fx('UserPromptSubmit'));
    t = 31_000;
    w.handle(fx('Stop'));
    w.handle(fx('Stop')); // heard twice: one turn
    t = 40_000;
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('PreToolUse', bash('npm test')));
    w.handle(fx('Notification'));
    t = 100_000;
    w.handle(fx('Stop'));
    expect(lengths).toEqual([30_000, 60_000]);
  });

  it('says nothing of a turn that was cut short (Esc, a declined prompt, a silence) or of a session that ended', () => {
    const lengths: number[] = [];
    w.finished.on((ms) => lengths.push(ms));
    w.handle(fx('UserPromptSubmit'));
    t = 20_000;
    w.interrupted('sess-1');
    w.handle(fx('Stop')); // a late Stop of the turn the person stopped
    w.handle(fx('UserPromptSubmit'));
    t += 6 * 60_000;
    w.sweep(() => false);
    w.handle(fx('UserPromptSubmit'));
    w.handle(fx('SessionEnd'));
    w.handle(fx('Stop')); // (async: after the end)
    expect(lengths).toEqual([]);
  });
});
