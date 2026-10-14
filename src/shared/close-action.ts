/** What the window's close button does (Settings → Appearance → When I close the window). Pure, so it is tested. */

export type CloseAction = 'menubar' | 'quit' | 'ask';
export type CloseDecision = 'hide' | 'leave-full-screen-then-hide' | 'quit' | 'ask';

/**
 * The red ✕ and ⌘W: `quit` goes the way of the menu's Quit Jaffer (which asks when something runs, so `running` never changes the
 * decision here); `ask` asks only while the menu bar item is there to come back to; anything else hides the window. A window in full
 * screen leaves it first: hidden in full screen it would leave an empty Space with nothing to click.
 */
export function closeDecision(o: { action: CloseAction | string; fullScreen: boolean; menuBar: boolean; running: boolean }): CloseDecision {
  if (o.action === 'quit') return 'quit';
  if (o.action === 'ask' && o.menuBar) return 'ask';
  return o.fullScreen ? 'leave-full-screen-then-hide' : 'hide';
}

/** The question for `ask`: Cancel is the default button, so Return and Esc both leave the window where it is. */
export const CLOSE_ASK = {
  message: 'Close Jaffer’s window?',
  detail: 'The terminal keeps running in the menu bar. Quitting ends it, and anything running in it.',
  buttons: ['Hide to Menu Bar', 'Quit Jaffer', 'Cancel'],
  defaultId: 2,
  cancelId: 2,
} as const;

/** The one notification the first time the window hides while the menu bar item is there (`window.hintShown`). */
export const HIDE_HINT = {
  title: 'Jaffer is still running in the menu bar',
  body: 'Click its icon in the menu bar, or press your hotkey, to bring the window back.',
} as const;
