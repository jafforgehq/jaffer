import { drawBlockImage } from './block-image';
import { activeTheme, cfg, toast } from './state';

/** The lines of the turn card (1.7.0): the turn summary's parts (what the Now card already shows, redacted), the files it edited and a footer. Pure. */
export function turnCardLines(summary: string | undefined, files: string[], more = 0): string[] {
  const parts = (summary ?? '').split(' · ').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return [];
  const lines = [...parts];
  if (files.length) {
    lines.push('');
    lines.push(`edited ${files.slice(0, 5).join(', ')}${files.length > 5 || more > 0 ? ` +${Math.max(files.length - 5, 0) + more} more` : ''}`);
  }
  lines.push('', '— Jaffer');
  return lines;
}

/** "Copy turn card": the card as a PNG on the clipboard, never saved. */
export function copyTurnCard(summary: string | undefined, files: string[], more = 0): void {
  const lines = turnCardLines(summary, files, more);
  const failed = () => toast({ kind: 'error', text: 'Could not copy the image to the clipboard.' });
  if (!lines.length) return void toast({ kind: 'info', text: 'No finished turn to share yet' }, 2500);
  const a = cfg.value?.appearance;
  let canvas: HTMLCanvasElement;
  try {
    canvas = drawBlockImage(lines, true, activeTheme(), { family: a?.fontFamily || 'monospace', size: a?.fontSize ?? 13 });
  } catch {
    failed();
    return;
  }
  canvas.toBlob((blob) => {
    if (!blob) {
      failed();
      return;
    }
    void Promise.resolve()
      .then(() => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]))
      .then(() => toast({ kind: 'info', text: 'Copied the turn card as an image' }, 2500), failed);
  }, 'image/png');
}
