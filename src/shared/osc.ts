/** The text of a shell mark (OSC 633 E or P): the shell scripts write `\`, `;`, newline, ESC and BEL as `\xHH` (`_jaffer_esc`). */
export function unescapeOsc(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}
