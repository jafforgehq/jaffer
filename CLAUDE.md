# Jaffer — notes for coding agents

Jaffer is a macOS terminal (Electron + a detached session daemon) with one never-ending session and a self-evolving memory. Read `README.md` and `docs/ARCHITECTURE.md` first.

## Layout
- `src/core/session` — PTY host, shell integration (OSC 133/633), headless-xterm snapshots. `resources/shell/*` are the real scripts; `src/generated/shell-scripts.ts` is generated from them (`npm run gen`, checked in CI).
- `src/core/memory` — store (journaled, revertible), heuristics (offline), reflector (model), consolidate, exports. Items are ranked by confidence × decay × usage × scope × BM25.
- `src/core/claude` — `watcher.ts` (pure state machine: what the terminal's Claude is doing, from its hook events) and `transcript-watch.ts` (notices a prompt declined in the terminal). `src/core/integrations` — `claude.ts` (MCP registration, hooks, finding `claude`) and `claude-auth.ts` (`claude auth status` / `claude auth login`). `src/core/agent` — only `permissions.ts` (command and path risk rules, kept for the approval cards of a later release) and `claude-cli.ts` (memory curation through `claude -p`).
- `src/daemon` — `jafferd` service + RPC (`src/core/rpc.ts`, NDJSON over a unix socket). `src/cli` — `jaffer`. `src/core/mcp` — MCP server.
- `src/main` — Electron main/preload. `src/renderer` — Preact UI. `src/dev/bridge.ts` — browser↔daemon bridge used only by tests.

## Rules that matter
- Anything that reaches memory, episodes or a model goes through `src/shared/redact.ts` first. Never persist command output of sensitive commands (`isSensitiveCommand`).
- The daemon owns the shell: never make the app a requirement for a running session.
- Jaffer is for Claude Code only. Don't add integrations, exports or copy for other agents (Codex, Gemini, ...); `export.targets` only knows `claude-code` and `ConfigStore` drops anything else a saved config still lists.
- Jaffer runs on Claude subscriptions only: there is no Anthropic API key anywhere (no UI, no RPC, no CLI command, no engine), and `ANTHROPIC_API_KEY` is ignored. Don't add key entry back without being asked.
- Whether the user is signed in to Claude comes only from `claude auth status` (`src/core/integrations/claude-auth.ts`): never read Claude's credential files or keychain item, and never let the account email or organisation out of that function. The first-run sign-in step has no skip and types nothing into the terminal; tests fake `claude` with `test/helpers/fake-claude.ts`.
- There is exactly one session and one terminal: no splits, tabs, extra panes or second windows. `SessionHost` only ever spawns `main` and the daemon has no RPC to create another; don't add one (tests in `session.test.ts`, `daemon.test.ts` and the UI e2e guard this).
- Don't use a global CSS class name that is also a layout utility (`.row`) for state (we shipped that bug once). CSS here is global: before adding a modifier class (`.tag.run`, `.row-ico.agent`, `.seg-btn.mem` were all real bugs), check it is not already a standalone selector (`.run`, `.agent`, `.mem`).
- The renderer's colours are layered tokens from `themes.ts` (`--chrome`, `--surface`, `--raised`); use them instead of literals so every theme works. The UI shows commands only through `safeCommand()` (redacts, hides sensitive ones).

- There is one Claude: the `claude` in the terminal. Don't add a second chat, a prompt box or a background `claude` that talks for the user; the panel only shows what Claude Code's hooks report. The hooks (`jaffer hook <event>`) are asynchronous, print nothing, exit 0 on every path, and do nothing unless `JAFFER_SESSION=1`; anything shown from a payload is redacted first (`ClaudeWatcher`). For the approvals release: Jaffer answers a permission prompt **allow** only after a human click, **deny** is always safe, and any failure leaves Claude Code's own prompt in charge. Never start `claude` with `--dangerously-skip-permissions` or a mode that auto-allows.
- Keystrokes injected into the user's shell must not be eaten by leftover input state: `runCommand` prefixes a NUL for bash and zsh (a pending Escape used to swallow the first byte). The product no longer injects commands itself, but the code and its tests stay; test any change to injection against bash and zsh.

## Verify
`npm run typecheck && npm test` (real PTYs, bash+zsh, bundled daemon/CLI as processes, the real `claude` against a mock API and `test/helpers/fake-claude.ts` for the sign-in; `claude`-dependent tests skip if `claude` is absent). `npm run test:e2e` drives the UI in Chromium (`JAFFER_CHROME=/path/to/chrome`, screenshots in `$JAFFER_SHOTS`; use `?renderer=dom` for screenshots in headless). macOS CI also boots the packaged app (`JAFFER_SMOKE=1`). Known flaky on a Mac, also on `main`: the real-`claude` TUI test and some PTY "refuses to inject" tests; the README screenshots test (`npm run screenshots`) is written for Linux CI (it needs a short `TMPDIR` because of the unix socket path limit, and `/bin/zsh` on macOS).
