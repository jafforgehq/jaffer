import net from 'node:net';
import fs from 'node:fs';
import { Emitter, errMsg } from '../shared/util';

/** Newline-delimited JSON over a unix socket. Tiny, debuggable with `nc -U`, no framing surprises. */

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}
export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string; code?: string };
}
export interface RpcEvent {
  event: string;
  data: unknown;
}
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

export class LineDecoder {
  /**
   * The unfinished line, as the chunks it arrived in. They are joined only when its newline arrives: appending to one string
   * and searching it made V8 copy the whole growing line on every chunk (a second for 25 MB here, three on a CI Mac).
   */
  private parts: string[] = [];
  private pending = 0;
  /** `maxPending`: the most a peer may send without ending a line before it is taken for runaway and dropped. */
  constructor(private maxPending = 64 * 1024 * 1024) {}
  push(chunk: string, onLine: (line: string) => void): void {
    let start = 0;
    let i: number;
    while ((i = chunk.indexOf('\n', start)) >= 0) {
      const tail = chunk.slice(start, i);
      const line = this.parts.length ? this.parts.join('') + tail : tail;
      this.parts = [];
      this.pending = 0;
      start = i + 1;
      if (line.trim()) onLine(line);
    }
    if (start < chunk.length) {
      this.parts.push(start ? chunk.slice(start) : chunk);
      this.pending += chunk.length - start;
    }
    if (this.pending > this.maxPending) {
      this.parts = []; // runaway peer
      this.pending = 0;
    }
  }
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type Handler = (params: any, conn: ServerConn) => unknown | Promise<unknown>;

export class ServerConn {
  readonly closed = new Emitter<void>();
  alive = true;
  /** Free-form info a handler can attach (client name, attached panes…). */
  meta: Record<string, unknown> = {};
  constructor(
    readonly socket: net.Socket,
    readonly id: number,
  ) {}
  send(msg: RpcMessage): boolean {
    if (!this.alive) return false;
    try {
      return this.socket.write(JSON.stringify(msg) + '\n');
    } catch {
      return false;
    }
  }
  get backlog(): number {
    return this.socket.writableLength;
  }
}

export class RpcServer {
  private server: net.Server | null = null;
  private handlers = new Map<string, Handler>();
  readonly conns = new Set<ServerConn>();
  private nextId = 1;

  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  broadcast(event: string, data: unknown, filter?: (c: ServerConn) => boolean): void {
    const msg: RpcEvent = { event, data };
    for (const c of this.conns) if (!filter || filter(c)) c.send(msg);
  }

  /**
   * Throws EADDRINUSE when something answers on the socket. A second daemon starting at the same moment as the first would
   * otherwise delete the first one's socket file and leave it running, unreachable, with a live shell.
   */
  async assertFree(socketPath: string): Promise<void> {
    const live = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      const done = (v: boolean) => {
        probe.destroy();
        resolve(v);
      };
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
      probe.setTimeout(500, () => done(false));
    });
    if (live) throw new RpcError(`Something is already listening on ${socketPath}.`, 'EADDRINUSE');
  }

  async listen(socketPath: string): Promise<void> {
    await this.assertFree(socketPath);
    try {
      fs.unlinkSync(socketPath); // what is left is a dead daemon's file
    } catch {
      /* none */
    }
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath, () => {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          /* best effort */
        }
        resolve();
      });
    });
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding('utf8');
    const conn = new ServerConn(socket, this.nextId++);
    this.conns.add(conn);
    const dec = new LineDecoder();
    socket.on('data', (chunk: string) =>
      dec.push(chunk, (line) => {
        let msg: RpcRequest;
        try {
          msg = JSON.parse(line) as RpcRequest;
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
        void this.dispatch(conn, msg);
      }),
    );
    const close = () => {
      if (!conn.alive) return;
      conn.alive = false;
      this.conns.delete(conn);
      conn.closed.emit();
    };
    socket.on('close', close);
    socket.on('error', close);
  }

  private async dispatch(conn: ServerConn, req: RpcRequest): Promise<void> {
    const h = this.handlers.get(req.method);
    if (!h) {
      conn.send({ id: req.id, error: { message: `unknown method: ${req.method}`, code: 'ENOMETHOD' } });
      return;
    }
    try {
      const result = await h(req.params ?? {}, conn);
      conn.send({ id: req.id, result: result === undefined ? null : result });
    } catch (e) {
      conn.send({ id: req.id, error: { message: errMsg(e), code: e instanceof RpcError ? e.code : undefined } });
    }
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.socket.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export class RpcClient {
  private socket: net.Socket | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private listeners = new Map<string, Set<(data: any) => void>>();
  readonly onClose = new Emitter<void>();
  connected = false;

  constructor(private socketPath: string) {}

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding('utf8');
      const t = setTimeout(() => {
        socket.destroy();
        reject(new Error('connect timeout'));
      }, timeoutMs);
      socket.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      socket.once('connect', () => {
        clearTimeout(t);
        this.socket = socket;
        this.connected = true;
        const dec = new LineDecoder();
        socket.on('data', (chunk: string) => dec.push(chunk, (line) => this.onLine(line)));
        const close = () => {
          if (!this.connected) return;
          this.connected = false;
          for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('connection closed'));
          }
          this.pending.clear();
          this.onClose.emit();
        };
        socket.on('close', close);
        socket.on('error', close);
        resolve();
      });
    });
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code));
      else p.resolve(msg.result);
    } else if (typeof msg.event === 'string') {
      const set = this.listeners.get(msg.event);
      if (set) for (const fn of [...set]) fn(msg.data);
      const all = this.listeners.get('*');
      if (all) for (const fn of [...all]) fn({ event: msg.event, data: msg.data });
    }
  }

  call<T = any>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.socket || !this.connected) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ id, method, params } satisfies RpcRequest) + '\n');
    });
  }

  on(event: string, fn: (data: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  close(): void {
    this.connected = false;
    this.socket?.destroy();
    this.socket = null;
  }
}
