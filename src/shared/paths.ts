import os from 'node:os';
import path from 'node:path';

/**
 * Everything Jaffer persists lives under one directory (default ~/.jaffer),
 * overridable with JAFFER_HOME so tests and side-by-side installs stay isolated.
 */
export interface JafferPaths {
  home: string;
  config: string;
  runDir: string;
  socket: string;
  pidFile: string;
  logFile: string;
  sessionDir: string;
  sessionState: string;
  screenSnapshot: string;
  thread: string;
  threadSummary: string;
  /** The working directory of the Claude Code engine's process (stable, so its session can always be resumed). */
  agentDir: string;
  cliThread: string;
  cliState: string;
  shellDir: string;
  binDir: string;
  memoryDir: string;
  memoryIndex: string;
  memoryItems: string;
  memorySkills: string;
  memoryTopicsDir: string;
  memorySkillsDir: string;
  memoryEpisodesDir: string;
  memoryJournal: string;
  memoryCursor: string;
  memoryPolicy: string;
  memoryNotes: string;
  memoryHistoryDir: string;
  secrets: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JAFFER_HOME;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), '.jaffer');
}

export function makePaths(home: string = resolveHome()): JafferPaths {
  const runDir = path.join(home, 'run');
  const sessionDir = path.join(home, 'session');
  const memoryDir = path.join(home, 'memory');
  return {
    home,
    config: path.join(home, 'config.json'),
    runDir,
    // Unix socket paths are limited to ~104 bytes on macOS; keep the name short.
    socket: path.join(runDir, 'jafferd.sock'),
    pidFile: path.join(runDir, 'jafferd.pid'),
    logFile: path.join(runDir, 'jafferd.log'),
    sessionDir,
    sessionState: path.join(sessionDir, 'state.json'),
    screenSnapshot: path.join(sessionDir, 'screen.json'),
    thread: path.join(sessionDir, 'thread.jsonl'),
    threadSummary: path.join(sessionDir, 'summary.md'),
    agentDir: path.join(home, 'agent'),
    cliThread: path.join(sessionDir, 'cli-thread.json'),
    cliState: path.join(sessionDir, 'cli-state.json'),
    shellDir: path.join(home, 'shell'),
    binDir: path.join(home, 'bin'),
    memoryDir,
    memoryIndex: path.join(memoryDir, 'MEMORY.md'),
    memoryItems: path.join(memoryDir, 'items.jsonl'),
    memorySkills: path.join(memoryDir, 'skills.jsonl'),
    memoryTopicsDir: path.join(memoryDir, 'topics'),
    memorySkillsDir: path.join(memoryDir, 'skills'),
    memoryEpisodesDir: path.join(memoryDir, 'episodes'),
    memoryJournal: path.join(memoryDir, 'journal.jsonl'),
    memoryCursor: path.join(memoryDir, 'cursor.json'),
    memoryPolicy: path.join(memoryDir, 'POLICY.md'),
    memoryNotes: path.join(memoryDir, 'NOTES.md'),
    memoryHistoryDir: path.join(memoryDir, 'history'),
    secrets: path.join(home, 'secrets.json'),
  };
}
