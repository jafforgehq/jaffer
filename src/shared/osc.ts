/** The text of a shell mark (OSC 633 E or P): the shell scripts write `\`, `;`, newline, ESC and BEL as `\xHH` (`_jaffer_esc`). */
export function unescapeOsc(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** (1.4.2) The most characters of a shell's PATH (633;P;Path) that is taken. */
export const SHELL_PATH_MAX = 8192;

/** (1.4.2) A PATH the shell reported, as it may be used: text of 1 to 8192 characters, none of them C0, C1 or DEL. */
export function isShellPath(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= SHELL_PATH_MAX && !/[\x00-\x1f\x7f-\x9f]/.test(s);
}
