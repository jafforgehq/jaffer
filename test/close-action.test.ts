import { describe, expect, it } from 'vitest';
import { CLOSE_ASK, closeDecision, HIDE_HINT } from '../src/shared/close-action';

describe('closeDecision: what the red ✕ and ⌘W do', () => {
  it('every combination of the setting, full screen, the menu bar item and something running', () => {
    const rows: [action: string, fullScreen: boolean, menuBar: boolean, want: string][] = [
      ['menubar', false, true, 'hide'],
      ['menubar', true, true, 'leave-full-screen-then-hide'],
      // the menu bar item off: ✕ still hides (the Dock icon brings it back), and full screen is left first
      ['menubar', false, false, 'hide'],
      ['menubar', true, false, 'leave-full-screen-then-hide'],
      ['quit', false, true, 'quit'],
      ['quit', true, true, 'quit'],
      ['quit', false, false, 'quit'],
      ['quit', true, false, 'quit'],
      ['ask', false, true, 'ask'],
      ['ask', true, true, 'ask'],
      // the question says "the terminal keeps running in the menu bar": without the item it is not asked, the window hides
      ['ask', false, false, 'hide'],
      ['ask', true, false, 'leave-full-screen-then-hide'],
      // a value no version wrote (a hand-edited file) hides, like the default
      ['close', false, true, 'hide'],
      ['', true, true, 'leave-full-screen-then-hide'],
    ];
    for (const [action, fullScreen, menuBar, want] of rows) {
      // something running never changes the decision: the Quit flow asks about it itself
      for (const running of [false, true]) expect(closeDecision({ action, fullScreen, menuBar, running }), `${action} fs=${fullScreen} mb=${menuBar} run=${running}`).toBe(want);
    }
  });

  it('the question: Hide to Menu Bar, Quit Jaffer or Cancel, and Cancel is the default (Return and Esc change nothing)', () => {
    expect(CLOSE_ASK.buttons).toEqual(['Hide to Menu Bar', 'Quit Jaffer', 'Cancel']);
    expect(CLOSE_ASK.defaultId).toBe(2);
    expect(CLOSE_ASK.cancelId).toBe(2);
    expect(CLOSE_ASK.message).toBe('Close Jaffer’s window?');
    expect(CLOSE_ASK.detail).toContain('The terminal keeps running in the menu bar.');
  });

  it('the first hide says where Jaffer went', () => {
    expect(HIDE_HINT.title).toBe('Jaffer is still running in the menu bar');
    expect(HIDE_HINT.body.length).toBeGreaterThan(10);
  });
});
