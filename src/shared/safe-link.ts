const MAX = 2048;
const HIDDEN = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** `uri` as an http(s) URL, or null (not text, longer than 2048 characters, whitespace, control or hidden characters, another scheme). */
function webUrl(uri: string): URL | null {
  if (typeof uri !== 'string' || uri.length > MAX || HIDDEN.test(uri)) return null;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * (1.4.1) The only links the terminal opens in the browser (OSC 8 links): `http:` and `https:`, at most 2048 characters (as written and
 * once normalised), no user name or password, no whitespace, control or hidden character. Returns the URL as the browser should get it, or null.
 */
export function safeLinkUrl(uri: string): string | null {
  const u = webUrl(uri);
  return u && !u.username && !u.password && u.href.length <= MAX ? u.href : null;
}

/** Why a web link was refused, for the one line the window says: a login in the link, or a link that is too long. Null for a link that opens and for anything that is not a web link. */
export function linkRefusal(uri: string): 'login' | 'long' | null {
  if (typeof uri !== 'string') return null;
  if (uri.length > MAX) return /^https?:/i.test(uri.slice(0, 6)) ? 'long' : null;
  const u = webUrl(uri);
  if (!u) return null;
  return u.username || u.password ? 'login' : u.href.length > MAX ? 'long' : null;
}
