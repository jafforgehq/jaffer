/** Pure words for the voice setting (Settings → Privacy and permissions): the download size and the plain sentence for each failure code. No paths, no messages from the network. */
import { VOICE_TOTAL_BYTES } from './voice-manifest';

/** Bytes as "about N MB", N rounded to the nearest 5 MB (decimal megabytes, as Finder shows them). */
export function aboutMb(bytes: number = VOICE_TOTAL_BYTES): number {
  return Math.max(5, Math.round(bytes / 1_000_000 / 5) * 5);
}

const ERRORS: Record<string, string> = {
  network: 'The download stopped because the network failed. Check your connection and try again.',
  checksum: 'A downloaded file did not match what Jaffer expected, so it was thrown away. Try again.',
  host: 'The download was refused because it did not come from the expected server.',
  aborted: 'The download was cancelled.',
  disk: 'The download stopped because Jaffer could not write the file. Check that the disk has space and try again.',
};

/** One plain sentence for a main-process error code; an unknown code (or anything else) gets the generic one. */
export function voiceErrorSentence(code: unknown): string {
  return (typeof code === 'string' && Object.hasOwn(ERRORS, code) && ERRORS[code]) || 'The download failed. Try again.';
}

/** Whole percent done, 0..100 (0 when the total is not known yet). */
export function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 0;
}
