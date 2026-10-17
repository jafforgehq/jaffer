/** (1.4.1) Whether the terminal exposes its text to a screen reader (xterm's `screenReaderMode`): `on` always, `off` never, anything else (`auto`) when macOS reports one. */
export function screenReaderOn(mode: string, assistive: boolean): boolean {
  return mode === 'on' ? true : mode === 'off' ? false : assistive;
}
