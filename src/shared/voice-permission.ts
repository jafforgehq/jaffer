/**
 * The one microphone decision (Settings → Privacy and permissions → Voice). The page may use the microphone only while
 * `permissions.voice` is on, and only audio: never video, never audio plus video, and never when the kinds are not stated
 * (an unknown kind counts as no). Any other permission name is refused here; `clipboard-sanitized-write` is decided by `main.ts`.
 */
export function pageMayUseMic(voiceOn: boolean, permission: string, mediaTypes: readonly string[] | undefined): boolean {
  return permission === 'media' && voiceOn === true && Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio';
}
