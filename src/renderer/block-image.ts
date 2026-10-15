import type { JafferTheme } from './themes';

/** "Copy as image" (1.2.0): at most this many lines of output, each at most this many columns; the rest is cut with "…". */
export const IMAGE_LINES = 200;
export const IMAGE_COLS = 160;

// (bounded: a CSI sequence has at most 32 parameter and 4 intermediate bytes here, anything longer is left to the control-character pass)
const CSI = /\x1b\[[0-?]{0,32}[ -/]{0,4}[@-~]/g;
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

/** One line as drawn: escapes and control characters gone, tabs to the next stop of 8, at most `cols` columns (a longer one ends in "…"). */
function cell(line: string, cols: number): string {
  const cut = line.length > cols * 8;
  const s = line.slice(0, cols * 8).replace(CSI, '').replace(CONTROL, '');
  let out = '';
  for (const ch of s) {
    out += ch === '\t' ? ' '.repeat(8 - (out.length % 8)) : ch;
    if (out.length > cols) break;
  }
  return out.length > cols || cut ? `${out.slice(0, cols - 1)}…` : out;
}

/**
 * The lines "Copy as image" draws: `$ <command>` first when there is one (already through `shownCommand`, on one line), then the output.
 * Only the head of the text is read (output and command lines are forgeable at any length).
 */
export function layoutBlockImage({ command, output, cols = IMAGE_COLS }: { command?: string; output: string; cols?: number }): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  if (command !== undefined) lines.push(cell(`$ ${command.slice(0, cols * 8).replace(/\s+/g, ' ').trim()}`, cols));
  const head = output.slice(0, IMAGE_LINES * cols * 4);
  const rows = head ? head.split(/\r\n|\r|\n/, IMAGE_LINES + 1) : [];
  const truncated = rows.length > IMAGE_LINES || head.length < output.length;
  for (const r of rows.slice(0, IMAGE_LINES)) lines.push(cell(r, cols));
  if (truncated) lines.push('…');
  return { lines, truncated };
}

/** The lines on a canvas in the terminal's font and colours (the command line muted), at twice the pixels. */
export function drawBlockImage(lines: string[], hasCommand: boolean, theme: JafferTheme, font: { family: string; size: number }): HTMLCanvasElement {
  const pad = 16;
  const lineH = Math.round(font.size * 1.4);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const cssFont = `${font.size}px ${font.family}`;
  ctx.font = cssFont;
  const maxW = ctx.measureText('M').width * IMAGE_COLS * 2; // (wide characters take two columns)
  const width = Math.ceil(Math.min(maxW, Math.max(1, ...lines.map((l) => ctx.measureText(l).width))) + pad * 2);
  const height = lines.length * lineH + pad * 2;
  const dpr = 2;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = theme.term.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = cssFont; // (setting the size resets the context)
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.term.foreground;
  lines.forEach((l, i) => {
    ctx.globalAlpha = hasCommand && i === 0 ? 0.6 : 1;
    ctx.fillText(l, pad, pad + i * lineH + lineH / 2);
  });
  return canvas;
}
