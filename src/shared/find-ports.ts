/**
 * Local servers a running command says it listens on (`localhost:5173`, `127.0.0.1:8080`, `0.0.0.0:3000`, `[::1]:4000`), for the
 * title bar's port chip (spec feature 37). It runs on every chunk of a command's output, which is untrusted and of any size: only
 * the chunk's head is read, and every pattern is bounded.
 */

const CHUNK_HEAD = 64 * 1024;
/** Colours and other CSI sequences, and OSC strings (links, titles), each bounded. */
const ANSI = /\x1b\[[0-?]{0,32}[ -/]{0,4}[@-~]|\x1b\][^\x07\x1b]{0,2048}(?:\x07|\x1b\\)?/g;
const PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?!\d)/g;

export function findPorts(text: string): number[] {
  if (typeof text !== 'string') return [];
  const plain = text.slice(0, CHUNK_HEAD).replace(ANSI, '');
  const out: number[] = [];
  for (const m of plain.matchAll(PORT)) {
    const port = Number(m[1]);
    if (port >= 1 && port <= 65535 && !out.includes(port)) out.push(port);
  }
  return out;
}
