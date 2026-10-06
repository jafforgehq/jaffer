# Jaffer — notes for coding agents

Jaffer is a macOS terminal (Electron + a detached session daemon) with one never-ending session and a self-evolving memory. Read `README.md` and `docs/ARCHITECTURE.md` first.

## Layout
- `src/core/session` — PTY host, shell integration (OSC 133/633), headless-xterm snapshots. `resources/shell/*` are the real scripts; `src/generated/shell-scripts.ts` is generated from them (`npm run gen`, checked in CI).
- `src/core/memory` — store (journaled, revertible), heuristics (offline), reflector (model), consolidate, exports. Items are ranked by confidence × decay × usage × scope × BM25.
- `src/core/agent` — runtime loop (append-only history!), tools, permissions, Anthropic provider; `claude-engine.ts` runs the panel on the user's Claude Code login, `hub.ts` picks the engine, `assess.ts` is the shared tool policy.
- `src/daemon` — `jafferd` service + RPC (`src/core/rpc.ts`, NDJSON over a unix socket). `src/cli` — `jaffer`. `src/core/mcp` — MCP server.
- `src/main` — Electron main/preload. `src/renderer` — Preact UI. `src/dev/bridge.ts` — browser↔daemon bridge used only by tests.

## Rules that matter
- The agent's system prompt and tool list must never change mid-conversation; per-turn data (memory, cwd) goes in the new user message. Thinking blocks are dropped from completed turns. Don't add anything that edits earlier messages.
- Anything that reaches memory, episodes or a model goes through `src/shared/redact.ts` first. Never persist command output of sensitive commands (`isSensitiveCommand`).
- The daemon owns the shell: never make the app a requirement for a running session.
- Jaffer is for Claude Code only. Don't add integrations, exports or copy for other agents (Codex, Gemini, ...); `export.targets` only knows `claude-code` and `ConfigStore` drops anything else a saved config still lists.
- Whether the user is signed in to Claude comes only from `claude auth status` (`src/core/integrations/claude-auth.ts`): never read Claude's credential files or keychain item, and never let the account email or organisation out of that function. The first-run sign-in step has no skip and types nothing into the terminal; tests fake `claude` with `test/helpers/fake-claude.ts`.
- There is exactly one session and one terminal: no splits, tabs, extra panes or second windows. `SessionHost` only ever spawns `main` and the daemon has no RPC to create another; don't add one (tests in `session.test.ts`, `daemon.test.ts` and the UI e2e guard this).
- Don't use a global CSS class name that is also a layout utility (`.row`) for state (we shipped that bug once). CSS here is global: before adding a modifier class (`.tag.run`, `.row-ico.agent`, `.seg-btn.mem` were all real bugs), check it is not already a standalone selector (`.run`, `.agent`, `.mem`).
- The renderer's colours are layered tokens from `themes.ts` (`--chrome`, `--surface`, `--raised`); use them instead of literals so every theme works. The UI shows commands only through `safeCommand()` (redacts, hides sensitive ones).

- The Claude Code engine must answer every `can_use_tool` request itself (auto / ask the UI / deny). Never start `claude` with `--dangerously-skip-permissions` or a permission mode that auto-allows, and never give the terminal tools (`jaffer mcp --session`) to a Claude Code the user runs themselves.
- Keystrokes injected into the user's shell must not be eaten by leftover input state: `runCommand` prefixes a NUL for bash and zsh (a pending Escape used to swallow the first byte). Test any change to injection against bash and zsh.

## Verify
`npm run typecheck && npm test` (real PTYs, bash+zsh, bundled daemon/CLI as processes, the real Anthropic SDK against a mock API; `claude`-dependent tests skip if `claude` is absent). `npm run test:e2e` drives the UI in Chromium (`JAFFER_CHROME=/path/to/chrome`, screenshots in `$JAFFER_SHOTS`; use `?renderer=dom` for screenshots in headless). macOS CI also boots the packaged app (`JAFFER_SMOKE=1`).
