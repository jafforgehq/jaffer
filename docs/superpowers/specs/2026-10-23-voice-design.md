# Voice: Claude speaks, the person dictates (design)

Status: draft for review. Date: 2026-10-23.

## Goal

Let the person talk with Claude Code inside Jaffer. Claude's replies are read aloud with Kokoro 82M, and the person dictates into Claude's prompt with Whisper. Everything runs on the Mac, behind one setting that is off by default. Turning it on downloads the models and enables both directions.

## What the person asked for (and what is assumed)

Said by the person:
- Add Kokoro voice to the Jaffer terminal; one setting; turning it on downloads what is needed and enables everything.
- Two-way voice: Claude speaks and the person speaks back.
- Dictated text is typed into the prompt and Enter is never pressed.
- No hotkey: voice starts from a `/voice` command in the palette.
- Pause detection ends a recording; Esc cancels.
- Claude speaks only while voice mode is on, prose only (no code, paths or tool output).
- Hosting: a Web Worker in the renderer using transformers.js (approach A).
- Licence: accept espeak-ng (GPL-3.0-or-later) and relicense Jaffer to GPLv3.

Assumed (to be corrected if wrong):
- English only in the first version.
- Whisper `base.en` for speech-to-text.
- `voice.speed` is the only new tuning setting.

## Non-goals

Wake word or always-on listening; saved audio or transcripts; speech when voice mode is off; languages other than English; a hotkey; typing with Enter; a second window, a title-bar control or a chat box.

## Setting and consent

- New switch `permissions.voice` (default false) in Settings → Privacy and permissions, and in the first-run privacy stage like the others.
- Turning it on shows what happens: a download of roughly 150 to 400 MB (the exact size comes from the pinned file list), the microphone used only during dictation, and Claude's reply text read aloud. The download starts only after the person confirms.
- Turning it off stops all voice work at once and closes the microphone. Model files stay in `~/.jaffer/voice/` until the person chooses *Remove voice files*.
- Config adds only `permissions.voice` (false) and `voice.speed` (a number, default 1). Both follow the config conform rule (right kind, default present).

## Components

- `src/main/voice-models.ts`: downloads the model files from a fixed host list over HTTPS, checks a pinned SHA-256 for each, writes them to `~/.jaffer/voice/` (0700). It is the only new network code and runs once, after consent. A mismatch deletes the file and reports an error. No retry loop.
- Main serves the verified files to the page through the app's own page origin. The page never fetches models itself and `file://` stays blocked.
- `src/renderer/voice/worker.ts`: a Web Worker holding Kokoro (`kokoro-js`, with espeak-ng WASM for phonemes) and Whisper (`whisper-base.en`), both on transformers.js, WASM with WebGPU where available. Audio stays in memory.
- `src/renderer/voice/session.ts`: the state machine `off`, `ready`, `listening`, `transcribing`, `speaking`. Memory only.
- `src/shared/voice-text.ts` (pure): turns a reply into speakable prose. Skips code blocks, paths and tool output, redacts, clips to about 1,500 characters. Reply text comes from `lastReply` in `src/core/claude/explain.ts`, so the same confinement and redaction apply.
- `src/shared/voice-policy.ts` (pure): decides whether dictated text may be typed.
- A `/voice` palette action (`actions.ts`) and a small voice indicator in the panel's Now card. No title-bar control.
- The page's content security policy gains `wasm-unsafe-eval` and nothing else.

## Voice mode

- `/voice` from `off` goes to `ready` and starts the first recording. `/voice` again, or Esc twice, goes to `off`. Esc during `listening` cancels that recording and stays in `ready`.
- A pause of about 1.5 seconds ends a recording and sends it to Whisper.
- The microphone closes immediately when the window hides, the pane is lost, the setting is turned off, or voice mode ends.
- While Kokoro speaks, the microphone stays closed so Jaffer does not transcribe itself.

## Typing rule (new, narrow)

Dictated text is typed only if all of these hold at the moment of typing:
1. `permissions.voice` is on.
2. The pane that was focused when the recording started is still focused.
3. Claude Code runs in that pane and is idle (`claude.state`), so the text lands in Claude's prompt and never in a bare shell.
4. The text is cleaned: control characters, newlines and ESC are removed and it is cut to 500 characters. No `\r` or `\n` survives, so Enter cannot be sent.
5. No other voice typing is in flight (a one-shot lock like the resume line's).

If any check fails the text is copied to the clipboard and a toast says why. Nothing is typed.

## Speaking

- Speech starts when the turn finishes for the terminal where voice mode started. The text is the prose-only reply from `voice-text.ts`.
- A new turn or a new recording interrupts speech. Esc stops it.

## Privacy and permissions

- Microphone: the window's permission handlers grant `media` with `audioCapture` only, only to the app's own page, and only while `permissions.voice` is on. Every other permission stays refused. `NSMicrophoneUsageDescription` and the audio-input entitlement are added in the packaging (`build/entitlements.mac.plist` and the app's Info.plist settings).
- Audio is held in memory for one recording and dropped after transcription. It is never logged or written. Transcribed text is typed or copied and not kept.
- The model download host list and the files written to `~/.jaffer/voice/` are listed in `SECURITY.md`.

## Rules in CLAUDE.md that change

1. The permissions model lists `permissions.voice` as a sixth switch.
2. The typing rule gains the dictation path with the five conditions above.
3. The transcript-read rules gain the speech read (assistant prose only, via `lastReply`, same confinement as Explain).
4. The "what Jaffer keeps" list gains the voice state (memory only) and the model files on disk.
5. The permission-handler rule gains `audioCapture` and the invariants test is updated with it.
6. The config-keys list gains `permissions.voice` and `voice.speed`.
7. The panel rule notes the voice indicator in the Now card.

## Licence

espeak-ng is GPL-3.0-or-later (checked in its README on 2026-10-23). Jaffer is MIT today. Decision: bundle espeak-ng and relicense Jaffer to GPLv3. The relicense step includes: replace `LICENSE`, set `"license": "GPL-3.0-or-later"` in `package.json`, include espeak-ng's licence text and notices in the app, and check every dependency's licence for GPL compatibility before the commit. The phonemizer sits behind one function in the worker, so a permissive one could replace espeak-ng later without changing the design.

## Errors

All are toasts or Now-card lines. Nothing is typed on failure.
- Download fails or checksum mismatches: file deleted, switch stays on, card shows *Retry download*.
- macOS denies the microphone: card says so and points to System Settings. Voice mode stays `off`.
- No speech, or only noise tokens from Whisper: back to `ready`, no toast.
- Typing refused: text copied and a toast gives the reason.
- Worker crashes or runs out of memory: voice mode ends, microphone closes, card offers *Restart voice*.
- Switch turned off during recording or speech: everything stops and the microphone closes.

## Testing

- Unit: `voice-policy.ts` (every condition, Enter-injection attempts, the 500-character cut), `voice-text.ts` (code, paths, tool output, clip, redaction), the state machine, checksum and pinned-URL logic.
- Source scans in `test/invariants.test.ts`: the permission handler grants only `clipboard-sanitized-write` and, with the switch on, `audioCapture`; no voice `pty.write` outside the one typing path; no audio written to disk; model download only through `voice-models.ts`.
- `ALLOWED_PAGE_METHODS` and its test updated for any new RPC.
- e2e in Chromium with a fake microphone and fake models: `/voice` start and stop, Esc cancel, typed text without Enter, refusal when Claude is busy.
- Not covered by the suite and listed in the README's *Not verified here*: a real microphone, real model quality and latency on Intel and Apple Silicon, whether Claude Code's prompt accepts the typed text like a person's typing, and pause detection with background noise.

## Build order

1. Relicense to GPLv3 with the dependency licence check and espeak-ng notices.
2. Setting, consent flow, model download and verification (pins the exact file list, sizes and hashes).
3. Speech output: Kokoro in the worker, the prose extractor, the Now-card indicator.
4. Dictation: microphone permission, recording and pause detection, Whisper, the typing policy, the `/voice` palette action.
5. Docs: CLAUDE.md rules, `SECURITY.md`, README, release notes, glossary entry.
