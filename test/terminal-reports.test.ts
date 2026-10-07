import { describe, expect, it } from 'vitest';
import { isTerminalReport } from '../src/shared/terminal-reports';

describe('isTerminalReport', () => {
  it('is what the terminal says by itself: focus, mouse, attribute, position, status and mode reports', () => {
    for (const r of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[<35;120;40m', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[24;80R', '\x1b[0n', '\x1b[?0n', '\x1b[?1;2$y', '\x1b[?2004;1$y', '\x1b[M !!']) {
      expect(isTerminalReport(r), JSON.stringify(r)).toBe(true);
    }
  });

  it('is also several of them in a row, as one write can carry', () => {
    expect(isTerminalReport('\x1b[I\x1b[<0;1;1M\x1b[<0;1;1m\x1b[?1;2c')).toBe(true);
  });

  it('is not the person typing: letters, Enter, arrows, delete, paste, escape, control keys', () => {
    for (const k of ['y', 'y\r', '\r', 'n', ' ', '\x1b', '\x1b[A', '\x1b[B', '\x1b[3~', '\x03', '\x04', '\x1b[200~echo hi\x1b[201~', '1', 'yes\r', '\x1b[1;5C']) {
      expect(isTerminalReport(k), JSON.stringify(k)).toBe(false);
    }
  });

  it('is not a report when typing is mixed in with one, or when there is nothing', () => {
    expect(isTerminalReport('y\x1b[I')).toBe(false);
    expect(isTerminalReport('\x1b[Iy')).toBe(false);
    expect(isTerminalReport('')).toBe(false);
  });
});
