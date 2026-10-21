/**
 * The menu items that run one of the window's actions (`renderer/actions.ts`: the same id is the palette action), with their labels and
 * accelerators. The main process builds its menu from this; a test keeps it and the palette in step and every accelerator unique.
 */
export const MENU_ITEMS: Record<string, { label: string; accelerator?: string }> = {
  settings: { label: 'Settings…', accelerator: 'Cmd+,' },
  'hide-window': { label: 'Hide Window', accelerator: 'Cmd+W' },
  clear: { label: 'Clear Screen', accelerator: 'Cmd+K' },
  find: { label: 'Find…', accelerator: 'Cmd+F' },
  'find-next': { label: 'Find Next', accelerator: 'Cmd+G' },
  'find-prev': { label: 'Find Previous', accelerator: 'Shift+Cmd+G' },
  'copy-markdown': { label: 'Copy as Markdown', accelerator: 'Alt+Cmd+C' },
  'prompt-prev': { label: 'Previous Prompt', accelerator: 'Cmd+Up' },
  'prompt-next': { label: 'Next Prompt', accelerator: 'Cmd+Down' },
  'recent-commands': { label: 'Recent Commands…', accelerator: 'Cmd+R' },
  history: { label: 'Past Claude Conversations…', accelerator: 'Shift+Cmd+O' },
  'resume-last': { label: 'Resume Last Conversation', accelerator: 'Shift+Cmd+R' },
  'pin-selection': { label: 'Pin Selection', accelerator: 'Shift+Cmd+L' },
  'focus-mode': { label: 'Focus Mode', accelerator: 'Alt+Cmd+F' }, // (⌃⌘F is Full Screen's, which macOS and Electron's own role hold)
  'run-claude': { label: 'Run Claude Code', accelerator: 'Shift+Cmd+C' },
  'restart-shell': { label: 'Restart Shell' },
  // 1.4.0: up to four terminals (⌘D, ⇧⌘W, ⌘1..⌘4, ⌘] and ⌘[ are no role's: the Window menu role has no Close on macOS)
  'split-terminal': { label: 'Split Terminal', accelerator: 'Cmd+D' },
  'close-terminal': { label: 'Close Terminal', accelerator: 'Shift+Cmd+W' },
  'zoom-terminal': { label: 'Zoom Terminal', accelerator: 'Shift+Cmd+Return' }, // (1.5.0)
  'next-terminal': { label: 'Next Terminal', accelerator: 'Cmd+]' },
  'prev-terminal': { label: 'Previous Terminal', accelerator: 'Cmd+[' },
  'focus-terminal-1': { label: 'Terminal 1', accelerator: 'Cmd+1' },
  'focus-terminal-2': { label: 'Terminal 2', accelerator: 'Cmd+2' },
  'focus-terminal-3': { label: 'Terminal 3', accelerator: 'Cmd+3' },
  'focus-terminal-4': { label: 'Terminal 4', accelerator: 'Cmd+4' },
  palette: { label: 'Command Palette…', accelerator: 'Cmd+P' },
  'toggle-panel': { label: 'Toggle Side Panel', accelerator: 'Cmd+B' },
  'zoom-in': { label: 'Bigger', accelerator: 'Cmd+=' },
  'zoom-out': { label: 'Smaller', accelerator: 'Cmd+-' },
  'zoom-reset': { label: 'Actual Size', accelerator: 'Cmd+0' },
  'whats-new': { label: "What's New…" },
  shortcuts: { label: 'Keyboard Shortcuts', accelerator: 'Cmd+/' },
  // 1.4.0: learn (no accelerators)
  glossary: { label: 'Glossary…' },
  'start-tour': { label: 'Take the Tour' },
};

/** The accelerator of the `togglefullscreen` role (View → Enter Full Screen), which no item of ours may share. */
export const TOGGLE_FULLSCREEN = 'Ctrl+Cmd+F';
