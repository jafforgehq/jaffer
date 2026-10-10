import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePaths, type JafferPaths } from '../../src/shared/paths';
import { ConfigStore } from '../../src/shared/config';

export interface TestEnv {
  root: string;
  home: string;
  userHome: string;
  paths: JafferPaths;
  config: ConfigStore;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-test-')));
  const home = path.join(root, '.jaffer');
  const userHome = path.join(root, 'user');
  fs.mkdirSync(userHome, { recursive: true });
  const paths = makePaths(home);
  const config = new ConfigStore(paths);
  return { root, home, userHome, paths, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }) };
}

/**
 * The environment without what belongs to a Claude Code, an Anthropic setup or a Jaffer this test run may itself run inside of (started
 * from a Jaffer terminal, or by Claude Code), for a daemon that must see only what the test gives it. The kill switch
 * `JAFFER_NO_LAUNCHCTL` stays: no daemon a test starts may ever reach the real launchd.
 */
export function cleanEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) if (k === 'JAFFER_NO_LAUNCHCTL' || !/^(CCR_|CLAUDE|ANTHROPIC_|JAFFER_|ZDOTDIR|HISTFILE)/.test(k)) env[k] = v;
  return env;
}
