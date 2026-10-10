import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { makePaths } from '../shared/paths';
import { ensureDaemon } from '../core/daemon-client';
import type { RpcClient } from '../core/rpc';
import { VERSION } from '../core/version';

/**
 * Development/test bridge: serves the renderer in a plain browser and relays `window.jaffer`
 * calls to the real daemon over a WebSocket. It stands in for the Electron main process so the
 * whole UI can be exercised (and screenshotted) without Electron. Never shipped in the app.
 */

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT ?? 0);
const token = process.env.JAFFER_BRIDGE_TOKEN ?? '';
const paths = makePaths();

const SHIM = `(() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(${JSON.stringify(token)}));
  const pending = new Map(); let nextId = 1;
  const listeners = new Set(); const menu = new Set();
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) { const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error)) : p.res(msg.result); }
    else if (msg.event) listeners.forEach((cb) => cb(msg.event, msg.data));
  });
  window.__event = (event, data) => listeners.forEach((cb) => cb(event, data));
  window.jaffer = {
    call: async (method, params) => { await ready; return new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); },
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onMenu: (cb) => { menu.add(cb); window.__menu = (id) => menu.forEach((f) => f(id)); return () => menu.delete(cb); },
    onFocus: (cb) => { const on = () => cb(true), off = () => cb(false); window.addEventListener('focus', on); window.addEventListener('blur', off); return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); }; },
    openExternal: async (u) => { window.__opened = u; }, reveal: async () => {},
    appInfo: async () => ({ version: ${JSON.stringify(VERSION)}, platform: 'darwin', dark: true, home: ${JSON.stringify(paths.home)}, packaged: false, openAtLogin: !!window.__loginItem }),
    // a build that can update itself: Check now answers "up to date"; tests push other states with window.__event
    reset: async () => { window.__resetCalled = (window.__resetCalled || 0) + 1; return { cancelled: true }; }, // the real app asks first; this stand-in is a person saying no
    updates: { state: async () => ({ status: 'idle', current: ${JSON.stringify(VERSION)}, auto: true }), check: async () => ({ status: 'uptodate', current: ${JSON.stringify(VERSION)}, auto: true }) },
    setLoginItem: async (on) => { window.__loginItem = on; }, pathForFile: () => '', platform: 'darwin',
  };
})();`;

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function main(): Promise<void> {
  const client: RpcClient = await ensureDaemon(paths, {
    execPath: process.execPath,
    daemonScript: path.join(root, 'daemon', 'jafferd.cjs'),
    cliScript: path.join(root, 'cli', 'jaffer.cjs'),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/bridge-shim.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(SHIM);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(root, 'renderer', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(root, 'renderer')) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    let body: Buffer | string = fs.readFileSync(file);
    if (rel === 'index.html') {
      body = body
        .toString()
        .replace("connect-src 'self'", "connect-src 'self' ws: wss:")
        .replace('<script src="app.js">', '<script src="/bridge-shim.js"></script><script src="app.js">');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || (token && url.searchParams.get('token') !== token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws: WebSocket) => {
    const off = client.on('*', ({ event, data }: { event: string; data: unknown }) => ws.send(JSON.stringify({ event, data })));
    ws.on('message', async (raw) => {
      let msg: { id: number; method: string; params: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        const result = await client.call(msg.method, msg.params, 120_000);
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, error: e instanceof Error ? e.message : String(e) }));
      }
    });
    ws.on('close', off);
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    process.stdout.write(`BRIDGE http://127.0.0.1:${p}/\n`);
  });
}

void main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
