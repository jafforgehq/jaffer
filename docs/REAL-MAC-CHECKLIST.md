# Real-Mac checklist (about 25 minutes)

Jaffer's tests run in a browser and with stand-ins. These are the things only a real Mac can show, ordered by how much they matter. Tick a box when it behaves as written. Anything that doesn't: note the step and what you saw, and tell Claude.

Setup: install the signed build from the Releases page (or let 1.4.0 offer the update). Use a throwaway folder for the Claude steps (`mkdir ~/jaffer-trial && cd ~/jaffer-trial`). Do not test *Settings → Reset* on a Mac you care about; it is not on this list.

## 1. Install and update (3 min)
- [ ] Open the downloaded app: no Gatekeeper warning (it is signed and notarized). *Expect:* it opens.
- [ ] Older version installed? *Settings → Updates → Check*, then **Update and restart**. *Expect:* the prompt says the terminal ends; the new version starts with one terminal and a What's New card.
- [ ] Start Jaffer twice (open it again from Finder). *Expect:* the second one exits and the first comes to the front.
- [ ] In Terminal.app (not in Jaffer): `ELECTRON_RUN_AS_NODE=1 /Applications/Jaffer.app/Contents/MacOS/Jaffer -e 'console.log(42)'`. *Expect:* no `42`: Jaffer opens (or comes to the front) instead.

## 2. Quit and close (4 min)
- [ ] Run `sleep 300`. Press **⌘Q**. *Expect:* a question (Cancel is the default; Esc and Return both cancel). Cancel keeps `sleep` running.
- [ ] With nothing running, **⌘Q** quits at once.
- [ ] Click the red ✕. *Expect:* the window hides; the menu bar item stays; Jaffer is still running. First time: one notification "still running in the menu bar".
- [ ] In full screen, click ✕. *Expect:* it leaves full screen, then hides (no empty Space left behind). Show it again from the menu bar item.
- [ ] Run `sleep 300`, then **Apple menu → Log Out** (or Restart) and cancel at the macOS prompt. *Expect:* Jaffer asks nothing of its own (a system quit never asks).

## 3. Menu bar item (3 min)
- [ ] The icon appears and is tinted correctly in light and dark menu bars.
- [ ] Start `claude` in a terminal. *Expect:* the icon animates while it works and flashes when it needs you.
- [ ] Right-click the icon: the menu opens. Hold ⌥ and right-click: extra lines appear.
- [ ] *Past Claude Conversations* items copy a resume command. *All Past Conversations…* opens the panel.
- [ ] *Help → What's New…* and *Keyboard Shortcuts* (⌘/) open.

## 4. Split terminals (4 min)
- [ ] **⌘D** three times: four terminals in a 2×2 grid. **⌘D** a fifth time: "At most four terminals."
- [ ] **⌘1** to **⌘4**, **⌘]**, **⌘[** move focus (an outline shows which).
- [ ] Make the window as small as it goes with four terminals. *Expect:* usable, if cramped (note how it looks).
- [ ] Run `sleep 300` in a terminal that is *not* focused, then **⌘Q**. *Expect:* the quit question appears.
- [ ] Click a terminal's ✕ while a command runs: an inline question names it. *End terminal* closes it. The last terminal's ✕ restarts it fresh.
- [ ] Open the side panel: a **Terminals** section sits between Now and Past conversations, one row per terminal. *New terminal* adds one; a row's *Split here* opens a new terminal in that row's folder; the ✕ closes it (an inline question when something runs).
- [ ] Double-click a name (or **F2**), type a name, Enter: the row and the terminal's chip show it. Empty removes it. Drag a row onto another (or **⌥↑ / ⌥↓**): the order, the grid and **⌘1**-**⌘4** follow.
- [ ] **⇧⌘↩** (and *Shell → Zoom Terminal*): the focused terminal fills the window and the others vanish; focus another from the panel and the zoom moves; **⇧⌘↩** again restores the grid (the real keypress, not a shim).
- [ ] *Close idle…* (with `sleep 300` running in one terminal): the question counts only the idle ones, never the focused one or the one running; *Cancel* is the default.
- [ ] Each terminal has its own companion; one working shows work only in its own terminal. With two terminals, a terminal where Claude works (and one that needs you) has a coloured outline; idle ones do not. Check Animations off and Reduce motion: no pulse.
- [ ] Start `claude` in two terminals (different folders). When one needs you or finishes while Jaffer is in the background: the notification starts with that terminal's folder. Click it (and, separately, its *Show* button): that terminal is focused, not the other one. With a permission prompt (experimental setting on), *Answer in terminal* in the panel also switches to the asking terminal. (The title-bar chip and the approval card still do not name the terminal.)

## 5. Notifications and the hotkey (3 min)
- [ ] The global hotkey (default Control-`) shows and hides Jaffer from another app.
- [ ] Let `claude` finish a turn of 30 s or more while Jaffer is in the background. *Expect:* a "Claude finished" notification; clicking it shows the window.
- [ ] *Settings → Appearance → Window → Drop-down mode* on. Press the hotkey with the pointer on each display you have. *Expect:* the window drops from the top of that display and hides when you click elsewhere. Turn it off: your normal size returns.

## 6. A real Claude session (4 min)
- [ ] In the trial folder run `claude` and ask for something small. *Expect:* the companion works, the Now card shows tool, time, an estimated cost and a context percentage; the cost is in the same range as Claude Code's own `/cost`.
- [ ] Past conversations lists it with a sensible title. Click it from another terminal at an idle prompt: `claude --resume <id>` appears and runs. Try in a shell with your own prompt config (zsh plugins, vi mode if you use it).
- [ ] **⇧⌘R** (Resume Last) while a command runs: it copies the command and says why.

## 7. Removing conversations (2 min; uses the Trash)
- [ ] Make a throwaway conversation (`claude -p hi` in the trial folder), then remove it from the panel (trash icon). *Expect:* a native question, then it lands in the Trash with its folder.
- [ ] In the Trash choose **Put Back**, then `claude --resume <id>` finds it again.

## 8. Permission prompts (experimental, 3 min)
- [ ] *Settings → Privacy and permissions → Answer permission prompts…* on. In the trial folder ask Claude to run a harmless command that needs approval.
- [ ] *Expect:* a notification with **Show** and **Deny** (check their order and where macOS shows them), and Allow/Deny in the Now card. **Deny** makes Claude Code report a denial. Doing nothing for 20 s: Claude Code's own prompt appears.
- [ ] Note whether Claude Code's own prompt appeared *immediately* or only after the 20 s wait. Tell Claude either way.

## 9. Explain and Setup (3 min)
- [ ] Before: note how many conversations the panel lists. Turn on *Explain…* in Privacy, click **Explain the last answer**. *Expect:* a plain-words card. After: **no new conversation** in the list and no new entry for a temp folder.
- [ ] *Setup → Check MCP servers* shows your servers' states (it starts them briefly).

## 10. Accessibility and links (2 min)
- [ ] Turn VoiceOver on (⌘F5): with *Screen reader support = Auto*, the terminal text is read.
- [ ] `printf '\e]8;;https://example.com\e\\link\e]8;;\e\\\n'` then ⌘-click "link": the browser opens. A click without ⌘ does nothing.
- [ ] Try a light theme: the companion's seasonal touch, turn bars and cards look right.

## 11. Staying awake (1 min)
- [ ] While Claude works: `pmset -g assertions | grep -i caffeinate` shows the hold; after it finishes, the hold goes.

When you're done, send Claude the unticked lines and any notes. Everything ticked here can come off the README's *Not verified here* list.
