/** The most text "Save output…" writes (characters); the main process refuses more. */
export const SAVE_TEXT_MAX = 32 * 1024 * 1024;

/** The name the save dialog suggests: the last part of a path only, letters, digits, `.`, `-` and `_`, no leading dot; else `output.txt`. */
export function safeFileName(name: unknown): string {
  if (typeof name !== 'string') return 'output.txt';
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return base || 'output.txt';
}
