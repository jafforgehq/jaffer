# Terminal first: a calm terminal, a mole, and a memory that learns

Date: 2026-10-07 · Status: decided with the product owner ("terminal like Ghostty, no fancy features, just animations when something is happening, a little pet and self-evolving memory"; option B, delete the extras, keep the mole).

## Why

Jaffer had grown a window full of panels around the terminal (a session sidebar with command lists, a live Claude panel, a status bar,
gutter stripes, stacking toasts). The product is: **a terminal with one session that never ends, a memory that learns by itself, and a
little life that shows when something is happening.** Claude Code is optional and adopted when connected.

## What stays

- The terminal (one session, one terminal, the daemon that owns the shell).
- **The mole**, now in the bottom-right corner of the terminal (click-through). Moods unchanged: sleep, rest, dig, alert, cheer.
- **Activity cues**: the ring/dot beside the folder in the title bar (spins only while something works), the mole, and the native
  notification when Claude needs the person.
- **Memory** that learns by itself, with one drawer to see, edit, pin and undo it (⇧⌘M, or the Memory button in the title bar), and
  quiet notices (only for something new learned).
- Claude Code integration in the background: the hooks that tell Jaffer what Claude is doing (they feed the mole and the
  notification), MCP and memory sharing in Settings → Claude Code, which now also holds the sign-in/install help the panel used to give.
- Settings (Appearance, Memory, Claude Code, Updates, Reset), the command palette, themes, updates, reset.

## What goes

- The left sidebar (session card, Claude row, recent commands, "Known here", footer) and ⌘B.
- The Claude panel (status, activity list, subagents, last reply, banners) and ⌘J, and everything that only fed it (`shortToolPath`,
  the lapsed-login recheck and its banners).
- The status bar.
- The command stripes in the terminal gutter and the command log that fed the sidebar.
- Their styles, tests and README screenshots.

## Consequences

- Claude is adopted from **Settings → Claude Code** (install help, sign in, Connect) or the palette; the plain-terminal note says so.
- The daemon, `claude.state`, the watcher and the hooks are unchanged: the mole and the notification depend on them.
- `session.info` still returns `recentCommands`; nothing in the app reads it any more (a later cleanup may drop it).
