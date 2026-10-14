# 1.1.1: past conversations with titles, and a click that resumes

Date: 2026-10-14 · Status: scope decided by the owner in conversation: titles from the conversation (answered), resume on click (answered "Go" after the table of cases).

## Why
Every past conversation of a person who starts Claude in `~` says `~`: nothing tells them apart. And a click only copies; the owner wants it to resume.

## Rulings
- **Titles widen the transcript rule by one line of text.** Besides the existing fields (id, cwd, first/last timestamps, token usage) the daemon reads a **title** for the 50 listed conversations: Claude's own summary/title line when the transcript has one (`type: 'summary'` with a string `summary`, or the fields `aiTitle` / `customTitle` on any line), otherwise the first real user message's first line. A "real user message" is a line with `type: 'user'`, `message.role === 'user'`, not `isMeta`, text content (a string, or the first text part of an array) that does not start with `<` (system tags such as `<command-name>`, `<local-command-caveat>`). The text is clipped to 200 characters, passed through `redactText` (input first clipped to 4096), then clipped to 80 characters, one line, control characters removed. Only the head 64 KB and tail 64 KB of a file are read for it. The title is shown only to the person in the window and the menu bar menu; never stored on disk, never logged, never sent anywhere; it is rebuilt on request and cached in memory only (as the cost is, keyed by path+size+mtime). Nothing else from message text is read or returned.
- **Resume types, after a click, exactly this and nothing else:** `claude --resume <id>` (when the shell is already in the conversation's folder, `info.cwd === cwd`) or `cd '<folder>' && claude --resume <id>`, preceded by Ctrl-U (clears a half-typed line) and followed by Enter. The id passes `isSessionId`; the folder is the transcript's `cwd` (absolute, no control characters, at most 4096, already validated by the daemon) single-quoted with `'` written as `'\''`. Typed **only** when the terminal is at an idle prompt: `info.busy` is empty (the shell's marks) — never while any command runs, and never while Claude runs (`isClaudeCommand(busy)`): then nothing is typed, the command is copied and a toast says why ("Claude is already running here: quit it first (/exit)" / "<command> is running: command copied"). A conversation without a known folder is only copied ("Folder unknown: command copied"). This replaces "the only thing typed into the shell is `claude`" by "`claude`, and on a click on a past conversation, the line above".
- The tray menu's conversation items still only copy (the main process cannot type); their labels use the title when there is one.
- Everything else of the panel stays.

## Features
1. **Title** (daemon): `Conversation.title?: string` in `claude.history` (see ruling). Tests with planted secrets: a secret word in a later message or tool input never appears; a token-looking string in the first message is redacted; `<command-name>`-style first lines are skipped; summary lines win; 1 MB/8 MB lines bounded; no new reads outside the head/tail windows.
2. **List rows show the title** (bold, one line, ellipsis; "Conversation" when none), and below it muted: folder (`~/…`) · time · duration · cost. The filter matches title and folder.
3. **Row click resumes** (rules above); **Enter** on the selected row too; a small **copy button** on each row copies the same command (with the `cd` when the folder differs). After typing: toast "Resuming…", focus to the terminal. A pure `resumeAction(info, conversation): {kind:'type', text} | {kind:'copy', text, why}` decides (unit-tested; the renderer only executes it).
4. **Menu bar items** use the title (clipped to 40) when there is one, else the folder name.

## Testing
Unit: title extraction (formats, skips, redaction, bounds), `resumeAction` truth table (idle same folder, idle other folder, Claude running, other command running, no folder, odd folder names with spaces/quotes/newlines refused, bad id), quoting. UI e2e (real bash + fake claude): click types the exact line at an idle prompt (same folder and `cd` with a folder containing a space and a quote), Ctrl-U clears a half-typed line, busy command and running Claude refuse and copy, copy button, Enter, title shown/filter. THE PERSON'S REAL MAC: temp HOMEs only.

## Release
1.1.1; `docs/releases/v1.1.1.md` replaces v1.1.0.md; README, ARCHITECTURE, CLAUDE.md (the transcript rule with titles; the typing rule); screenshots regenerated (panel shots show titles). Not verified on a real Mac: real Claude transcript formats across versions for titles, resume typing into zsh/bash with real prompts.
