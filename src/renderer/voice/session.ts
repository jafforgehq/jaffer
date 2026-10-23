/**
 * Voice mode as a pure reducer (no signals, no DOM: the controller keeps the signal). Spec "Voice mode".
 * 'start' is the /voice toggle: off -> ready, and /voice again from any running mode -> off.
 * 'heard' (speech began) ready -> listening; 'stop' ends a recording (listening -> transcribing) or speech (speaking -> ready);
 * 'text' (the transcript arrived) transcribing -> ready; 'reply' (a finished turn's prose is to be read; beyond the brief's list) ready -> speaking;
 * 'spoke' (speech ended) speaking -> ready. 'esc' cancels a recording (listening -> ready) or stops speech; a lone 'esc' in ready stays ready and
 * 'esc-esc' (the controller saw two in a row; kept out of this function so it stays pure) leaves. switch-off, window-hidden and worker-crashed
 * end voice from every mode. Anything else keeps the mode.
 */
export type VoiceMode = 'off' | 'ready' | 'listening' | 'transcribing' | 'speaking';
export type VoiceEvent = 'start' | 'stop' | 'esc' | 'esc-esc' | 'heard' | 'text' | 'reply' | 'spoke' | 'switch-off' | 'window-hidden' | 'worker-crashed';

export function step(mode: VoiceMode, ev: VoiceEvent): VoiceMode {
  if (ev === 'switch-off' || ev === 'window-hidden' || ev === 'worker-crashed') return 'off';
  switch (mode) {
    case 'off': return ev === 'start' ? 'ready' : mode;
    case 'ready': return ev === 'start' || ev === 'esc-esc' ? 'off' : ev === 'heard' ? 'listening' : ev === 'reply' ? 'speaking' : mode;
    case 'listening': return ev === 'esc' ? 'ready' : ev === 'stop' ? 'transcribing' : ev === 'start' || ev === 'esc-esc' ? 'off' : mode;
    case 'transcribing': return ev === 'text' ? 'ready' : ev === 'start' ? 'off' : mode;
    case 'speaking': return ev === 'spoke' || ev === 'stop' || ev === 'esc' ? 'ready' : ev === 'start' ? 'off' : mode;
    default: return mode;
  }
}
