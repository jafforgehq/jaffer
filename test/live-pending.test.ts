import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JafferService } from '../src/daemon/service';
import { makeEnv, type TestEnv } from './helpers/env';

/** (1.4.1 final) A prompt whose start offset is still being read (queued behind a Stop's read) must not show the previous turn plus the new one as "so far". */
let env: TestEnv;
let was: string | undefined;
beforeEach(() => {
  env = makeEnv();
  was = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = was;
  env.cleanup();
});

const reply = (id: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: output } } })}\n`;

describe('readLive and a prompt that is not read yet', () => {
  it('skips a session whose prompt start is pending; once it is read, the figure counts only the new turn', async () => {
    const dir = path.join(env.userHome, '.claude', 'projects', '-p');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    fs.writeFileSync(file, reply('old', 100)); // the previous turn
    const svc = new JafferService({ paths: env.paths, userHome: env.userHome });
    const a = svc as any;
    try {
      const ev = (name: string) => ({ session_id: 's1', hook_event_name: name, transcript_path: file, cwd: '/p' });
      a.config.patch({ claude: { showCost: true, liveCost: true } });
      a.turnStart.set('s1', 0); // where the previous turn began; its Stop read is still queued
      let release!: () => void;
      a.costChain = new Promise<void>((r) => (release = r)); // a controllable queue: nothing in it runs until released
      a.claudeWatcher.handle(ev('UserPromptSubmit'));
      const hooked = a.trackCost(ev('UserPromptSubmit')); // reads the new start at once, but the step that records it is queued
      await hooked;
      fs.appendFileSync(file, reply('new', 7));
      await a.readLive();
      expect(a.claudeWatcher.sessions().find((s: any) => s.id === 's1').live).toBeUndefined(); // (not "107")
      release();
      await a.costChain;
      await a.readLive();
      expect(a.claudeWatcher.sessions().find((s: any) => s.id === 's1').live.output).toBe(7);
    } finally {
      a.stopping = true;
      for (const t of a.costTimers) clearTimeout(t);
    }
  });
});
