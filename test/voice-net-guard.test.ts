import { describe, expect, it } from 'vitest';
import { installNetGuard } from '../src/renderer/voice/net-guard';

/** The guard against a stand-in worker scope (node has none, so importing the module installs nothing here). */
describe('voice worker net guard', () => {
  const make = () => {
    const seen: string[] = [];
    const scope: Record<string, any> = {
      fetch: async (u: unknown) => { seen.push(String(u)); return new Response('ok'); },
      XMLHttpRequest: class {}, importScripts: () => {}, WebSocket: class {}, EventSource: class {}, Worker: class {}, SharedWorker: class {}, WebTransport: class {},
      caches: { open: async () => ({}) },
      navigator: { sendBeacon: () => true },
    };
    installNetGuard(scope);
    return { scope, seen };
  };

  it('fetch refuses the network and serves data: and blob:', async () => {
    const { scope, seen } = make();
    await expect(scope.fetch('https://example.com/x')).rejects.toThrow(/no network/);
    await expect(scope.fetch('file:///etc/passwd')).rejects.toThrow(/no network/);
    await expect(scope.fetch(new URL('http://localhost:1/'))).rejects.toThrow(/no network/);
    expect(seen).toEqual([]);
    await expect(scope.fetch('data:text/plain,hi')).resolves.toBeInstanceOf(Response);
    await scope.fetch('blob:null/1');
    expect(seen).toEqual(['data:text/plain,hi', 'blob:null/1']);
  });

  it('removes the other ways out', async () => {
    const { scope } = make();
    for (const n of ['importScripts', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'WebTransport']) expect(scope[n]).toBeUndefined();
    expect(() => new scope.XMLHttpRequest()).toThrow(/no network/);
    await expect(scope.caches.open('kokoro-voices')).rejects.toThrow(/no network/);
    expect(scope.navigator.sendBeacon('https://example.com', 'x')).toBe(false);
  });
});
