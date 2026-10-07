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
    calls: (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}
