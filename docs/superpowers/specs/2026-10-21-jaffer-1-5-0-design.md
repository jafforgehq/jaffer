# Jaffer 1.5.0 — terminals you can see and steer

Status: scope given by the owner on 2026-10-21 ("do all 10, for 2 have pet live in every terminal"). Minor bump 1.4.2 → 1.5.0 (a new side-panel section). No new IPC channel, no new daemon method, no new config key, nothing written to disk.

## Why
With more than one terminal (1.4.0) the person can only add, close and find terminals through ⌘D, ⇧⌘W and a small ✕ on each pane's chip. The one companion sits in the bottom-right corner of the whole terminal area: it covers the text of the bottom-right terminal and shows only the focused Claude. Notifications do not say which terminal asks. This release gives the terminals a home in the side panel, a pet in every terminal, and a few small steering tools.

## The ten items
1. **Terminals section in the side panel** (the panel's second section, between *Now* and *Past conversations*): one row per terminal, a **+** to add, ✕ per row to close.
2. **A pet in every terminal.** Each `.pane` holds its own companion in its own bottom-right corner (`Pet({pane})`), reading only that terminal's Claude, running command, bell, "fixed it" and quiet time. The single `Pet` in `.terminal-area` goes away. Same companion kind, size and `appearance.pet` switch for all.
3. **Notifications name the terminal and focus it.** With 2+ terminals, "Claude finished", "Claude needs you" and the approval notification start the body with the terminal's folder; a click, or *Show*, focuses that terminal (main sends the page the existing-channel event `app.focus-pane {pane}`). *Answer in terminal* in the window also focuses the asking terminal.
4. **Reorder terminals** by dragging a row (HTML5 drag) or ⌥↑ / ⌥↓ on a focused row. Order decides the grid cell and ⌘1..⌘4. No dragging inside the grid.
5. **Rename a terminal**: a label of at most 24 characters (control and format characters removed, spaces collapsed), kept in memory, shown on the pane's chip and the panel row. Empty clears it. Double-click the name or F2 on a row edits it.
6. **Close idle terminals**: in the section, an inline question ("End N idle terminals?" with *End* / *Cancel*, Cancel focused). Idle means no running command and no Claude in it. It never ends the focused terminal nor a busy one, so at least one stays.
7. **Split here**: a row button opens a new terminal in that row's folder (`pane.split {pane: <row>}`); the **+** splits the focused one.
8. **Zoom one terminal**: ⇧⌘↩ (menu *Shell → Zoom Terminal*, palette, a row button) shows only the focused terminal over the whole area; the others keep running and keep their size (hidden with `display:none`; `TerminalView` already skips a fit under 20 px). Zoom follows focus (focusing another terminal moves it), ends when a terminal is added or the zoomed one closes, and does nothing with one terminal ("Only one terminal."). Memory only.
9. **State outline**: with 2+ terminals a pane's outline is the *working* colour while its Claude works and the *needs-you* colour while it waits (a quiet pulse unless Reduce motion / Animations off); the focused outline keeps priority when idle.
10. **Per-terminal cost and context** on each row's second line (only with `claude.showCost`): the figures the Now card shows for that session (estimated cost, context %), else the running command, else "idle".

## Rulings
- Version **1.5.0**, not 1.4.3: a new panel section changes the documented layout.
- The earlier idea "pet in the panel / corner / off setting" is dropped: the owner chose a pet in every terminal; no setting.
- Notification text uses the folder name (from the session's `cwd`, redacted, ≤ 40 characters), not the label: labels live in the window only (memory), main must not learn them (no new channel).
- Rows show no pet (the owner wants the pets in the terminals).

## Rules that change (CLAUDE.md, README, ARCHITECTURE, SECURITY unchanged in claims)
- The panel has **four** sections: *Now*, *Terminals*, *Past conversations*, *Setup*. The UI test pins them.
- Split view: pets inside `.pane`; `.pane` children are the terminal view, the chip, the close question and the pet; `.terminal-area` children no longer include `.pet-corner`.
- Still forbidden: tabs, a drag divider in the grid, a fifth terminal, saved layouts, title-bar buttons for terminals. The panel's Terminals section is the person's own controls; nothing types into a shell.
- Memory list gains: pane labels, the zoomed pane, the drag state, per-pane pet timers.
- The known limit "the notification, the chip and the approval card do not name the terminal" is replaced: the notification and the *Answer in terminal* path name/focus it; the title-bar chip and the approval card in the Now card still do not name the terminal (the Now card follows the focused terminal).

## Out of scope
A worktree per terminal, the diff panel, phone ping, layout restore (later releases). Tips/tour copy only changes where it states the old corner pet.
