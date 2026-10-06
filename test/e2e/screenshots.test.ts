import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAnthropic } from '../helpers/mock-anthropic';
import { makePaths } from '../../src/shared/paths';
import { tryConnect } from '../../src/core/daemon-client';
import { findClaude } from '../../src/core/integrations/claude';

/**
 * Generates the README screenshots: `npm run screenshots` (writes docs/screenshots/*.png).
 *
 * What is real: the renderer, the session daemon, a zsh PTY with Jaffer's shell integration, a git repository, the
 * agent runtime and the memory engine. What is scripted: the model's replies (a local stand-in for the Anthropic API,
 * so the run is deterministic and needs no key) and the demo project's test script, which prints output in the style
 * of a JS test runner. Nothing here is a mock-up image.
 */
const OUT = process.env.JAFFER_SCREENSHOTS;
const root = path.resolve(__dirname, '../..');
/** With the real `claude` binary present the demo conversation runs on the Claude Code engine (the real thing, with scripted replies). */
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

async function approveAll(): Promise<void> {
  for (;;) {
    const btn = await page.$('.approval .btn.primary');
    if (!btn) return;
    await btn.click();
    await sleep(300);
  }
}

async function ask(text: string): Promise<void> {
  const before = (await page.$$('.msg.user')).length;
  await page.fill('.composer textarea', text);
  await page.keyboard.press('Enter');
  await until(async () => (await page.$$('.msg.user')).length > before, 10_000, 'the question to appear');
}

const remember = (text: string, kind: string, extra: Record<string, unknown> = {}) => page.evaluate((p) => window.jaffer.call('memory.remember', p), { text, kind, ...extra });

/** The caller's environment minus anything that would change how Claude Code or the shell behaves in the demo. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CCR_|CLAUDE|ANTHROPIC_|JAFFER_|ZDOTDIR|HISTFILE)/.test(k)) env[k] = v;
  return env;
}

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
    bridge = spawn(process.execPath, [path.join(root, 'dist/dev/bridge.cjs')], {
      env: { ...cleanEnv(), JAFFER_HOME: path.join(userHome, '.jaffer'), HOME: userHome, SHELL: '/usr/bin/zsh', ANTHROPIC_API_KEY: 'sk-ant-demo-0000000000000000', ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_BASE_URL: mockUrl, JAFFER_BRIDGE_TOKEN: 'tok', CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'), JAFFER_KEEP_ANTHROPIC_ENV: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
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
    await page.waitForSelector('.onboard', { timeout: 20_000 });
    await shot('01-welcome');
    await page.click('.onboard .btn.primary');
    await page.waitForSelector('.term .xterm');
    if (CLAUDE) await page.evaluate(() => window.jaffer.call('config.patch', { agent: { engine: 'claude-code' } }));
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

  it('the agent investigates in the same terminal and asks before changing anything', async () => {
    const session = path.join(repo, 'src/auth/session.ts');
    // Claude Code's own tool names when it is the engine; Jaffer's when the API is
    const via = (claudeName: string, name: string) => (CLAUDE ? claudeName : name);
    const pathKey = CLAUDE ? 'file_path' : 'path';
    const main = CLAUDE ? { when: (b: any) => (b.tools?.length ?? 0) > 0 } : {};
    mock.reset().queue(
      { kind: 'tool', id: 'toolu_d1', name: via('Read', 'read_file'), input: { [pathKey]: session }, text: "That's the session expiry test. Let me look at the code it exercises.", ...main },
      {
        kind: 'text',
        text:
          '**Found it.** `isExpired()` in `src/auth/session.ts:14` compares with a strict `<`, so a session whose `expiresAt` equals the current millisecond still counts as valid. The test freezes the clock at exactly `expiresAt` and expects `true`.\n\n' +
          '```ts\nreturn session.expiresAt < now; // should be <=\n```\n\n' +
          'Making the check inclusive is the whole fix. Want me to apply it and re-run the tests?',
        thinking: 'The failing assertion is the boundary case. The comparison is strict.',
        ...main,
      },
    );
    await ask("why is the auth test failing?");
    await until(async () => /Found it/.test((await page.textContent('.thread')) ?? ''), 60_000, 'the diagnosis');
    await until(async () => !(await page.$('.working')), 15_000, 'turn to finish');

    mock.reset().queue(
      { kind: 'tool', id: 'toolu_d2', name: via('Edit', 'edit_file'), input: { [pathKey]: session, old_string: 'return session.expiresAt < now;', new_string: 'return session.expiresAt <= now;' }, text: 'Making the comparison inclusive.', ...main },
      { kind: 'tool', id: 'toolu_d3', name: via('mcp__jaffer-session__run_command', 'run_command'), input: { command: './bin/test' }, ...main },
      { kind: 'text', text: 'Fixed: `isExpired()` now treats `expiresAt` itself as expired, and the suite passes (**16/16**).\n\n- `src/auth/session.ts:14`: `<` became `<=`\n- ran `./bin/test` in your terminal, so the output above is the real run', ...main },
    );
    await ask('yes, fix it and run the tests');
    await page.waitForSelector('.approval', { timeout: 60_000 });
    await shot('03-approval');
    await approveAll();
    await until(async () => /Fixed:/.test((await page.textContent('.thread')) ?? ''), 60_000, 'the fix summary');
    await until(async () => !(await page.$('.working')), 15_000, 'turn to finish');
    await until(async () => /16 passed/.test((await termLines()).join('\n')), 15_000, 'passing run in the terminal');
    expect(fs.readFileSync(path.join(repo, 'src/auth/session.ts'), 'utf8')).toContain('expiresAt <= now');
    await shot('02-agent');
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
    await shot('05-memory-activity');
    await page.click('.tabs button:has-text("Learned")');
  }, 60_000);

  it('command palette, themes, settings', async () => {
    await clearToasts();
    await page.click('.seg-btn[title^="Claude"]').catch(() => undefined);
    await page.keyboard.press('Meta+p');
    await page.waitForSelector('.palette input');
    await shot('06-palette');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-light' } }));
    await until(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-solid').trim())) === '#fdfcfa', 8000, 'light theme');
    await shot('07-light');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-midnight' } }));
    await until(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-solid').trim())) === '#0d1020', 8000, 'midnight');
    await shot('08-midnight');
    await page.evaluate(() => window.jaffer.call('config.patch', { appearance: { theme: 'jaffer-dark' } }));
    await page.click('.term');
    await page.keyboard.type('clear', { delay: 14 });
    await page.keyboard.press('Enter');
    await sleep(600);
    await typeCommand('./bin/test');
    await page.keyboard.press('Meta+j'); // give the terminal the room
    await sleep(500);
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.settings');
    await shot('10-settings');
    await page.click('.settings-nav button:text-is("Claude")');
    await sleep(300);
    await shot('12-claude-settings');
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
    await page.keyboard.press('Meta+j'); // bring the agent panel back
    await sleep(500);
    await page.click('.term');
    await page.keyboard.type('clear', { delay: 14 });
    await page.keyboard.press('Enter');
    await sleep(600);
    await page.keyboard.type('./bin/dev', { delay: 20 });
    await page.keyboard.press('Enter');
    await until(async () => /Ready in/.test((await termLines()).join('\n')) && /GET\s+\/v1\/invoices\/9f2/.test((await termLines()).join('\n')), 20_000, 'dev server output');
    await until(async () => !!(await page.$('.session-pill .running')), 10_000, 'the running process in the toolbar');
    await sleep(1800);
    await shot('11-running');
    await page.keyboard.press('Control+c');
  }, 60_000);
});
