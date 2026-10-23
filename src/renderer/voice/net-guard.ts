/**
 * The voice worker's network guard. A side-effect module that `worker.ts` imports FIRST, so esbuild evaluates it before any library
 * code (transformers.js, onnxruntime-web, kokoro-js, phonemizer) runs. A worker loaded from the `file://` page has no CSP of its own,
 * so this is the barrier: `fetch` serves only `data:` and `blob:` URLs, and every other way to reach out (XHR, `importScripts`,
 * WebSocket, EventSource, nested workers, WebTransport, `sendBeacon`, CacheStorage) is removed or throws. A dynamic `import()` of a
 * URL cannot be stopped from JS: `worker.ts` clears ORT's `wasmPaths` at module level, which is the one place a library does that.
 */
type Scope = Record<string, unknown> & { fetch?: typeof fetch; navigator?: Record<string, unknown> };

const refuse = () => { throw new TypeError('The voice worker has no network.'); };

export function installNetGuard(scope: Scope): void {
  const realFetch = scope.fetch?.bind(scope);
  const guarded = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(typeof Request !== 'undefined' && input instanceof Request ? input.url : input);
    if (realFetch && (u.startsWith('data:') || u.startsWith('blob:'))) return realFetch(input, init);
    return Promise.reject(new TypeError('The voice worker has no network.'));
  }) as typeof fetch;
  const set = (name: string, value: unknown) => Object.defineProperty(scope, name, { value, configurable: true, writable: true });
  set('fetch', guarded);
  set('XMLHttpRequest', function XMLHttpRequest() { refuse(); });
  for (const name of ['importScripts', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'WebTransport']) set(name, undefined);
  // (worker.ts replaces this with its in-memory model cache, which never fetches)
  set('caches', { open: async () => refuse(), match: async () => undefined, has: async () => false, keys: async () => [], delete: async () => false });
  if (scope.navigator && 'sendBeacon' in scope.navigator) {
    try { Object.defineProperty(scope.navigator, 'sendBeacon', { value: () => false, configurable: true }); } catch { /* not configurable */ }
  }
}

if (typeof self !== 'undefined' && typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') installNetGuard(self as unknown as Scope);
