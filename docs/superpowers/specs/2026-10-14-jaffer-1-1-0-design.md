# 1.1.0: a side panel with the live Claude status and past conversations

Date: 2026-10-14 · Status: scope decided by the owner in conversation ("I want a side panel with cool options including past conversations"; answered: sections *Past conversations + Now*, *right side, open by default*, *one release 1.1.0 with the two small fixes*). The two fixes (no bright line down the right edge: the search ruler's border; the five newest past conversations right in the menu bar menu) are already committed on `main` (e2c1d55) and ship in this release.

## Rulings
- The old rule "no sidebar, no drawer" is lifted for **exactly this one panel**. Still forbidden: tabs, splits, a second window, a chat or prompt box, anything typed into the shell.
- The panel shows only what the window already has: `claude.state` (redacted, basenames only for files), `claude.history` (ids, folders, times, token usage). Nothing new is read from transcripts; nothing new on disk except two config keys (`panel.open`, `panel.width`).
- Nothing is typed: a click on a conversation copies `claude --resume <id>` (after `isSessionId`).
- ⇧⌘O no longer opens an overlay: it opens the panel (when closed) and focuses the conversations search. The overlay (`PastConversations`) is replaced by the panel's section (shared list component).

## Features
1. **Side panel.** A column at the right of the terminal card (inside `.workspace`), default 300 px, resizable by dragging its left edge (220–480 px), opens and closes with **⌘B** (menu item *Toggle Side Panel*, palette *Toggle side panel*) and a button at the right of the title bar; open by default. State persists in `panel.open` (default true) and `panel.width` (default 300). The terminal re-fits when it opens, closes or is resized (no lost output, `pty.resize` once settled). Settings → Appearance: *Show the side panel* switch. In focus mode the panel fades with the other chrome. Closed: nothing renders (no hidden work, no polling).
2. **Now.** A card at the top: state with a dot (idle / working / needs you), the tool in use and the turn's elapsed time, a progress bar against `claude.typicalTurnMs` (as the ring), the live or last cost (`≈ $0.03 so far`; estimate wording on hover, `claude.showCost` and `claude.liveCost` rules as the title bar's chip), today's cost against the budget (bar, colours as the chip), the running agents (`Agent 1 · Read · 2m 10s`, ids never shown), this turn's counts by category (`3 reads · 2 edits · 1 shell`), the files edited this turn (basenames, up to 8, click reveals in Finder through `jaffer:reveal-path`), and after a turn ends the last turn's summary line. No Claude session: "Claude is not running" with a hint (⇧⌘C starts it). Only calls with `startedAt >= turnStartedAt` count (the stale-turn rule).
3. **Past conversations.** Below the card, filling the rest: a search input (filters by folder), rows grouped by day (Today, Yesterday, then dates): folder name with the `~/…` path in muted text, time of day, duration, cost (`≈ $0.42`, `claude.showCost` only); the 50 newest from `claude.history`; refreshed when the panel opens, after each finished turn and on a refresh button; loading, empty ("No Claude Code conversations found.") and error states; a click or Enter copies `claude --resume <id>` and toasts "Copied. Paste it in the terminal."; keyboard: ⇧⌘O focuses the search, ↑/↓ move, Enter copies, Esc returns focus to the terminal.
4. **Menu bar:** *All Past Conversations…* opens the panel with the search focused (shows the window first).
5. **Included fixes:** the search ruler no longer draws a bright line on the right edge (`overviewRulerBorder` transparent); the menu bar menu lists the five newest conversations directly, loaded as soon as the icon exists.

## Layout and motion
`.workspace` becomes a row: terminal card (flex 1) + panel. Panel uses the layered tokens (`--surface`, `--raised`, `--line`), the card's radius; open/close slides over 180 ms (none with animations off or reduced motion); the resize handle is a 6 px hit area. Pins strip, sticky header, find bar, paste bar and pet stay inside the terminal card. The calm-window e2e test and the layout-alignment test are changed deliberately (the panel is an allowed child of `.workspace`).

## Testing
Pure: group-by-day, folder filter, row labels, `panelWidth` clamp, Now-card text builders (reuse the claude-ui helpers). UI e2e (DOM renderer): panel open by default, toggle by ⌘B/menu/button and persistence in config, drag resize clamps and persists, terminal columns change on resize (fit), Now card for idle/working/needs-you and files/agents/counts (injected `claude.state`), conversations list from planted transcripts in a temp HOME (as the existing history test), search, click copies `claude --resume <id>`, invalid id refused, nothing typed (terminal text unchanged), ⇧⌘O opens a closed panel and focuses the search, motion off. THE PERSON'S REAL MAC: temp HOMEs only.

## Release
1.1.0. `docs/releases/v1.1.0.md` replaces v1.0.1.md. README, ARCHITECTURE, CLAUDE.md (the narrowed sidebar rule, the panel), screenshot `19-side-panel.png`. Signed, notarized, uploaded, Latest. Not verified on a real Mac: the look in vibrancy/blur modes and the resize feel; listed in the README.

## Out of scope
Favorites, notes, project switcher, cost report, files/commands/ports/git sections (ideas for later), a second window, typing.
