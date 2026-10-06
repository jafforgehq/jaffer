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
    background: '#12151b', foreground: '#e6e8ee', cursor: '#ff8a4c', cursorAccent: '#12151b', selectionBackground: '#ff8a4c40',
    black: '#1c1f26', red: '#ff6b6b', green: '#7ee0a3', yellow: '#f5c76b', blue: '#6aa8ff', magenta: '#c792ea', cyan: '#5eead4', white: '#d7dae2',
    brightBlack: '#5c6370', brightRed: '#ff8f8f', brightGreen: '#a3f0c0', brightYellow: '#ffdc8b', brightBlue: '#92c0ff', brightMagenta: '#dcb4f5', brightCyan: '#8ff5e4', brightWhite: '#ffffff',
  }),
  t('jaffer-light', 'Jaffer Light', false, '#e5622a', {
    background: '#fdfcfa', foreground: '#23262d', cursor: '#e5622a', cursorAccent: '#fdfcfa', selectionBackground: '#e5622a30',
    black: '#23262d', red: '#d6403f', green: '#2f9e63', yellow: '#b8860b', blue: '#2f6fd6', magenta: '#9b4fc9', cyan: '#12908a', white: '#d9dbe1',
    brightBlack: '#7b818d', brightRed: '#e85c5b', brightGreen: '#45b87b', brightYellow: '#d29a1a', brightBlue: '#4a8af0', brightMagenta: '#b36be0', brightCyan: '#2aa8a1', brightWhite: '#f4f4f0',
  }),
  t('jaffer-midnight', 'Jaffer Midnight', true, '#8b9cff', {
    background: '#0d1020', foreground: '#dfe4f7', cursor: '#8b9cff', cursorAccent: '#0d1020', selectionBackground: '#8b9cff40',
    black: '#171b30', red: '#ff6b81', green: '#6ee7b7', yellow: '#f7d07a', blue: '#7aa7ff', magenta: '#c4a1ff', cyan: '#67e8f9', white: '#cfd5ee',
    brightBlack: '#5a6288', brightRed: '#ff8fa0', brightGreen: '#9bf2cc', brightYellow: '#fbe3a5', brightBlue: '#a3c2ff', brightMagenta: '#d9c2ff', brightCyan: '#9af0fb', brightWhite: '#ffffff',
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
  t('rose-pine', 'Rosé Pine', true, '#ebbcba', {
    background: '#191724', foreground: '#e0def4', cursor: '#e0def4', cursorAccent: '#191724', selectionBackground: '#403d52',
    black: '#26233a', red: '#eb6f92', green: '#9ccfd8', yellow: '#f6c177', blue: '#31748f', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
    brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#9ccfd8', brightYellow: '#f6c177', brightBlue: '#31748f', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4',
  }),
  t('one-dark', 'One Dark', true, '#61afef', {
    background: '#21252b', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#21252b', selectionBackground: '#3e4451',
    black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
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

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two hex colours: t=0 gives a, t=1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * CSS custom properties for the surrounding UI, derived from the terminal palette so everything matches.
 *
 *   --chrome   the canvas behind everything (rail, toolbar, gutters): darker than the terminal in dark themes
 *   --surface  the terminal and panels that sit on the canvas
 *   --raised   cards on a surface; --raised-2 hover/active states on cards
 */
export function cssVars(theme: JafferTheme, opacity: number): Record<string, string> {
  const bg = theme.term.background;
  const fg = theme.term.foreground;
  const [fr, fg_, fb] = hexToRgb(fg);
  const dark = theme.dark;
  const chrome = dark ? mix(bg, '#000000', 0.42) : mix(bg, '#000000', 0.05);
  const raised = dark ? mix(bg, '#ffffff', 0.045) : mix(bg, '#ffffff', 0.7);
  const raised2 = dark ? mix(bg, '#ffffff', 0.09) : mix(bg, '#000000', 0.045);
  const accent = theme.accent;
  return {
    '--chrome': withAlpha(chrome, opacity),
    '--chrome-solid': chrome,
    '--surface': withAlpha(bg, Math.min(1, opacity + 0.02)),
    '--bg-solid': bg,
    '--bg': withAlpha(bg, opacity),
    '--raised': raised,
    '--raised-2': raised2,
    '--hover': dark ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.05)',
    '--active': dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)',
    '--text': fg,
    '--muted': `rgba(${fr},${fg_},${fb},0.66)`,
    '--faint': `rgba(${fr},${fg_},${fb},0.42)`,
    '--line': dark ? 'rgba(255,255,255,0.075)' : 'rgba(0,0,0,0.085)',
    '--line-strong': dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.16)',
    '--accent': accent,
    '--accent-2': dark ? mix(accent, '#ffffff', 0.28) : mix(accent, '#000000', 0.12),
    '--accent-soft': withAlpha(accent, dark ? 0.15 : 0.12),
    '--accent-line': withAlpha(accent, 0.45),
    '--accent-ink': dark ? '#0b0c0f' : '#ffffff',
    '--memory': theme.term.cyan ?? '#5eead4',
    '--memory-soft': withAlpha(theme.term.cyan ?? '#5eead4', dark ? 0.14 : 0.12),
    '--info': theme.term.blue ?? '#6aa8ff',
    '--info-soft': withAlpha(theme.term.blue ?? '#6aa8ff', dark ? 0.15 : 0.12),
    '--violet': theme.term.magenta ?? '#c792ea',
    '--violet-soft': withAlpha(theme.term.magenta ?? '#c792ea', dark ? 0.15 : 0.12),
    '--ok': theme.term.green ?? '#7ee0a3',
    '--ok-soft': withAlpha(theme.term.green ?? '#7ee0a3', dark ? 0.14 : 0.12),
    '--warn': theme.term.yellow ?? '#f5c76b',
    '--warn-soft': withAlpha(theme.term.yellow ?? '#f5c76b', dark ? 0.14 : 0.14),
    '--danger': theme.term.red ?? '#ff6b6b',
    '--danger-soft': withAlpha(theme.term.red ?? '#ff6b6b', dark ? 0.14 : 0.1),
    '--shadow': dark ? '0 18px 60px rgba(0,0,0,0.55)' : '0 18px 60px rgba(30,30,50,0.2)',
    '--ring': dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.05)',
    '--shadow-sm': dark ? '0 1px 2px rgba(0,0,0,0.35)' : '0 1px 2px rgba(30,30,50,0.1)',
    colorScheme: dark ? 'dark' : 'light',
  };
}
