/**
 * (1.4.1) The only links the terminal opens in the browser (OSC 8 links and printed ones alike): `http:` and `https:`, at most 2048
 * characters, no user name or password, no whitespace, control or hidden character. Returns the URL as the browser should get it, or null.
 */
export function safeLinkUrl(uri: string): string | null {
  if (typeof uri !== 'string' || uri.length > 2048 || /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(uri)) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.href : null;
}
