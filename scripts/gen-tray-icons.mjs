// Draws the menu bar icons (template images: black with alpha, macOS tints them) and embeds them as base64 PNGs in a TS module, so
// nothing new is packaged. `--check` fails when the committed file differs (a unit test runs it). The PNGs use stored (uncompressed)
// deflate blocks: the bytes then depend on nothing but this file, never on the zlib a Node version ships.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'generated', 'tray-icons.ts');

// ---------------------------------------------------------------- the glyphs, on an 18 × 18 grid

const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
const HEAD_R = 4.6;

/** The mole: its head (eyes and nose cut out; closed eyes are two slits) and its two front paws over a mound of earth (a gap between), and what flies around it. */
function mole({ headY, eyesOpen, specks = [], dot = false }) {
  const head = disc(9, headY, HEAD_R);
  const nearHead = disc(9, headY, HEAD_R + 1.1);
  const eyes = eyesOpen ? [disc(7.3, headY - 0.9, 0.75), disc(10.7, headY - 0.9, 0.75)] : [rect(6.3, headY - 1.1, 8.3, headY - 0.4), rect(9.7, headY - 1.1, 11.7, headY - 0.4)];
  const holes = [...eyes, disc(9, headY + 1.8, 0.95)];
  const paws = [disc(4.4, headY + 4.4, 1.6), disc(13.6, headY + 4.4, 1.6)];
  const nearPaws = [disc(4.4, headY + 4.4, 2.5), disc(13.6, headY + 4.4, 2.5)];
  const mound = (x, y) => ((x - 9) / 9.5) ** 2 + ((y - 19.5) / 4.5) ** 2 <= 1;
  const bits = specks.map(([cx, cy, r]) => disc(cx, cy, r));
  const alert = disc(15, 3, 2.6);
  return (x, y) => {
    if (dot && alert(x, y)) return true;
    if (head(x, y)) return !holes.some((h) => h(x, y));
    if (nearHead(x, y)) return false;
    if (paws.some((p) => p(x, y))) return true;
    if (nearPaws.some((p) => p(x, y))) return false;
    return mound(x, y) || bits.some((b) => b(x, y));
  };
}

export const GLYPHS = {
  idle: mole({ headY: 10.5, eyesOpen: false }),
  'work-a': mole({ headY: 9, eyesOpen: true, specks: [[3.2, 10.5, 1], [14.8, 9.5, 1]] }),
  'work-b': mole({ headY: 10, eyesOpen: true, specks: [[2.4, 6.5, 1], [15.6, 5.8, 1], [13.6, 3.2, 0.8]] }),
  alert: mole({ headY: 9.5, eyesOpen: true, dot: true }),
};

/** RGBA pixels of a glyph at `size` px (4 × 4 samples a pixel for smooth edges). */
function render(glyph, size) {
  const px = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let hit = 0;
      for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) if (glyph(((pxl + (sx + 0.5) / n) * 18) / size, ((py + (sy + 0.5) / n) * 18) / size)) hit++;
      px[(py * size + pxl) * 4 + 3] = Math.round((hit / (n * n)) * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------- a small PNG encoder

const CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(buf) {
  let a = 1;
  let b = 0;
  for (const x of buf) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
/** A zlib stream of stored blocks (`data` is never empty here). */
function zlibStored(data) {
  const parts = [Buffer.from([0x78, 0x01])];
  for (let at = 0; at < data.length; at += 65535) {
    const block = data.subarray(at, at + 65535);
    const head = Buffer.alloc(5);
    head[0] = at + 65535 >= data.length ? 1 : 0;
    head.writeUInt16LE(block.length, 1);
    head.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(head, block);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(adler32(data));
  parts.push(tail);
  return Buffer.concat(parts);
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4); // (filter byte 0: none)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- the module

/** The generated file's text. */
export function trayIconsSource() {
  const icons = {};
  for (const [name, glyph] of Object.entries(GLYPHS)) icons[name] = { x1: png(render(glyph, 18), 18).toString('base64'), x2: png(render(glyph, 36), 36).toString('base64') };
  return `// GENERATED by scripts/gen-tray-icons.mjs (npm run gen:tray) — do not edit. The menu bar icons: template PNGs at 1x (18 px) and 2x (36 px).\nexport const TRAY_ICONS: Record<'idle' | 'work-a' | 'work-b' | 'alert', { x1: string; x2: string }> = ${JSON.stringify(icons, null, 2)};\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const body = trayIconsSource();
  let cur = '';
  try {
    cur = fs.readFileSync(out, 'utf8');
  } catch {}
  if (process.argv.includes('--check')) {
    if (cur !== body) {
      console.error('src/generated/tray-icons.ts is out of date; run: npm run gen:tray');
      process.exit(1);
    }
  } else if (cur !== body) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    console.log('wrote', path.relative(root, out));
  }
}
