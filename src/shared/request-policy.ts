/**
 * (voice) The window's session refuses every network request: the page, its workers and the libraries they load see only local
 * schemes. A worker on a `file://` page has no CSP and a dynamic `import()` of a URL cannot be guarded from JavaScript, so this is
 * the boundary. Pure, so the test pins it; `main.ts` wires it into `webRequest.onBeforeRequest`.
 */

/** The schemes the window may load: its own page, inline data, blobs it made, DevTools and the blank page. */
const ALLOWED = new Set(['file:', 'data:', 'blob:', 'devtools:', 'about:']);

/** True only for a URL whose scheme is local; anything unparsable is refused (fail closed). */
export function requestAllowed(url: string): boolean {
  try {
    return ALLOWED.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The `urls` filter of the `onBeforeRequest` call: only network schemes reach the callback (allowed schemes never do). */
export const BLOCKED_URL_FILTER: string[] = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'];
