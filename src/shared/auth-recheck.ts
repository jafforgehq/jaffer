/** How long a known sign-in is trusted before the window regaining focus asks `claude auth status` again. */
export const AUTH_RECHECK_MS = 60_000;

/**
 * Should the app re-check the Claude login now (the window just came back to the front)? Signed out: always, because the
 * user may have just signed in somewhere else. Signed in or unknown: at most once a minute, since each check starts `claude`.
 */
export function shouldRecheckAuth(loggedIn: boolean | null, lastCheckAt: number, now: number): boolean {
  if (loggedIn === false) return true;
  return now - lastCheckAt >= AUTH_RECHECK_MS;
}
