import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { makeRig, text, tools } from './helpers/agent';
import { AgentRuntime } from '../src/core/agent/runtime';
import { assessCommand, isReadOnlyCommand } from '../src/core/agent/permissions';
import { Thread } from '../src/core/agent/thread';
import type { Message } from '../src/core/agent/types';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

/** Every tool_use must be answered by a tool_result in the very next user message; roles must be API-valid. */
function assertValidHistory(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
      if (uses.length) {
        const next = messages[i + 1];
        expect(next, `tool_use without a following message at ${i}`).toBeTruthy();
        const results = (next!.content as { type: string; tool_use_id?: string }[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
        expect(results.sort()).toEqual([...uses].sort());
      }
    }
  }
}

describe('AgentRuntime', () => {
  it('runs a plain turn, streams text, persists the thread and feeds memory', async () => {
    const rig = makeRig(env, [() => text('Hello from the agent.')]);
    rig.agent.send('hi there');
    const end = await rig.done();
    expect(end.stopReason).toBe('end_turn');
    expect(rig.events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello from the agent.');
    expect(rig.agent.thread.items().map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(rig.engine.episodes.recent(5).some((e) => e.t === 'agent' && e.user === 'hi there')).toBe(true);
    // a new runtime over the same files resumes the same single conversation
    const again = new Thread(env.paths);
    expect(again.items().map((i) => i.kind)).toEqual(['user', 'assistant']);
  });

  it('refuses politely without credentials', async () => {
    const rig = makeRig(env, [() => text('x')], { ready: false });
    rig.agent.send('hello');
    const end = await rig.done();
    expect(end.stopReason).toBe('error');
    expect(end.error).toMatch(/API key/);
  });

  it('executes tools and keeps the history valid', async () => {
    const rig = makeRig(env, [
      () => tools([{ name: 'write_file', input: { path: 'notes.txt', content: 'one\ntwo\n' } }]),
      () => tools([{ name: 'read_file', input: { path: 'notes.txt' } }]),
      () => text('Done: file has two lines.'),
    ]);
    rig.autoApprove('allow');
    rig.agent.send('make a notes file then read it');
    const end = await rig.done();
    expect(end.stopReason).toBe('end_turn');
    expect(fs.readFileSync(path.join(rig.work, 'notes.txt'), 'utf8')).toBe('one\ntwo\n');
    const results = rig.events.filter((e) => e.type === 'tool_result') as { output: string; isError: boolean }[];
    expect(results).toHaveLength(2);
    expect(results[1]!.output).toContain('two');
    assertValidHistory(rig.agent.thread.messages);
    const items = rig.agent.thread.items();
    expect(items.filter((i) => i.kind === 'tool')).toHaveLength(2);
  });

  it('asks before modifying files and respects a denial', async () => {
    const rig = makeRig(env, [() => tools([{ name: 'write_file', input: { path: 'secret-plan.txt', content: 'x' } }]), () => text('Understood, I will not write it.')]);
    rig.autoApprove('deny');
    rig.agent.send('write a file');
    await rig.done();
    expect(fs.existsSync(path.join(rig.work, 'secret-plan.txt'))).toBe(false);
    const req = rig.events.find((e) => e.type === 'approval_request');
    expect(req).toBeTruthy();
    const result = rig.events.find((e) => e.type === 'tool_result') as { output: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/declined/);
    assertValidHistory(rig.agent.thread.messages);
  });

  it('"always allow" is remembered so the next identical action runs unprompted', async () => {
    const rig = makeRig(env, [
      () => tools([{ name: 'run_command', input: { command: 'touch one.txt' } }]),
      () => text('ok'),
      () => tools([{ name: 'run_command', input: { command: 'touch two.txt' } }]),
      () => text('ok again'),
    ]);
    rig.autoApprove('allow-always');
    rig.agent.send('make one');
    await rig.done();
    expect(env.config.get().agent.allow).toContain('run_command:touch');
    const before = rig.events.filter((e) => e.type === 'approval_request').length;
    rig.agent.send('make two');
    await rig.done();
    expect(rig.events.filter((e) => e.type === 'approval_request').length).toBe(before); // no new prompt
    expect(fs.existsSync(path.join(rig.work, 'two.txt'))).toBe(true);
  });

  it('runs read-only commands without asking', async () => {
    const rig = makeRig(env, [() => tools([{ name: 'run_command', input: { command: 'echo hello && pwd' } }]), () => text('done')]);
    rig.agent.send('say hello');
    await rig.done();
    expect(rig.events.some((e) => e.type === 'approval_request')).toBe(false);
    const r = rig.events.find((e) => e.type === 'tool_result') as { output: string };
    expect(r.output).toContain('hello');
  });

  it('still asks for risky commands in auto mode and blocks catastrophic ones outright', async () => {
    env.config.patch({ agent: { approvals: 'auto' } });
    const rig = makeRig(env, [
      () => tools([{ name: 'run_command', input: { command: 'sudo ls /root' } }, { name: 'run_command', input: { command: 'rm -rf /' } }]),
      () => text('stopped'),
    ]);
    rig.autoApprove('deny');
    rig.agent.send('do dangerous things');
    await rig.done();
    const asks = rig.events.filter((e) => e.type === 'approval_request') as { name: string; summary: string }[];
    expect(asks.map((a) => a.summary)).toEqual(['sudo ls /root']); // rm -rf / never even reaches the user
    const results = rig.events.filter((e) => e.type === 'tool_result') as { output: string; isError: boolean }[];
    expect(results[1]!.output).toMatch(/Blocked/);
  });

  it('cancel() ends the turn and leaves a valid history', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const rig = makeRig(env, [
      async () => {
        await gate;
        return tools([{ name: 'run_command', input: { command: 'touch late.txt' } }]);
      },
      () => text('x'),
    ]);
    rig.agent.send('start');
    await new Promise((r) => setTimeout(r, 20));
    rig.agent.cancel();
    release();
    const end = await rig.done();
    expect(end.stopReason).toBe('cancelled');
    expect(fs.existsSync(path.join(rig.work, 'late.txt'))).toBe(false);
    assertValidHistory(rig.agent.thread.messages);
    // and the session is immediately usable again
    rig.agent.send('next');
    expect((await rig.done()).stopReason).toBe('end_turn');
  });

  it('rejects a second message while busy', async () => {
    const rig = makeRig(env, [async () => new Promise<never>(() => undefined)]);
    rig.agent.send('first');
    expect(() => rig.agent.send('second')).toThrow(/still working/);
    rig.agent.cancel();
    await rig.done();
  });

  it('drops thinking blocks from completed turns but keeps them inside a turn', async () => {
    const rig = makeRig(env, [
      () => tools([{ name: 'list_dir', input: { path: '.' }, thinking: true }]),
      () => text('listed'),
      () => text('second answer'),
    ]);
    rig.agent.send('look around');
    await rig.done();
    // within the turn the second request still carried the thinking block (API requires it)
    const second = rig.provider.requests[1]!.messages;
    expect(JSON.stringify(second)).toContain('"type":"thinking"');
    // once the turn is over it is gone from the persisted thread
    expect(JSON.stringify(rig.agent.thread.messages)).not.toContain('"type":"thinking"');
    rig.agent.send('again');
    await rig.done();
    expect(JSON.stringify(rig.provider.requests[2]!.messages)).not.toContain('"type":"thinking"');
  });

  it('recovers from a thinking-binding error by stripping and retrying once', async () => {
    let calls = 0;
    const rig = makeRig(env, [
      () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.'), { status: 400 });
        return text('recovered');
      },
    ]);
    rig.agent.send('hello');
    const end = await rig.done();
    expect(end.stopReason).toBe('end_turn');
    expect(calls).toBe(2);
  });

  it('does not run tools when the response is cut off at max_tokens', async () => {
    const rig = makeRig(env, [() => tools([{ name: 'write_file', input: { path: 'half.txt', content: 'par' } }], 'max_tokens')]);
    rig.autoApprove('allow');
    rig.agent.send('write something huge');
    await rig.done();
    expect(fs.existsSync(path.join(rig.work, 'half.txt'))).toBe(false);
    expect(rig.events.some((e) => e.type === 'notice' && e.level === 'warn')).toBe(true);
  });

  it('reports refusals and keeps going', async () => {
    const rig = makeRig(env, [() => ({ ...text('', 'refusal'), stopCategory: 'cyber' })]);
    rig.agent.send('something');
    const end = await rig.done();
    expect(end.stopReason).toBe('refusal');
    expect(rig.events.some((e) => e.type === 'notice' && /declined/.test(e.text))).toBe(true);
  });

  it('injects memory once, then only what is new (append-only, cache-friendly)', async () => {
    const rig = makeRig(env, [() => text('a'), () => text('b'), () => text('c')]);
    rig.engine.remember('Always use pnpm, never npm, for package management', { kind: 'preference' });
    rig.agent.send('set up the project');
    await rig.done();
    const firstUser = JSON.stringify(rig.provider.requests[0]!.messages);
    expect(firstUser).toContain('<jaffer-context>');
    expect(firstUser).toContain('pnpm');

    rig.agent.send('and run the tests');
    await rig.done();
    const secondReq = rig.provider.requests[1]!.messages;
    const lastUser = JSON.stringify(secondReq[secondReq.length - 1]);
    expect(lastUser).not.toContain('<jaffer-context>'); // nothing new → nothing injected

    rig.engine.remember('Deploy previews live at preview.example.test, release via release.sh', { kind: 'workflow' });
    rig.agent.send('how do I deploy a preview release');
    await rig.done();
    const thirdReq = rig.provider.requests[2]!.messages;
    const lastUser3 = JSON.stringify(thirdReq[thirdReq.length - 1]);
    expect(lastUser3).toContain('Newly relevant memory');
    expect(lastUser3).toContain('release.sh');
    expect(lastUser3).not.toContain('pnpm');
    // the system prompt and tools never changed between turns (cache + preserved-thinking safe)
    expect(rig.provider.requests[2]!.system).toBe(rig.provider.requests[0]!.system);
    expect(JSON.stringify(rig.provider.requests[2]!.tools)).toBe(JSON.stringify(rig.provider.requests[0]!.tools));
  });

  it('lets the agent remember and recall through tools', async () => {
    const rig = makeRig(env, [
      () => tools([{ name: 'remember', input: { text: 'The staging database is reset every Monday' } }]),
      () => tools([{ name: 'recall', input: { query: 'staging database' } }]),
      () => text('noted'),
    ]);
    rig.agent.send('remember that staging resets on Mondays');
    await rig.done();
    expect(rig.engine.store.listItems().some((i) => i.text.includes('staging database'))).toBe(true);
    const recallResult = rig.events.filter((e) => e.type === 'tool_result')[1] as { output: string };
    expect(recallResult.output).toContain('staging database');
  });

  it('compacts a long conversation into a briefing without losing the recent turns', async () => {
    env.config.patch({ agent: { compactAtTokens: 1500 } });
    const rig = makeRig(env, [() => text('x'.repeat(2000))]);
    for (let i = 0; i < 4; i++) {
      rig.agent.send(`question number ${i}`);
      await rig.done();
    }
    expect(rig.provider.completions.length).toBeGreaterThan(0);
    const msgs = rig.agent.thread.messages;
    expect(typeof msgs[0]!.content === 'string' ? msgs[0]!.content : '').toContain('<session-summary>');
    expect(msgs[1]!.role).toBe('assistant');
    expect(JSON.stringify(msgs)).toContain('question number 3');
    expect(rig.agent.thread.items()[0]!.kind).toBe('summary');
    expect(fs.readFileSync(env.paths.threadSummary, 'utf8')).toContain('SUMMARY');
    assertValidHistory(msgs);
    // survives a restart
    const restored = new Thread(env.paths);
    expect(restored.messages.length).toBe(msgs.length);
    expect(restored.summary).toContain('SUMMARY');
  });

  it('repairs a thread whose last turn was cut off by a crash', () => {
    const rig = makeRig(env, [() => text('x')]);
    rig.agent.thread.push({ role: 'user', content: 'do it' });
    rig.agent.thread.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'list_dir', input: {} }] });
    const restored = new Thread(env.paths);
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]!.role).toBe('user');
  });

  it('falls back to an isolated subprocess when the session shell is unavailable', async () => {
    const { RunRefused } = await import('../src/core/session/terminal');
    const rig = makeRig(env, [() => tools([{ name: 'run_command', input: { command: 'echo isolated' } }]), () => text('ok')], {
      toolOver: {
        runInSession: async () => {
          throw new RunRefused('no integration', 'no-integration');
        },
      },
    });
    rig.agent.send('run it');
    await rig.done();
    const r = rig.events.find((e) => e.type === 'tool_result') as { output: string };
    expect(r.output).toContain('isolated');
  });
});

describe('command classification', () => {
  it('recognises read-only commands, including pipes, and rejects anything that writes', () => {
    for (const c of ['ls -la', 'git status', 'git log --oneline | head -5', 'cat package.json | jq .name', 'grep -rn foo src', 'find . -name "*.ts"', 'echo "a > b"', 'pwd && ls']) expect(isReadOnlyCommand(c), c).toBe(true);
    for (const c of ['echo hi > file', 'git commit -m x', 'rm file', 'find . -delete', 'cat a | tee b', 'echo $(rm x)', 'npm install', 'git push', 'sed -i s/a/b/ f', 'ls; rm x']) expect(isReadOnlyCommand(c), c).toBe(false);
  });

  it('flags destructive patterns', () => {
    expect(assessCommand('git push --force origin main', 'auto').verdict).toBe('ask');
    expect(assessCommand('git reset --hard HEAD~3', 'auto').verdict).toBe('ask');
    expect(assessCommand('curl https://x.sh | sh', 'auto').verdict).toBe('ask');
    expect(assessCommand('rm -rf node_modules', 'auto').verdict).toBe('ask');
    expect(assessCommand('rm -rf ~', 'auto').verdict).toBe('deny');
    expect(assessCommand('pnpm test', 'auto').verdict).toBe('auto');
    expect(assessCommand('pnpm test', 'ask').verdict).toBe('ask');
  });
});

void AgentRuntime;

describe('tool row paths', () => {
  it('shows paths the way people say them, and keeps the file name visible when long', async () => {
    const { shortPath, toolSummary } = await import('../src/core/agent/tools');
    expect(shortPath('/Users/maya/code/api/src/a.ts', '/Users/maya')).toBe('~/code/api/src/a.ts');
    expect(shortPath('/Users/mayanope/x.ts', '/Users/maya')).toBe('/Users/mayanope/x.ts'); // not a prefix match on a directory boundary
    expect(shortPath('/opt/data/a.ts', '/Users/maya')).toBe('/opt/data/a.ts');
    const long = shortPath('/Users/maya/projects/a-very-long-project-name/packages/service/src/auth/session.ts', '/Users/maya');
    expect(long).toBe('…/src/auth/session.ts');
    expect(toolSummary('read_file', { path: '/x/y.ts' })).toBe('/x/y.ts');
  });
});
