import { activePane, cfg, info, openOverlay, patchConfig, safeCommand, toast } from './state';
import { isClaudeCommand } from '../shared/process-badge';
import { terminals } from './components/TerminalView';
import { THEMES } from './themes';

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

export interface Action {
  id: string;
  title: string;
  section: string;
  keys?: string;
  keywords?: string;
  run(): unknown;
}

function term() {
  return terminals.get(activePane.value);
}

function zoom(delta: number): void {
  const cur = cfg.value?.appearance.fontSize ?? 13;
  const next = delta === 0 ? 13 : Math.min(28, Math.max(8, cur + delta));
  void patchConfig({ appearance: { fontSize: next } });
}

export async function runClaude(): Promise<void> {
  const t = term();
  if (!t) return;
  if (info.value.busy && isClaudeCommand(info.value.busy)) {
    t.focus(); // already running: take me to it
    return;
  }
  if (info.value.busy) {
    toast({ kind: 'info', text: `The terminal is busy running ${safeCommand(info.value.busy)}.` });
    return;
  }
  t.type('claude\r');
  t.focus();
}

async function guarded(fn: () => Promise<unknown>, ok?: string): Promise<void> {
  try {
    await fn();
    if (ok) toast({ kind: 'info', text: ok });
  } catch (e) {
    toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
  }
}

export const actions: Action[] = [
  { id: 'run-claude', title: 'Run Claude Code in the terminal', section: 'Terminal', keys: '⇧⌘C', keywords: 'claude code cli', run: runClaude },
  { id: 'hide-window', title: 'Hide the window', section: 'Terminal', keys: '⌘W', run: () => window.close() },
  { id: 'clear', title: 'Clear screen', section: 'Terminal', keys: '⌘K', run: () => term()?.clear() },
  { id: 'find', title: 'Find in terminal', section: 'Terminal', keys: '⌘F', run: () => openOverlay('find') },
  { id: 'restart-shell', title: 'Restart shell', section: 'Terminal', run: () => guarded(() => call('session.restart', {}), 'Shell restarted in the same folder.') },
  { id: 'settings', title: 'Open settings', section: 'App', keys: '⌘,', run: () => openOverlay('settings') },
  { id: 'zoom-in', title: 'Bigger text', section: 'View', keys: '⌘=', run: () => zoom(1) },
  { id: 'zoom-out', title: 'Smaller text', section: 'View', keys: '⌘-', run: () => zoom(-1) },
  { id: 'zoom-reset', title: 'Actual size', section: 'View', keys: '⌘0', run: () => zoom(0) },
  { id: 'setup-claude', title: 'Connect Claude Code to Jaffer (hooks)', section: 'Integrations', keywords: 'claude hooks companion notifications', run: () => guarded(async () => (await call('setup.claude.install', {}), undefined), 'Claude Code is connected: Jaffer’s hooks are installed.') },
  { id: 'install-cli', title: 'Install the `jaffer` command in ~/.local/bin', section: 'Integrations', keywords: 'cli path shell command', run: () => guarded(async () => { const r = await call('setup.cli.install', {}); toast({ kind: 'info', text: r.hint ?? `Installed ${r.link}` }, 9000); }) },
  { id: 'reveal-home', title: 'Reveal session folder in Finder', section: 'App', run: () => void window.jaffer.reveal() },
  ...THEMES.map<Action>((t) => ({ id: `theme:${t.id}`, title: `Theme: ${t.name}`, section: 'Appearance', keywords: 'color scheme', run: () => patchConfig({ appearance: { theme: t.id } }) })),
];

function runAction(id: string): void {
  const a = actions.find((x) => x.id === id);
  if (a) void a.run();
}

/** Map native menu ids to actions. */
export function onMenu(id: string): void {
  if (id === 'palette') openOverlay('palette');
  else runAction(id);
}

