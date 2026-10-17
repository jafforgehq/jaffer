import fs from 'node:fs';
import path from 'node:path';

/**
 * A stand-in for the `claude` CLI that only knows `claude auth status` and `claude auth login`, with a login state
 * the test can flip. Everything it was asked is appended to calls.log, one line per call: "<args> HOME=<home> KEY=<set if ANTHROPIC_API_KEY was in its environment>".
 *
 *   mode "ok"          status prints JSON (exit 0 when signed in, 1 when not); login signs in after a moment
 *   mode "garbage"     status prints text that is not JSON
 *   mode "crash"       status exits 2 with an error on stderr
 *   mode "hang"        status and login never finish
 *   mode "login-fail"  login exits 1 without signing in
 *
 * `interactive: 'stub'`: `claude` with no arguments (what typing `claude` in the terminal does) prints a line and exits 0 instead of
 * starting the real TUI, so a test can see that something started Claude Code without a TUI taking over the shell.
 * `claude mcp list` (1.4.0) prints the file mcp-list (`setMcpList`) and notes its folder in mcp.cwd and the Jaffer variables it got in
 * mcp.env; it never reaches the real claude. Modes: "mcp-slow" waits a second first, "mcp-hang" starts a child (its pid in mcp.child) and
 * waits for it, "mcp-orphan" leaves such a child behind (not on its output) and ends, "mcp-fail" exits 1 after printing.
 * `claude --help` (1.4.0, Explain) prints the options Explain needs (mode "explain-old": a help without them). `claude -p …` never
 * reaches the real claude: it notes its arguments (one per line) in explain.argv, its folder in explain.cwd and what was in it in
 * explain.ls, its stdin in explain.stdin and the variables it got in explain.env, prints a secret on stderr and then the file
 * explain-out (`setExplainOut`) or a fixed answer. Modes: "explain-hang" starts a child (its pid in explain.child) and waits for it,
 * "explain-fail" exits 1, "explain-slow" waits a second first, "explain-litter" leaves a folder in its own folder that cannot be removed
 * (a test must chmod it back); its JAFFER_* variables go to explain.jenv. Mode "help-hang": `--help` never finishes.
 * Any other command goes to `passthrough` (the real claude) when one is given, so a test can keep using the real thing
 * for everything but the login state.
 */
export function fakeClaude(dir: string, o: { loggedIn: boolean; mode?: string; passthrough?: string | null; interactive?: 'stub' }) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'claude');
  const state = path.join(dir, 'state');
  const mode = path.join(dir, 'mode');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(state, o.loggedIn ? 'in' : 'out');
  fs.writeFileSync(mode, o.mode ?? 'ok');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
D=${JSON.stringify(dir)}
REAL=${JSON.stringify(o.passthrough ?? '')}
INTERACTIVE=${JSON.stringify(o.interactive ?? '')}
echo "$* HOME=$HOME KEY=\${ANTHROPIC_API_KEY:+set}" >> "$D/calls.log"
M=$(cat "$D/mode")
S=$(cat "$D/state")
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  case "$M" in
    garbage) echo "Welcome to the fake claude. Nothing to see."; exit 0 ;;
    crash) echo "boom" >&2; exit 2 ;;
    hang) exec sleep 30 ;;
  esac
  if [ "$S" = "in" ]; then
    echo '{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com","orgName":"Example Org","subscriptionType":"max"}'
    exit 0
  fi
  echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'
  exit 1
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  case "$M" in
    hang) exec sleep 30 ;;
    login-fail) echo "login failed" >&2; exit 1 ;;
  esac
  sleep 0.3
  echo in > "$D/state"
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  pwd > "$D/mcp.cwd"
  echo "\${JAFFER_SESSION:-}|\${JAFFER_PANE:-}|\${JAFFER_OWNED:-}" > "$D/mcp.env"
  case "$M" in
    mcp-slow) sleep 1 ;;
    mcp-hang) sleep 30 & echo $! > "$D/mcp.child"; wait; exit 0 ;;
    mcp-orphan) sleep 30 >/dev/null 2>&1 & echo $! > "$D/mcp.child" ;;
  esac
  [ -f "$D/mcp-list" ] && cat "$D/mcp-list"
  [ "$M" = mcp-fail ] && exit 1
  exit 0
fi
if [ "$1" = "--help" ]; then
  [ "$M" = help-hang ] && exec sleep 30
  if [ "$M" = explain-old ]; then printf 'Usage: claude [options]\n  -p, --print  Print response and exit\n'; exit 0; fi
  printf 'Usage: claude [options] [command] [prompt]\n  -p, --print\n  --tools <tools...>\n  --strict-mcp-config\n  --no-session-persistence\n  --output-format <format>\n  --permission-prompts <target>\n  --safe-mode\n'
  exit 0
fi
if [ "$1" = "-p" ]; then
  printf '%s\n' "$@" > "$D/explain.argv"
  pwd > "$D/explain.cwd"
  ls -A > "$D/explain.ls"
  echo "\${JAFFER_SESSION:-}|\${JAFFER_PANE:-}|\${JAFFER_OWNED:-}|\${ANTHROPIC_API_KEY:-}|\${ANTHROPIC_AUTH_TOKEN:-}|\${JAFFER_NO_HOOKS:-}" > "$D/explain.env"
  env | grep '^JAFFER_' | sort > "$D/explain.jenv"
  cat > "$D/explain.stdin"
  echo "SECRET-STDERR the helper failed loudly" >&2
  case "$M" in
    explain-slow) sleep 1 ;;
    explain-hang) sleep 30 & echo $! > "$D/explain.child"; wait; exit 0 ;;
    explain-fail) exit 1 ;;
    explain-litter) mkdir locked && touch locked/f && chmod 500 locked; pwd > "$D/explain.litter" ;;
  esac
  if [ -f "$D/explain-out" ]; then cat "$D/explain-out"; else echo "It fixed the bug and suggests running the tests."; fi
  exit 0
fi
if [ "$#" -eq 0 ] && [ "$INTERACTIVE" = stub ]; then echo "fake claude: interactive session"; exit 0; fi
if [ -n "$REAL" ]; then exec "$REAL" "$@"; fi
echo "fake claude: unsupported: $*" >&2
exit 64
`,
    { mode: 0o755 },
  );
  return {
    dir,
    bin,
    setLoggedIn: (v: boolean) => fs.writeFileSync(state, v ? 'in' : 'out'),
    setMode: (m: string) => fs.writeFileSync(mode, m),
    setMcpList: (text: string) => fs.writeFileSync(path.join(dir, 'mcp-list'), text),
    setExplainOut: (text: string) => fs.writeFileSync(path.join(dir, 'explain-out'), text),
    read: (name: string): string => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').trim() : ''),
    calls: (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}
