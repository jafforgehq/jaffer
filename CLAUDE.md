# Jaffer — notes for coding agents

Jaffer is a macOS terminal (Electron + a detached session daemon) with one never-ending session and a self-evolving memory. Read `README.md` and `docs/ARCHITECTURE.md` first.

## Layout
- `src/core/session` — PTY host, shell integration (OSC 133/633), headless-xterm snapshots. `resources/shell/*` are the real scripts; `src/generated/shell-scripts.ts` is generated from them (`npm run gen`, checked in CI).
- `src/core/memory` — store (journaled, revertible), heuristics (offline), reflector (model), consolidate, exports. Items are ranked by confidence × decay × usage × scope × BM25.
- `src/core/agent` — runtime loop (append-only history!), tools, permissions, Anthropic provider.
- `src/daemon` — `jafferd` service + RPC (`src/core/rpc.ts`, NDJSON over a unix socket). `src/cli` — `jaffer`. `src/core/mcp` — MCP server.
- `src/main` — Electron main/preload. `src/renderer` — Preact UI. `src/dev/bridge.ts` — browser↔daemon bridge used only by tests.

## Rules that matter
- The agent's system prompt and tool list must never change mid-conversation; per-turn data (memory, cwd) goes in the new user message. Thinking blocks are dropped from completed turns. Don't add anything that edits earlier messages.
- Anything that reaches memory, episodes or a model goes through `src/shared/redact.ts` first. Never persist command output of sensitive commands (`isSensitiveCommand`).
- The daemon owns the shell: never make the app a requirement for a running session.
- Don't use a global CSS class name that is also a layout utility (`.row`) for state (we shipped that bug once). CSS here is global: before adding a modifier class (`.tag.run`, `.row-ico.agent`, `.seg-btn.mem` were all real bugs), check it is not already a standalone selector (`.run`, `.agent`, `.mem`).
- The renderer's colours are layered tokens from `themes.ts` (`--chrome`, `--surface`, `--raised`); use them instead of literals so every theme works. The UI shows commands only through `safeCommand()` (redacts, hides sensitive ones).

## Verify
`npm run typecheck && npm test` (real PTYs, bash+zsh, bundled daemon/CLI as processes, the real Anthropic SDK against a mock API; `claude`-dependent tests skip if `claude` is absent). `npm run test:e2e` drives the UI in Chromium (`JAFFER_CHROME=/path/to/chrome`, screenshots in `$JAFFER_SHOTS`; use `?renderer=dom` for screenshots in headless). macOS CI also boots the packaged app (`JAFFER_SMOKE=1`).
