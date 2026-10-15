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
  palette: { label: 'Command Palette…', accelerator: 'Cmd+P' },
  'toggle-panel': { label: 'Toggle Side Panel', accelerator: 'Cmd+B' },
  'zoom-in': { label: 'Bigger', accelerator: 'Cmd+=' },
  'zoom-out': { label: 'Smaller', accelerator: 'Cmd+-' },
  'zoom-reset': { label: 'Actual Size', accelerator: 'Cmd+0' },
  'whats-new': { label: "What's New…" },
  shortcuts: { label: 'Keyboard Shortcuts', accelerator: 'Cmd+/' },
};

/** The accelerator of the `togglefullscreen` role (View → Enter Full Screen), which no item of ours may share. */
export const TOGGLE_FULLSCREEN = 'Ctrl+Cmd+F';
