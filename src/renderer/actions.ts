import { activePane, cfg, info, overlay, panes, patchConfig, refreshMemory, setSide, side, toast, toggleRail, toggleSide } from './state';
import { closePane, splitPane } from './components/PaneTree';
import { terminals } from './components/TerminalView';
import { composerFocus } from './components/AgentPanel';
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
  if (info.value.busy) {
    toast({ kind: 'info', text: `The terminal is busy running ${info.value.busy}.` });
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
  { id: 'toggle-rail', title: 'Toggle sidebar', section: 'View', keys: '⌘B', keywords: 'session rail', run: toggleRail },
  { id: 'toggle-agent', title: 'Toggle Claude panel', section: 'View', keys: '⌘J', run: () => toggleSide('agent') },
  { id: 'toggle-memory', title: 'Toggle memory panel', section: 'View', keys: '⇧⌘M', run: () => toggleSide('memory') },
  {
    id: 'ask',
    title: 'Ask Claude…',
    section: 'Claude',
    keys: '⌘L',
    keywords: 'chat prompt agent',
    run: () => {
      setSide('agent');
      composerFocus.value++;
    },
  },
  { id: 'run-claude', title: 'Run Claude Code in the terminal', section: 'Terminal', keys: '⇧⌘C', keywords: 'claude code cli', run: runClaude },
  { id: 'split-right', title: 'Split pane right', section: 'Terminal', keys: '⌘D', run: () => splitPane('row') },
  { id: 'split-down', title: 'Split pane down', section: 'Terminal', keys: '⇧⌘D', run: () => splitPane('col') },
  { id: 'close-pane', title: 'Close pane (or hide the window)', section: 'Terminal', keys: '⌘W', run: () => (panes.value.length > 1 && activePane.value !== 'main' ? closePane() : window.close()) },
  { id: 'clear', title: 'Clear screen', section: 'Terminal', keys: '⌘K', run: () => term()?.clear() },
  { id: 'find', title: 'Find in terminal', section: 'Terminal', keys: '⌘F', run: () => (overlay.value = 'find') },
  { id: 'restart-shell', title: 'Restart shell', section: 'Terminal', run: () => guarded(() => call('session.restart', {}), 'Shell restarted in the same folder.') },
  { id: 'settings', title: 'Open settings', section: 'App', keys: '⌘,', run: () => (overlay.value = 'settings') },
  { id: 'zoom-in', title: 'Bigger text', section: 'View', keys: '⌘=', run: () => zoom(1) },
  { id: 'zoom-out', title: 'Smaller text', section: 'View', keys: '⌘-', run: () => zoom(-1) },
  { id: 'zoom-reset', title: 'Actual size', section: 'View', keys: '⌘0', run: () => zoom(0) },
  { id: 'reflect', title: 'Memory: learn from recent activity now', section: 'Memory', keywords: 'reflect evolve', run: () => guarded(async () => (toast({ kind: 'learn', text: (await call('memory.reflect', { force: true })).summary }), refreshMemory(0))) },
  { id: 'consolidate', title: 'Memory: tidy up (merge duplicates, fade stale)', section: 'Memory', keywords: 'consolidate dream cleanup', run: () => guarded(async () => (toast({ kind: 'info', text: (await call('memory.consolidate', {})).summary }), refreshMemory(0))) },
  { id: 'compact', title: 'Claude: compact the conversation', section: 'Claude', run: () => guarded(async () => (await call('agent.compact', {}), undefined), 'Conversation compacted.') },
  { id: 'setup-claude', title: 'Connect Claude Code to Jaffer memory (MCP + hooks)', section: 'Integrations', keywords: 'claude mcp hooks', run: () => guarded(async () => (await call('setup.claude.install', {}), undefined), 'Claude Code now shares Jaffer’s memory.') },
  { id: 'install-cli', title: 'Install the `jaffer` command in ~/.local/bin', section: 'Integrations', keywords: 'cli path shell command', run: () => guarded(async () => { const r = await call('setup.cli.install', {}); toast({ kind: 'info', text: r.hint ?? `Installed ${r.link}` }, 9000); }) },
  { id: 'reveal-home', title: 'Reveal session folder in Finder', section: 'App', run: async () => void window.jaffer.reveal((await window.jaffer.appInfo()).home) },
  ...THEMES.map<Action>((t) => ({ id: `theme:${t.id}`, title: `Theme: ${t.name}`, section: 'Appearance', keywords: 'color scheme', run: () => patchConfig({ appearance: { theme: t.id } }) })),
];

export function runAction(id: string): void {
  const a = actions.find((x) => x.id === id);
  if (a) void a.run();
}

/** Map native menu ids to actions. */
export function onMenu(id: string): void {
  const alias: Record<string, string> = { palette: 'palette' };
  if (id === 'palette') {
    overlay.value = 'palette';
    return;
  }
  runAction(alias[id] ?? id);
}

void side;
void panes;
