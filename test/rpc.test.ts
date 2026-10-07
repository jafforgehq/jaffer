import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineDecoder, RpcClient, RpcError, RpcServer } from '../src/core/rpc';

describe('LineDecoder', () => {
  const lines = (chunks: string[], max?: number) => {
    const out: string[] = [];
    const d = new LineDecoder(max);
    for (const c of chunks) d.push(c, (l) => out.push(l));
    return out;
  };

  it('puts a message back together however the network cut it', () => {
    expect(lines(['{"a":1}\n{"b"', ':2}\n', '{"c":3}', '\n'])).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(lines(['x', 'y', 'z\n'])).toEqual(['xyz']);
  });

  it('gives several messages from one chunk, in order, and skips blank lines', () => {
    expect(lines(['one\n\n  \ntwo\nthree\n'])).toEqual(['one', 'two', 'three']);
  });

  it('keeps an unfinished line until its end arrives', () => {
    expect(lines(['half a lin'])).toEqual([]);
    expect(lines(['half a lin', 'e\n'])).toEqual(['half a line']);
  });

  it('takes a long stream without a newline in linear time, and is not fooled into re-scanning it', () => {
    const d = new LineDecoder();
    const chunk = 'x'.repeat(64 * 1024);
    const t0 = Date.now();
    let lines = 0;
    for (let i = 0; i < 400; i++) d.push(chunk, () => lines++); // 25 MB, never a newline
    d.push('end\n', () => lines++);
    expect(lines).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('gives each of many small lines in one big chunk in time that does not grow with the square', () => {
    const d = new LineDecoder();
    const out: string[] = [];
    const t0 = Date.now();
    d.push('{"a":1}\n'.repeat(200_000), (l) => out.push(l));
    expect(out).toHaveLength(200_000);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('drops a runaway peer that never ends a line, and carries on with the next line after it', () => {
    expect(lines(['x'.repeat(50), 'y'.repeat(50), 'ok\n'], 80)).toEqual(['ok']); // the first 100 were over the limit; "ok" starts a fresh buffer
  });
});

describe('RpcServer and RpcClient over a unix socket', () => {
  let dir: string;
  let sock: string;
  let server: RpcServer;
  const clients: RpcClient[] = [];
  const connect = async () => {
    const c = new RpcClient(sock);
    await c.connect(2000);
    clients.push(c);
    return c;
  };
  const until = async (fn: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(async () => {
    // unix socket paths are short-limited: /tmp, not a long per-user temp directory
    dir = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'jrpc-'));
    sock = path.join(dir, 's.sock');
    server = new RpcServer();
    server.handle('echo', (p) => p);
    server.handle('nothing', () => undefined);
    server.handle('boom', () => {
      throw new RpcError('it broke', 'EBOOM');
    });
    server.handle('plain-boom', () => {
      throw new Error('plain failure');
    });
    server.handle('slow', () => new Promise((r) => setTimeout(() => r('late'), 300)));
    await server.listen(sock);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers a call with its result; no result at all arrives as null', async () => {
    const c = await connect();
    expect(await c.call('echo', { a: [1, 2, { b: 'c' }] })).toEqual({ a: [1, 2, { b: 'c' }] });
    expect(await c.call('nothing')).toBeNull();
    expect(await c.call('echo')).toEqual({}); // no params become an empty object
  });

  it('answers many overlapping calls each with its own result', async () => {
    const c = await connect();
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => c.call('echo', { i })));
    expect(out.map((o) => o.i)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('reports a handler failure as an error with its message and code', async () => {
    const c = await connect();
    await expect(c.call('boom')).rejects.toMatchObject({ message: 'it broke', code: 'EBOOM' });
    await expect(c.call('plain-boom')).rejects.toMatchObject({ message: 'plain failure', code: undefined });
    await expect(c.call('echo', {})).resolves.toEqual({}); // and the connection is still good
  });

  it('says so about a method it does not have', async () => {
    const c = await connect();
    await expect(c.call('nope')).rejects.toMatchObject({ code: 'ENOMETHOD', message: expect.stringContaining('nope') });
  });

  it('ignores garbage and malformed requests and keeps serving the connection', async () => {
    const raw = net.createConnection(sock);
    raw.setEncoding('utf8');
    const got: string[] = [];
    raw.on('data', (d: string) => got.push(...d.split('\n').filter(Boolean)));
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write('not json\n{"id":"x","method":"echo"}\n{"id":1}\n{"method":"echo"}\n[]\n');
    raw.write(`${JSON.stringify({ id: 7, method: 'echo', params: { still: 'here' } })}\n`);
    await until(() => got.length >= 1);
    expect(got.map((g) => JSON.parse(g))).toEqual([{ id: 7, result: { still: 'here' } }]);
    raw.destroy();
  });

  it('shrugs off a line that is JSON but not a message (null, a number, a string), for the server and for the client', async () => {
    const raw = net.createConnection(sock);
    raw.setEncoding('utf8');
    const got: string[] = [];
    raw.on('data', (d: string) => got.push(...d.split('\n').filter(Boolean)));
    await new Promise<void>((r) => raw.once('connect', () => r()));
    raw.write('null\n42\n"text"\ntrue\n');
    raw.write(`${JSON.stringify({ id: 3, method: 'echo', params: { after: 'junk' } })}\n`);
    await until(() => got.length >= 1);
    expect(JSON.parse(got[0]!)).toEqual({ id: 3, result: { after: 'junk' } });
    raw.destroy();
    // and a server that sends such lines to a client does not break it
    const odd = net.createServer((s) => {
      s.write('null\n7\n');
      s.on('data', (d) => {
        const m = JSON.parse(String(d).split('\n')[0]!);
        s.write(`${JSON.stringify({ id: m.id, result: 'fine' })}\n`);
      });
    });
    const oddSock = path.join(dir, 'odd.sock');
    await new Promise<void>((r) => odd.listen(oddSock, () => r()));
    const c = new RpcClient(oddSock);
    await c.connect(2000);
    expect(await c.call('anything')).toBe('fine');
    c.close();
    odd.close();
  });

  it('times a call out without leaving it pending, and a late answer does no harm', async () => {
    const c = await connect();
    await expect(c.call('slow', {}, 50)).rejects.toThrow(/rpc timeout: slow/);
    await new Promise((r) => setTimeout(r, 400)); // the answer arrives for a call nobody waits for
    await expect(c.call('echo', { ok: 1 })).resolves.toEqual({ ok: 1 });
  });

  it('fails a call at once when the client is not connected, and a connect to nothing fails clearly', async () => {
    const idle = new RpcClient(sock);
    await expect(idle.call('echo')).rejects.toThrow('not connected');
    await expect(new RpcClient(path.join(dir, 'missing.sock')).connect(500)).rejects.toThrow();
  });

  it('broadcasts an event to every client, or only to those a filter picks, and tells "*" listeners the name', async () => {
    const a = await connect();
    const b = await connect();
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const all: unknown[] = [];
    a.on('tick', (d) => seenA.push(d));
    b.on('tick', (d) => seenB.push(d));
    b.on('*', (e) => all.push(e));
    await until(() => server.conns.size === 2);
    server.broadcast('tick', { n: 1 });
    await until(() => seenA.length === 1 && seenB.length === 1);
    const [first] = [...server.conns];
    server.broadcast('tick', { n: 2 }, (c) => c === first);
    await new Promise((r) => setTimeout(r, 150));
    expect(seenA.length + seenB.length).toBe(3); // the second event reached exactly one of them
    expect(all[0]).toEqual({ event: 'tick', data: { n: 1 } });
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const c = await connect();
    const seen: unknown[] = [];
    const off = c.on('tick', (d) => seen.push(d));
    await until(() => server.conns.size === 1);
    server.broadcast('tick', 1);
    await until(() => seen.length === 1);
    off();
    server.broadcast('tick', 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([1]);
  });

  it('forgets a connection when it closes, tells whoever listens, and fails the calls it still had open', async () => {
    const c = await connect();
    await until(() => server.conns.size === 1);
    const conn = [...server.conns][0]!;
    let closed = 0;
    conn.closed.on(() => closed++);
    let clientClosed = 0;
    c.onClose.on(() => clientClosed++);
    const pending = c.call('slow', {}, 5000);
    server.handle('hang', () => new Promise(() => undefined));
    const hung = c.call('hang', {}, 5000);
    conn.socket.destroy(); // the server side goes away
    await expect(pending).rejects.toThrow(/connection closed/);
    await expect(hung).rejects.toThrow(/connection closed/);
    await until(() => server.conns.size === 0);
    expect(closed).toBe(1);
    expect(clientClosed).toBe(1);
    expect(conn.alive).toBe(false);
    expect(conn.send({ event: 'x', data: 1 })).toBe(false); // nothing is written to a dead connection
  });

  it('hands every handler its connection, so it can keep per-client facts', async () => {
    server.handle('who', (_p, conn) => {
      conn.meta.seen = ((conn.meta.seen as number) ?? 0) + 1;
      return { id: conn.id, seen: conn.meta.seen };
    });
    const a = await connect();
    const b = await connect();
    const a1 = await a.call('who');
    const a2 = await a.call('who');
    const b1 = await b.call('who');
    expect(a2).toEqual({ id: a1.id, seen: 2 });
    expect(b1.id).not.toBe(a1.id);
    expect(b1.seen).toBe(1);
  });

  it('keeps the socket to its owner: mode 0600', () => {
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });

  it('refuses to take the socket of a server that is alive, and leaves it serving', async () => {
    const second = new RpcServer();
    await expect(second.listen(sock)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const c = await connect();
    expect(await c.call('echo', { still: 'first' })).toEqual({ still: 'first' });
    await expect(new RpcServer().assertFree(sock)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new RpcServer().assertFree(path.join(dir, 'nobody-here.sock')); // free is fine
  });

  it('replaces the socket file a crashed daemon left behind', async () => {
    const second = new RpcServer();
    second.handle('echo', (p) => p);
    await server.close(); // the first goes away, leaving its file
    fs.writeFileSync(sock, ''); // a stale, non-socket leftover
    await second.listen(sock);
    const c = await connect();
    expect(await c.call('echo', { x: 1 })).toEqual({ x: 1 });
    await second.close();
    server = new RpcServer(); // afterEach closes whatever is here
  });
});
