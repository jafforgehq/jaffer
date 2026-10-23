import { describe, expect, it } from 'vitest';
import { BLOCKED_URL_FILTER, requestAllowed } from '../src/shared/request-policy';

describe('requestAllowed (the window session refuses every network request)', () => {
  it('allows the local schemes the page loads from', () => {
    for (const u of ['file:///x/index.html', 'data:text/plain,hi', 'blob:null/abc', 'devtools://devtools/bundled/x.js', 'about:blank']) expect(requestAllowed(u), u).toBe(true);
  });

  it('refuses the network, other schemes and anything it cannot parse (fail closed)', () => {
    for (const u of ['https://cdn.jsdelivr.net/x.js', 'http://localhost:5173/', 'ws://x/', 'wss://x/', 'ftp://x/', 'chrome-extension://abc/x', 'javascript:alert(1)', '', 'not a url', 'HTTPS://EXAMPLE.COM/', 'https://user:pw@host/']) {
      expect(requestAllowed(u), u).toBe(false);
    }
  });

  it('filters exactly the five network schemes', () => {
    expect(BLOCKED_URL_FILTER).toEqual(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*']);
  });
});
