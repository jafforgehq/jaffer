/**
 * Voice mode in the window (spec "Voice mode", "Speaking"): the signals around `flow.ts` and the places that feed it events. `/voice` (the palette,
 * `toggleVoice`) turns it on for the terminal that is focused then (the voice-start pane) and starts the engine; only that terminal's Claude is
 * spoken. Events fed here: Esc (twice in `ready` leaves), the start pane closing, the window hidden, `permissions.voice` turned off, the start pane's
 * Claude changing state. Memory only: the mode, the start pane and the reply text for the call. Dictation (Task 8): `record` opens the microphone
 * (`recorder.ts`), `window.jaffer.voice.mic()` asks macOS once per voice session, and the text goes into the start pane through the one
 * `type()` call below (the typing rule is `flow.ts`'s `deliver`), or to the clipboard with the reason (`copyToTerminal`). The samples and
 * the text live for the call only.
 */
import { effect, signal } from '@preact/signals';
import { activePane, cfg, claudeFor, openSettings, overlay, panes, toast } from '../state';
import { terminals } from '../components/TerminalView';
import { copyToTerminal } from '../resume';
import { record } from './recorder';
import { createFlow } from './flow';
import { onCrash, speak, startEngine, stopEngine, stopSpeaking, transcribe } from './engine';
import type { VoiceMode } from './session';
import { voiceStatus } from './status';

export const voiceMode = signal<VoiceMode>('off');
/** The engine is still loading its models (the Now card says "Preparing voice…"). */
export const voicePreparing = signal(false);
/** The terminal that was focused when voice mode started; null while it is off. */
export const voicePane = signal<string | null>(null);

const flow = createFlow({
  engine: { startEngine: () => startEngine(), stopEngine, speak, stopSpeaking, onCrash, transcribe },
  reply: async (session) => {
    const r = await window.jaffer.call<{ ok: boolean; text?: string }>('claude.reply', { session });
    return r?.ok === true && typeof r.text === 'string' ? r.text : null;
  },
  speed: () => cfg.value?.voice?.speed ?? 1,
  say: (text) => toast({ kind: 'info', text }),
  onMode: (m) => { voiceMode.value = m; if (m === 'off') voicePane.value = null; },
  onPreparing: (on) => (voicePreparing.value = on),
  now: () => Date.now(),
  dictation: {
    micAccess: () => window.jaffer.voice.mic(),
    record: (signal) => record({ signal }),
    voiceOn: () => cfg.value?.permissions?.voice === true,
    startPane: () => voicePane.value,
    activePane: () => activePane.value,
    claudeState: (pane) => claudeFor(pane)?.state,
    type: (pane, text) => terminals.get(pane)?.type(text), // the only typing of dictation: the cleaned text, no Enter
    copy: copyToTerminal,
  },
});

/** What `/voice` runs: needs the switch on and the files ready (else Settings → Privacy says why), then turns voice mode on or off. */
export async function toggleVoice(): Promise<void> {
  if (flow.mode() === 'off') {
    if (cfg.value?.permissions?.voice !== true) {
      toast({ kind: 'info', text: 'Voice is off. Turn it on in Settings → Privacy and permissions first.' });
      return openSettings('privacy');
    }
    if (voiceStatus.value !== 'ready') {
      toast({ kind: 'info', text: voiceStatus.value === 'downloading' ? 'The voice files are still downloading.' : 'The voice files are not on this Mac yet. Download them in Settings → Privacy and permissions.' });
      return openSettings('privacy');
    }
    voicePane.value = activePane.value;
  }
  await flow.toggle();
}
export const leaveVoice = (): void => flow.end('switch-off');
/** The Now card's button: stops a speech, else leaves voice mode. */
export const stopVoice = (): void => flow.stopButton();

if (typeof window !== 'undefined') {
  // Esc: captured, because the terminal's own handler consumes it. Not ours while a dialog, a popover, the tour, a menu or a text field has it.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || flow.mode() === 'off' || overlay.value) return;
    const t = e.target as HTMLElement | null;
    if (document.querySelector('.lr-pop, .lr-tour')) return;
    if (t?.closest?.('[role="alertdialog"], [role="dialog"], [role="menu"], input, select, [contenteditable="true"], textarea:not(.xterm-helper-textarea)')) return;
    flow.esc(); // (never stopped or prevented: the terminal still gets its Esc)
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flow.end('window-hidden'); });
  // the switch withdrawn (Settings, `jaffer config`, another window)
  effect(() => { if (voiceMode.value !== 'off' && cfg.value?.permissions?.voice !== true) flow.end('switch-off'); });
  // the start pane closed
  effect(() => { const p = voicePane.value; if (p && !panes.value.includes(p)) flow.end('switch-off'); });
  // the start pane's Claude: a finished turn is read aloud, a new one cuts the speech
  effect(() => {
    const p = voicePane.value;
    const s = p ? claudeFor(p) : null;
    flow.observe(s ? { id: s.id, state: s.state, cutShort: s.cutShort } : null);
  });
}
