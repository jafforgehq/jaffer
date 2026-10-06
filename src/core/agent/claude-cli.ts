import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LlmClient } from '../memory/llm';
import { findClaude } from '../integrations/claude';

/**
 * Memory curation through the user's own Claude Code login (`claude -p`), for people who have Claude Code but no
 * API key. It runs tool-less in a scratch directory, without session files (so it never feeds back into transcript
 * ingestion) and without Jaffer's own hooks (so it is not primed with the memory it is curating).
 */
export class ClaudeCliLlm implements LlmClient {
  constructor(
    private claudePath: string,
    private env: NodeJS.ProcessEnv = process.env,
    private model = 'haiku',
  ) {}

  static async detect(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCliLlm | null> {
    const p = await findClaude(env);
    return p ? new ClaudeCliLlm(p, env) : null;
  }

  complete(req: { system: string; user: string; maxTokens?: number; model?: string }): Promise<string> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-curate-'));
    const model = req.model && !req.model.startsWith('claude-') ? req.model : this.model;
    const args = ['-p', '--output-format', 'text', '--model', model, '--system-prompt', req.system, '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config'];
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudePath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...this.env, JAFFER_NO_HOOKS: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => (clearTimeout(timer), reject(e)));
      child.on('close', (code) => {
        clearTimeout(timer);
        fs.rmSync(cwd, { recursive: true, force: true });
        if (code === 0 && out.trim()) resolve(out);
        else reject(new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 300)}`));
      });
      child.stdin.end(req.user);
    });
  }
}
