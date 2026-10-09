import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAnthropic } from '../helpers/mock-anthropic';
import { cleanEnv } from '../helpers/env';
import { fakeClaude } from '../helpers/fake-claude';
import { makePaths } from '../../src/shared/paths';
import { tryConnect } from '../../src/core/daemon-client';
import { findClaude } from '../../src/core/integrations/claude';

/**
 * Generates the README screenshots: `npm run screenshots` (writes docs/screenshots/*.png).
 *
 * What is real: the renderer, the session daemon, a zsh PTY with Jaffer's shell integration, a git repository, the
 * mole and the memory engine. What is scripted: the Claude Code hook events the mole follows (what
 * `jaffer hook` would deliver from a real session, injected through the daemon so the run is deterministic and needs
 * no sign-in), and the demo project's test script, which prints output in the style of a JS test runner. Nothing here
 * is a mock-up image.
 */
const OUT = process.env.JAFFER_SCREENSHOTS;
const root = path.resolve(__dirname, '../..');
/** The real `claude`, when present: the first-run sign-in passes through a stand-in that answers `auth`, and the opt-in scene runs the real TUI. */
const CLAUDE = await findClaude().catch(() => null);
const CHROME = [process.env.JAFFER_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => p && fs.existsSync(p));

let tmp = '';
let userHome = '';
let repo = '';
let mock: MockAnthropic;
let bridge: ChildProcess;
let browser: Browser;
let page: Page;
let url = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 20_000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(80);
  }
}

async function termLines(): Promise<string[]> {
  return page.evaluate(() => {
    const t = (window as any).__jaffer.terminals.get('main').term;
    const b = t.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)!.translateToString(true));
    return out;
  });
}

const promptCount = (lines: string[]) => lines.filter((l) => l.includes('❯')).length;

/** Type a command like a person would and wait for the next prompt. */
async function typeCommand(cmd: string): Promise<void> {
  const before = promptCount(await termLines());
  await page.click('.term');
  await page.keyboard.type(cmd, { delay: 14 });
  await page.keyboard.press('Enter');
  await until(
    async () => {
      const lines = (await termLines()).filter((l) => l.trim());
      return promptCount(lines) >= before + 1 && /❯\s*$/.test(lines[lines.length - 1]!);
    },
    30_000,
    `prompt after "${cmd}"`,
  );
  await sleep(250);
}

async function shot(name: string): Promise<void> {
  fs.mkdirSync(OUT!, { recursive: true });
  await sleep(350); // let animations settle
  await page.screenshot({ path: path.join(OUT!, `${name}.png`) });
}

async function clearToasts(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const close = await page.$('.toast .icon-btn[aria-label="Dismiss"]');
    if (!close) break;
    await close.click().catch(() => undefined);
    await sleep(120);
  }
}

const remember = (text: string, kind: string, extra: Record<string, unknown> = {}) => page.evaluate((p) => window.jaffer.call('memory.remember', p), { text, kind, ...extra });

/** The caller's environment minus anything that would change how Claude Code or the shell behaves in the demo. */
function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Maya Chen', GIT_AUTHOR_EMAIL: 'maya@acme.dev', GIT_COMMITTER_NAME: 'Maya Chen', GIT_COMMITTER_EMAIL: 'maya@acme.dev' }, stdio: 'ignore' });
}

function writeDemoProject(): void {
  const w = (rel: string, body: string, mode?: number) => {
    const f = path.join(repo, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, { mode });
  };
  w('package.json', JSON.stringify({ name: 'acme-api', version: '2.4.1', private: true, type: 'module', scripts: { test: './bin/test' } }, null, 2) + '\n');
  w('README.md', '# acme-api\n\nBilling and auth API for Acme.\n');
  w('src/auth/token.ts', "export function parseBearer(header: string | undefined): string | null {\n  const m = /^Bearer (.+)$/.exec(header ?? '');\n  return m ? m[1]! : null;\n}\n");
  w(
    'src/auth/session.ts',
    [
      'export interface Session {',
      '  id: string;',
      '  userId: string;',
      '  expiresAt: number; // epoch ms',
      '}',
      '',
      'const TTL_MS = 30 * 60 * 1000;',
      '',
      'export function createSession(userId: string, now = Date.now()): Session {',
      '  return { id: crypto.randomUUID(), userId, expiresAt: now + TTL_MS };',
      '}',
      '',
      'export function isExpired(session: Session, now = Date.now()): boolean {',
      '  return session.expiresAt < now;',
      '}',
      '',
    ].join('\n'),
  );
  w(
    'src/auth/session.test.ts',
    [
      "import { createSession, isExpired } from './session';",
      '',
      "test('createSession sets a 30 minute expiry', () => {",
      "  expect(createSession('u_1', 0).expiresAt).toBe(1_800_000);",
      '});',
      '',
      "test('isExpired is true exactly at expiresAt', () => {",
      "  const s = createSession('u_1', 1_000);",
      '  expect(isExpired(s, s.expiresAt - 1)).toBe(false);',
      '  expect(isExpired(s, s.expiresAt)).toBe(true);',
      '});',
      '',
    ].join('\n'),
  );
  w('src/billing/invoice.ts', 'export const total = (lines: number[]) => lines.reduce((a, b) => a + b, 0);\n');
  const test = `#!/usr/bin/env bash
cd "$(dirname "$0")/.."
G=$'\\e[32m'; R=$'\\e[31m'; D=$'\\e[2m'; B=$'\\e[1m'; X=$'\\e[0m'; Y=$'\\e[33m'
sleep 0.4
echo
echo " \${B}RUN\${X}  v2.4.1 \${D}~/code/acme-api\${X}"
echo
echo " \${G}✓\${X} src/auth/token.test.ts \${D}(5 tests)\${X} \${D}12ms\${X}"
echo " \${G}✓\${X} src/billing/invoice.test.ts \${D}(9 tests)\${X} \${D}31ms\${X}"
if grep -q 'expiresAt < now' src/auth/session.ts; then
  echo " \${R}❯\${X} src/auth/session.test.ts \${D}(2 tests | 1 failed)\${X} \${D}8ms\${X}"
  echo "   \${G}✓\${X} createSession sets a 30 minute expiry"
  echo "   \${R}×\${X} isExpired is true exactly at expiresAt"
  echo "     \${R}→ expected false to be true // Object.is equality\${X}"
  echo
  echo "\${R}\${B} FAIL \${X} src/auth/session.test.ts > isExpired is true exactly at expiresAt"
  echo "\${R}AssertionError: expected false to be true // Object.is equality\${X}"
  echo " \${D}❯\${X} src/auth/session.test.ts:10:37"
  echo "      8|   const s = createSession('u_1', 1_000);"
  echo "      9|   expect(isExpired(s, s.expiresAt - 1)).toBe(false);"
  echo "     10|   expect(isExpired(s, s.expiresAt)).toBe(true);"
  echo "       |                                      \${R}^\${X}"
  echo
  echo " \${B}Test Files\${X}  \${R}1 failed\${X} | \${G}2 passed\${X} (3)"
  echo "      \${B}Tests\${X}  \${R}1 failed\${X} | \${G}15 passed\${X} (16)"
  echo "   \${B}Duration\${X}  412ms"
  exit 1
fi
echo " \${G}✓\${X} src/auth/session.test.ts \${D}(2 tests)\${X} \${D}6ms\${X}"
echo
echo " \${B}Test Files\${X}  \${G}3 passed\${X} (3)"
echo "      \${B}Tests\${X}  \${G}16 passed\${X} (16)"
echo "   \${B}Duration\${X}  398ms"
`;
  w('bin/test', test, 0o755);
  const dev = `#!/usr/bin/env bash
G=$'\\e[32m'; Y=$'\\e[33m'; R=$'\\e[31m'; D=$'\\e[2m'; B=$'\\e[1m'; C=$'\\e[36m'; X=$'\\e[0m'
echo
echo "  \${B}acme-api\${X} dev server \${D}v2.4.1\${X}"
echo
sleep 0.5
echo "  \${G}➜\${X}  Local:   \${C}http://localhost:4000/\${X}"
echo "  \${G}➜\${X}  Ready in \${B}312 ms\${X}"
echo
i=0
for line in "GET  /health            200 3ms" "POST /v1/sessions        201 41ms" "GET  /v1/invoices       200 18ms" "GET  /v1/invoices/9f2   200 9ms" "POST /v1/sessions/refresh 200 12ms" "GET  /v1/me             401 2ms" "GET  /v1/invoices       200 17ms" "PUT  /v1/profile        200 26ms" "GET  /health            200 2ms" "POST /v1/sessions        201 38ms" "GET  /v1/invoices       200 16ms" "GET  /v1/invoices/a71   200 8ms"; do
  i=$((i+1)); code=$(echo "$line" | awk '{print $(NF-1)}'); c=$G; [ "$code" -ge 400 ] && c=$Y
  printf '  %s  %s%s%s\\n' "\${D}$(date +%H:%M:%S)\${X}" "$c" "$line" "$X"
  sleep 0.55
done
sleep 30
`;
  w('bin/dev', dev, 0o755);
  git('init', '-q', '-b', 'main');
  const commit = (msg: string, date: string, files: string[]) => {
    git('add', ...files);
    execFileSync('git', ['commit', '-q', '-m', msg, '--date', date], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Maya Chen', GIT_AUTHOR_EMAIL: 'maya@acme.dev', GIT_COMMITTER_NAME: 'Maya Chen', GIT_COMMITTER_EMAIL: 'maya@acme.dev', GIT_COMMITTER_DATE: date } });
  };
  commit('Initial commit', '2026-09-22T10:02:11', ['README.md', 'package.json']);
  commit('Add invoice totals', '2026-09-24T15:41:03', ['src/billing']);
  commit('Add bearer token parsing', '2026-09-30T09:12:40', ['src/auth/token.ts']);
  commit('Add session expiry with 30 minute TTL', '2026-10-02T17:25:18', ['src/auth/session.ts', 'src/auth/session.test.ts', 'bin/test', 'bin/dev']);
  fs.appendFileSync(path.join(repo, 'README.md'), '\n## Testing\n\nRun `./bin/test`.\n');
}

describe.skipIf(!OUT)('README screenshots', () => {
  beforeAll(async () => {
    expect(CHROME, 'a Chromium binary is required (set JAFFER_CHROME)').toBeTruthy();
    execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'ignore' });
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-demo-')));
    userHome = path.join(tmp, 'maya');
    repo = path.join(userHome, 'code', 'acme-api');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(userHome, '.zshenv'), 'skip_global_compinit=1\n');
    fs.writeFileSync(
      path.join(userHome, '.zshrc'),
      [
        'setopt PROMPT_SUBST',
        'git_branch() { local b; b=$(git symbolic-ref --short HEAD 2>/dev/null) && print -n " %F{magenta}${b}%f"; }',
        "PROMPT='%F{blue}%~%f$(git_branch) %F{green}❯%f '",
        'alias ll="ls -lah"',
        '# the sandbox this demo is generated in injects its own variables; a real Mac has none of them',
        'for v in ${(k)parameters}; do [[ $v == CCR_* || $v == CLAUDE_* || $v == CLAUDECODE ]] && unset $v; done',
        'unset ANTHROPIC_API_KEY  # the app keeps its key in the Keychain; Claude Code gets its own (apiKeyHelper below)',
        '',
      ].join('\n'),
    );
    writeDemoProject();
    mock = new MockAnthropic();
    const mockUrl = await mock.listen();
    // the demo person is signed in to Claude: first run passes the sign-in step by itself (everything but `claude auth` is the real claude)
    const signedIn = fakeClaude(path.join(tmp, 'bin'), { loggedIn: true, passthrough: CLAUDE });
    bridge = spawn(process.execPath, [path.join(root, 'dist/dev/bridge.cjs')], {
      env: { ...cleanEnv(), PATH: `${signedIn.dir}:${process.env.PATH}`, JAFFER_HOME: path.join(userHome, '.jaffer'), HOME: userHome, SHELL: fs.existsSync('/usr/bin/zsh') ? '/usr/bin/zsh' : '/bin/zsh', ANTHROPIC_API_KEY: 'sk-ant-demo-0000000000000000', ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_BASE_URL: mockUrl, JAFFER_BRIDGE_TOKEN: 'tok', CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'), JAFFER_KEEP_ANTHROPIC_ENV: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: repo,
    });
    url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge did not start')), 20_000);
      bridge.stdout!.on('data', (d) => {
        const m = /BRIDGE (\S+)/.exec(d.toString());
        if (m) (clearTimeout(t), resolve(m[1]!));
      });
    });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    bridge?.kill();
    const c = await tryConnect(makePaths(path.join(userHome, '.jaffer')));
    await c?.call('app.shutdown', {}).catch(() => undefined);
    await sleep(400);
    await mock?.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  });

  it('first run, then a real working session', async () => {
    await page.goto(`${url}?debug=1&renderer=dom`);
    await page.waitForSelector('.onboard[data-step="choices"]', { timeout: 30_000 }); // sign-in passes by itself, then the consent choices
    await shot('01-welcome');
    // this demo person starts Claude Code themselves (the scripted session below stands in for it)
    await page.locator('.onboard .choices label', { hasText: 'Start Claude Code in the terminal now' }).locator('.switch').click();
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.term .xterm');
    await until(async () => (await termLines()).some((l) => l.includes('❯')), 30_000, 'the shell prompt');
    // the daemon starts the shell in $HOME; go to the project like a person would
    await typeCommand('cd ~/code/acme-api');
    await typeCommand('git log --oneline -4');
    await typeCommand('git status -sb');
    await typeCommand('./bin/test');
    await until(async () => /1 failed/.test((await termLines()).join('\n')), 10_000, 'the failing test output');
    await remember('Prefer pnpm over npm in every JavaScript project', 'preference', { pinned: true });
    await remember('Keep answers short: show the diff, skip the lecture', 'preference');
    await remember('Works on macOS with zsh; Homebrew lives in /opt/homebrew', 'environment', { source: 'agent' });
    await remember('Run ./bin/test before calling a fix done', 'workflow', { scope: 'project', cwd: repo, source: 'agent' });
    await remember('TypeScript strict mode; named exports only, no default exports', 'convention', { scope: 'project', cwd: repo });
    await sleep(600);
    await clearToasts();
  }, 120_000);

  it('the mole follows the Claude in the terminal: at work, waiting for you, then done', async () => {
    const session = path.join(repo, 'src/auth/session.ts');
    // where Claude Code would write the conversation: the answer's token counts are read from it (nothing else)
    const transcript = path.join(tmp, 'demo-transcript.jsonl');
    fs.writeFileSync(transcript, '');
    /** One Claude Code hook event, as `jaffer hook` would deliver it from inside this terminal. */
    const hook = (name: string, over: Record<string, unknown> = {}) => page.evaluate((p) => window.jaffer.call('claude.event', p), { session_id: 'demo-1', hook_event_name: name, cwd: repo, transcript_path: transcript, ...over });
    await hook('SessionStart', { model: 'claude-opus-5-5' });
    await hook('UserPromptSubmit', { prompt: 'why is the auth test failing?' });
    await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: session }, tool_use_id: 'd1' });
    await page.waitForSelector('.pet[data-mood="dig"]');
    await sleep(700); // let the motion be mid-way, not at its first frame
    await clearToasts();
    await shot('03a-digging');
    // three background agents: a helper mole for each, digging a beat apart
    for (const id of ['demo-sub-1', 'demo-sub-2', 'demo-sub-3']) await hook('SubagentStart', { agent_id: id, agent_type: id === 'demo-sub-1' ? 'Explore' : 'general-purpose' });
    await until(async () => (await page.locator('.pet-helper').count()) === 3, 8_000, 'three helper moles');
    // the longer they work the harder they dig: age the turn and the agents the way the daemon's clock would
    const aged = (await page.evaluate(() => window.jaffer.call('claude.state'))).sessions.map((s: any) => ({ ...s, since: Date.now() - 6 * 60_000, subagents: s.subagents.map((a: any, i: number) => ({ ...a, startedAt: Date.now() - [6 * 60_000, 150_000, 45_000][i]! })) }));
    await page.evaluate((sessions) => (window as any).__event('claude.state', { sessions }), aged);
    await sleep(1100);
    await shot('03b-crew');
    for (const id of ['demo-sub-1', 'demo-sub-2', 'demo-sub-3']) await hook('SubagentStop', { agent_id: id, agent_type: 'Explore' });
    await until(async () => (await page.locator('.pet-helper').count()) === 0, 8_000, 'the helpers to leave');
    await hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: session }, tool_use_id: 'd1', duration_ms: 42 });
    // it found the bug and proposes the fix: now it waits for the user
    const edit = { file_path: session, old_string: 'return session.expiresAt < now;', new_string: 'return session.expiresAt <= now;' };
    await hook('PreToolUse', { tool_name: 'Edit', tool_input: edit, tool_use_id: 'd2' });
    await hook('Notification', { message: 'Claude needs your permission to edit session.ts', notification_type: 'permission_prompt' });
    await page.waitForSelector('.pet[data-mood="alert"]');
    await sleep(500);
    await clearToasts();
    await shot('03-needs-you');
    // the user says yes in the terminal: the edit happens, then the tests run
    fs.writeFileSync(session, fs.readFileSync(session, 'utf8').replace(edit.old_string, edit.new_string));
    await hook('PostToolUse', { tool_name: 'Edit', tool_input: edit, tool_use_id: 'd2', duration_ms: 310 });
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: './bin/test' }, tool_use_id: 'd3' });
    await typeCommand('./bin/test');
    await until(async () => /16 passed/.test((await termLines()).join('\n')), 15_000, 'passing run in the terminal');
    await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: './bin/test' }, tool_use_id: 'd3', duration_ms: 1900 });
    // the answer, as Claude Code would have recorded it: (3000 × 4 + 4200 × 20 + 180000 × 0.2) / 1e6 ≈ $0.13 at Opus 5.5's list price
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'demo-a1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 3000, output_tokens: 4200, cache_read_input_tokens: 180_000 } } })}\n`);
    await hook('Stop', { last_assistant_message: 'Fixed.' });
    await page.waitForSelector('.pet[data-mood="cheer"]');
    await page.waitForSelector('[data-cost-chip]');
    await sleep(350);
    expect(fs.readFileSync(session, 'utf8')).toContain('expiresAt <= now');
    await shot('02-terminal');
  }, 120_000);

  it('memory the app has built up, and the log of how it changed', async () => {
    await remember('Session expiry checks must be inclusive (<=): tests freeze the clock at expiresAt', 'lesson', { scope: 'project', cwd: repo, source: 'agent' });
    await page.keyboard.press('Meta+Shift+M');
    await page.waitForSelector('.memory');
    await page.waitForSelector('.mem');
    await until(async () => (await page.$$('.mem')).length >= 6, 10_000, 'six memories');
    await shot('04-memory');
    await page.click('.tabs button:has-text("Activity")');
    await page.waitForSelector('.run');
    await clearToasts();
    await page.click('.tabs button:has-text("Learned")');
  }, 60_000);

  it('the other companions: the same busy moment in each, and the picker in Settings', async () => {
    await clearToasts();
    const sessions = () => page.evaluate(() => window.jaffer.call('claude.state')).then((r: any) => r.sessions as { id: string }[]);
    const end = (id: string) => page.evaluate(([i, cwd]) => window.jaffer.call('claude.event', { session_id: i, hook_event_name: 'SessionEnd', cwd }), [id, repo] as const);
    for (const x of await sessions()) await end(x.id);
    await sleep(700);
    // Claude has been working for six minutes with three agents of different ages (what the daemon would push, aged the way its clock would)
    const busy = () =>
      page.evaluate(() => {
        const now = Date.now();
        (window as any).__event('claude.state', {
          sessions: [{ id: 'demo-2', state: 'working', since: now - 6 * 60_000, subagents: [6 * 60_000, 150_000, 45_000].map((age, i) => ({ id: `c${i}`, type: i ? 'general-purpose' : 'Explore', status: 'running', startedAt: now - age })) }],
        });
      });
    // every crop is the same size (a scene plus a margin): the corner's bottom right, which for the mole is the main one and two helpers
    const crop = async (name: string) => {
      const b = (await page.locator('.pet-corner').boundingBox())!;
      const [w, h, pad] = [256, 96, 8];
      fs.mkdirSync(OUT!, { recursive: true });
      await page.screenshot({ path: path.join(OUT!, `${name}.png`), clip: { x: b.x + b.width + pad - w, y: b.y + b.height + pad - h, width: w, height: h } });
    };
    for (const companion of ['mole', 'matrix', 'agents', 'warp', 'radar', 'core']) {
      await page.evaluate((c) => window.jaffer.call('config.patch', { appearance: { companion: c } }), companion);
      await page.waitForSelector(`.pet-corner[data-companion='${companion}']`);
      await busy();
      await until(async () => (await page.locator(companion === 'mole' ? '.pet-helper' : '.scene[data-agents="3"]').count()) === (companion === 'mole' ? 3 : 1), 8_000, `${companion}: three agents`);
      await sleep(1500);
      await crop(`companion-${companion}`);
    }
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { companion: 'mole' } }));
    await end('demo-2');
    // the picker
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.click('.settings-nav button:text-is("Appearance")');
    await page.locator('.companions').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sleep(400);
    await shot('15-companions');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings', { state: 'detached' });
  }, 90_000);

  it('command palette, themes, settings', async () => {
    await clearToasts();
    if (await page.$('.side')) await page.keyboard.press('Meta+Shift+M'); // the memory drawer was open: the terminal gets the room back
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await sleep(300); // an Escape sent the instant it appears can be lost
    await page.keyboard.press('Escape');
    await page.waitForSelector('.palette input', { state: 'detached' });
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-light' } }));
    await until(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-solid').trim())) === '#fdfcfa', 8000, 'light theme');
    await shot('07-light');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-midnight' } }));
    await until(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-solid').trim())) === '#0d1020', 8000, 'midnight');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-dark' } }));
    await page.click('.term');
    await page.keyboard.type('clear', { delay: 14 });
    await page.keyboard.press('Enter');
    await sleep(600);
    await typeCommand('./bin/test');
    await sleep(500);
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await page.click('.settings-nav button:text-is("Claude Code")');
    await sleep(300);
    await shot('12-claude-code-settings');
    await page.click('.settings-nav button:text-is("Updates")');
    await sleep(200);
    await page.evaluate(() => (window as any).__event('update.state', { status: 'ready', current: '0.2.0', version: '0.2.1', auto: true })); // what Settings shows once a release is downloaded
    await page.waitForSelector('.upd-line[data-upd-status="ready"]');
    await shot('13-updates');
    await page.keyboard.press('Escape');
  }, 60_000);

  // Opt-in (JAFFER_CLAUDE_SHOT=1): the real Claude Code UI running inside Jaffer, talking to the scripted API. Run it on a
  // normal machine; inside a hosted sandbox Claude Code prints that sandbox's own auth warning, which would end up in the picture.
  it.skipIf(!process.env.JAFFER_CLAUDE_SHOT)('runs the real Claude Code inside the terminal', async () => {
    const claude = await findClaude().catch(() => null);
    if (!claude) return;
    const key = 'sk-ant-demo-0000000000000000';
    fs.writeFileSync(
      path.join(userHome, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 12, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: { [repo]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } }),
    );
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-dark' } }));
    await page.keyboard.press('Escape');
    fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' }, apiKeyHelper: `echo ${key}` }));
    await sleep(600);
    await page.click('.term');
    await page.keyboard.type('clear', { delay: 14 });
    await page.keyboard.press('Enter');
    await sleep(500);
    await page.keyboard.type('claude', { delay: 20 });
    await page.keyboard.press('Enter');
    await until(async () => /Claude Code/.test((await termLines()).join('\n')), 40_000, 'the Claude Code banner');
    await sleep(2500);
    mock.queue({
      kind: 'text',
      when: (b) => (b.tools?.length ?? 0) > 0 && JSON.stringify(b.messages ?? []).includes('last commit'), // the main request carries tools; the title generator does not
      text: 'The last commit, `3122e07`, adds session expiry with a 30 minute TTL:\n\n- `src/auth/session.ts` gets `createSession()` and `isExpired()`\n- `src/auth/session.test.ts` covers creation and the expiry boundary\n- `bin/test` is the small runner used by the suite\n\nAfter your uncommitted change, `isExpired()` is inclusive of `expiresAt`.',
    });
    await page.keyboard.type('summarize the last commit', { delay: 20 });
    await page.keyboard.press('Enter');
    try {
      await until(async () => /uncommitted change/.test((await termLines()).join('\n')), 40_000, 'Claude Code answer');
    } catch (e) {
      await shot('zz-debug');
      console.error((await termLines()).filter((l) => l.trim()).slice(-25).join('\n'));
      console.error('MOCK REQUESTS', mock.requests.map((r) => `${r.path} ${r.body?.model} ${JSON.stringify(r.body?.messages ?? []).slice(0, 120)}`).join('\n'));
      throw e;
    }
    await sleep(1200);
    await shot('11-claude-code');
  }, 150_000);

  it('a long-running process shows up everywhere it should', async () => {
    if ((await page.$$('.term .xterm')).length > 1) {
      await page.evaluate(() => (window as any).__menu('close-pane'));
      await until(async () => (await page.$$('.term .xterm')).length === 1, 10_000, 'back to a single pane');
    }
    await page.click('.term');
    await page.keyboard.type('clear', { delay: 14 });
    await page.keyboard.press('Enter');
    await sleep(600);
    await page.keyboard.type('./bin/dev', { delay: 20 });
    await page.keyboard.press('Enter');
    await until(async () => /Ready in/.test((await termLines()).join('\n')) && /GET\s+\/v1\/invoices\/9f2/.test((await termLines()).join('\n')), 20_000, 'dev server output');
    await until(async () => !!(await page.$('.session-pill .running')), 10_000, 'the running process in the toolbar');
    await sleep(1800);
    await page.keyboard.press('Control+c');
  }, 60_000);
});
