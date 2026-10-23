import type { VNode } from 'preact';
import { stopVoice, voiceMode, voicePreparing } from '../voice/controller';

/** The Now card's voice line (only while voice mode is on): the mode in plain words and one button, Stop (a speech) or Turn off. */
export function VoiceLine(): VNode | null {
  const m = voiceMode.value;
  if (m === 'off') return null;
  const label = voicePreparing.value ? 'Preparing voice…' : m === 'speaking' ? 'Speaking…' : m === 'listening' ? 'Listening…' : m === 'transcribing' ? 'Writing it down…' : 'Voice on';
  return (
    <div class="voice-line" data-mode={voicePreparing.value ? 'preparing' : m} aria-live="polite">
      <span class="voice-line-label">{label}</span>
      <button class="btn ghost small" onClick={stopVoice} aria-label={m === 'speaking' ? 'Stop speaking' : 'Turn voice off'}>
        {m === 'speaking' ? 'Stop' : 'Turn off'}
      </button>
    </div>
  );
}
