/**
 * What xterm.js sends to the shell on its own: it answers the questions programs ask the terminal (device attributes, cursor
 * position, mode queries) and reports focus and mouse events when a program asked for them. None of it is the person typing,
 * so none of it means "the person answered Claude's question".
 */
const REPORT = new RegExp(
  '^(?:' +
    [
      '\\x1b\\[[IO]', // focus in / out
      '\\x1b\\[<\\d+;\\d+;\\d+[Mm]', // SGR mouse press, release, motion
      '\\x1b\\[M[\\x20-\\xff]{3}', // X10 mouse
      '\\x1b\\[[?>]?[\\d;]*c', // device attributes
      '\\x1b\\[\\d+;\\d+R', // cursor position
      '\\x1b\\[\\??\\d*n', // device status
      '\\x1b\\[\\??[\\d;]*\\$y', // mode report
    ].join('|') +
    ')+$',
);

export function isTerminalReport(data: string): boolean {
  return data.length > 0 && REPORT.test(data);
}
