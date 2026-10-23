/**
 * Voice: the download state the Settings card shows (memory only; nothing here is written). The files themselves are fetched,
 * verified and removed by main (`window.jaffer.voice`); this module only follows its events and asks. `permissions.voice` is the
 * person's consent and is patched only after the confirmation in Settings.
 */
import { signal } from '@preact/signals';
import { cfg, patchConfig, toast } from '../state';
import { voiceErrorSentence } from '../../shared/voice-ui';

export type VoiceStatus = 'off' | 'needs-download' | 'downloading' | 'ready' | 'error';
export const voiceStatus = signal<VoiceStatus>('off');
export const voiceProgress = signal<{ done: number; total: number }>({ done: 0, total: 0 });
/** A plain sentence for the last failure (never a path), or null. */
export const voiceError = signal<string | null>(null);
/** Whether every model file is on disk and verified (drives "Remove voice files"). */
export const voiceFilesPresent = signal(false);

let eventSeen = false; // a progress/done/error event arrived since enableVoice began
const bridge = () => window.jaffer.voice;
const isOn = () => cfg.value?.permissions?.voice === true;

/** main → page: `voice.progress`, `voice.done`, `voice.error` (called by the one event handler in state.ts). */
export function handleVoiceEvent(event: string, data: any): void {
  if (event === 'voice.progress') {
    eventSeen = true;
    const done = Number(data?.done), total = Number(data?.total);
    if (Number.isFinite(done) && Number.isFinite(total) && isOn()) {
      voiceProgress.value = { done, total };
      voiceStatus.value = 'downloading';
    }
  } else if (event === 'voice.done') {
    eventSeen = true;
    voiceError.value = null;
    voiceFilesPresent.value = true;
    voiceStatus.value = isOn() ? 'ready' : 'off';
  } else if (event === 'voice.error') {
    eventSeen = true;
    if (data?.code === 'aborted' && !isOn()) return; // (switched off: a cancel is not a failure)
    voiceError.value = voiceErrorSentence(data?.code);
    voiceStatus.value = isOn() ? 'error' : 'off';
  }
}

/** Looks at the disk (and the setting): at the app's start, when Settings opens and after a remove. A running download or an error is kept. */
export async function refreshVoiceStatus(): Promise<void> {
  let complete = false;
  try { complete = (await bridge().status()).complete === true; } catch { /* no bridge: nothing present */ }
  voiceFilesPresent.value = complete;
  if (!isOn()) voiceStatus.value = 'off';
  else if (voiceStatus.value === 'downloading' || (voiceStatus.value === 'error' && !complete)) return;
  else voiceStatus.value = complete ? 'ready' : 'needs-download';
}

/** The person confirmed: patch `permissions.voice` on, then download (main skips it when the files are already verified). */
export async function enableVoice(): Promise<void> {
  eventSeen = false;
  voiceError.value = null;
  voiceProgress.value = { done: 0, total: 0 };
  if (!isOn()) await patchConfig({ permissions: { voice: true } }); // (already consented: Download in the card, no patch)
  voiceStatus.value = 'downloading';
  try {
    await bridge().download();
  } catch {
    voiceError.value = voiceErrorSentence('unknown');
    voiceStatus.value = 'error';
    return;
  }
  if (voiceStatus.value !== 'downloading' || eventSeen) return; // an event already said how it went
  // main returned without starting (files already verified, or a cancel raced it) and sent nothing; give a running job a moment to speak
  await new Promise((r) => setTimeout(r, 1500));
  if (eventSeen || voiceStatus.value !== 'downloading') return;
  voiceFilesPresent.value = false;
  try { voiceFilesPresent.value = (await bridge().status()).complete === true; } catch { /* error below */ }
  if (voiceFilesPresent.value) voiceStatus.value = 'ready';
  else (voiceError.value = voiceErrorSentence('unknown'), (voiceStatus.value = 'error'));
}

/** Switch off: stop any download first, then withdraw the consent. The files stay until "Remove voice files". */
export async function disableVoice(): Promise<void> {
  try { await bridge().cancel(); } catch { /* the patch below is what matters */ }
  voiceError.value = null;
  voiceStatus.value = 'off';
  await patchConfig({ permissions: { voice: false } });
}

/** Delete the model files (main stops a download, then removes `<home>/voice`); a refusal is a toast. */
export async function removeVoiceFiles(): Promise<void> {
  try {
    await bridge().remove();
  } catch {
    toast({ kind: 'error', text: 'Jaffer could not remove the voice files.' });
  }
  voiceError.value = null;
  if (voiceStatus.value === 'downloading' || voiceStatus.value === 'error') voiceStatus.value = isOn() ? 'needs-download' : 'off';
  await refreshVoiceStatus();
}
