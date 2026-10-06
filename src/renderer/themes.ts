import type { ITheme } from '@xterm/xterm';

export interface JafferTheme {
  id: string;
  name: string;
  dark: boolean;
  /** UI accent derived from the palette. */
  accent: string;
  term: ITheme & { background: string; foreground: string };
}

const t = (id: string, name: string, dark: boolean, accent: string, term: JafferTheme['term']): JafferTheme => ({ id, name, dark, accent, term });

export const THEMES: JafferTheme[] = [
  t('jaffer-dark', 'Jaffer Dark', true, '#ff8a4c', {
    background: '#0f1115', foreground: '#e6e8ee', cursor: '#ff8a4c', cursorAccent: '#0f1115', selectionBackground: '#ff8a4c40',
    black: '#1c1f26', red: '#ff6b6b', green: '#7ee0a3', yellow: '#f5c76b', blue: '#6aa8ff', magenta: '#c792ea', cyan: '#5eead4', white: '#d7dae2',
    brightBlack: '#5c6370', brightRed: '#ff8f8f', brightGreen: '#a3f0c0', brightYellow: '#ffdc8b', brightBlue: '#92c0ff', brightMagenta: '#dcb4f5', brightCyan: '#8ff5e4', brightWhite: '#ffffff',
  }),
  t('jaffer-light', 'Jaffer Light', false, '#e5622a', {
    background: '#fbfaf7', foreground: '#23262d', cursor: '#e5622a', cursorAccent: '#fbfaf7', selectionBackground: '#e5622a30',
    black: '#23262d', red: '#d6403f', green: '#2f9e63', yellow: '#b8860b', blue: '#2f6fd6', magenta: '#9b4fc9', cyan: '#12908a', white: '#d9dbe1',
    brightBlack: '#7b818d', brightRed: '#e85c5b', brightGreen: '#45b87b', brightYellow: '#d29a1a', brightBlue: '#4a8af0', brightMagenta: '#b36be0', brightCyan: '#2aa8a1', brightWhite: '#f4f4f0',
  }),
  t('tokyo-night', 'Tokyo Night', true, '#7aa2f7', {
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  }),
  t('catppuccin-mocha', 'Catppuccin Mocha', true, '#cba6f7', {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#585b70',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  }),
  t('nord', 'Nord', true, '#88c0d0', {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  }),
  t('gruvbox-dark', 'Gruvbox Dark', true, '#fabd2f', {
    background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
    black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  }),
  t('dracula', 'Dracula', true, '#bd93f9', {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  }),
  t('solarized-dark', 'Solarized Dark', true, '#268bd2', {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  }),
];

export function themeById(id: string): JafferTheme {
  return THEMES.find((x) => x.id === id) ?? THEMES[0]!;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Terminal theme with the user's opacity applied to its background. */
export function xtermTheme(theme: JafferTheme, opacity: number): ITheme {
  return { ...theme.term, background: opacity >= 0.995 ? theme.term.background : withAlpha(theme.term.background, opacity) };
}

/** CSS custom properties for the surrounding UI, derived from the terminal palette so everything matches. */
export function cssVars(theme: JafferTheme, opacity: number): Record<string, string> {
  const bg = theme.term.background;
  const fg = theme.term.foreground;
  const [fr, fg_, fb] = hexToRgb(fg);
  const dark = theme.dark;
  return {
    '--bg': withAlpha(bg, opacity),
    '--bg-solid': bg,
    '--panel': withAlpha(bg, Math.min(0.98, opacity + 0.02)),
    '--panel-2': dark ? `rgba(255,255,255,0.045)` : `rgba(0,0,0,0.04)`,
    '--panel-3': dark ? `rgba(255,255,255,0.08)` : `rgba(0,0,0,0.07)`,
    '--text': fg,
    '--muted': `rgba(${fr},${fg_},${fb},0.62)`,
    '--faint': `rgba(${fr},${fg_},${fb},0.38)`,
    '--border': dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.10)',
    '--accent': theme.accent,
    '--accent-soft': withAlpha(theme.accent, 0.16),
    '--accent-ink': dark ? '#0b0c0f' : '#ffffff',
    '--memory': theme.term.cyan ?? '#5eead4',
    '--memory-soft': withAlpha(theme.term.cyan ?? '#5eead4', 0.15),
    '--ok': theme.term.green ?? '#7ee0a3',
    '--warn': theme.term.yellow ?? '#f5c76b',
    '--danger': theme.term.red ?? '#ff6b6b',
    '--shadow': dark ? '0 10px 40px rgba(0,0,0,0.45)' : '0 10px 40px rgba(20,20,30,0.18)',
    colorScheme: dark ? 'dark' : 'light',
  };
}
