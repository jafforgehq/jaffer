import { activePane, cfg, info, openOverlay, patchConfig, refreshMemory, resumeOffer, safeCommand, toast, toggleSide } from './state';
import { isClaudeCommand } from '../shared/process-badge';
import { isSessionId, resumeCommand } from '../shared/claude-resume';
import { errorText } from '../shared/keep-running';
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

/** Take the Claude Code conversation that was running when Jaffer stopped back up: types `claude --resume <id>`, after the person's click. */
export function resumeClaude(): void {
  const offer = resumeOffer.value;
  const t = term();
  if (!offer || !t) {
    toast({ kind: 'info', text: 'There is no Claude Code conversation to resume here.' });
    return;
  }
  if (!isSessionId(offer.id)) return; // checked again here: this is typed into a shell
  if (info.value.busy) {
    toast({ kind: 'info', text: `The terminal is busy running ${safeCommand(info.value.busy)}.` });
    return;
  }
  t.type(`${resumeCommand(offer.id)}\r`);
  t.focus();
  resumeOffer.value = null; // gone at once; the daemon's own word follows when Claude Code starts
}

/** "Not now": forget that conversation. */
export function dismissResume(): void {
  resumeOffer.value = null;
  term()?.focus(); // the button that had the focus is gone: it goes back to the terminal, not to nowhere
  void window.jaffer.call('claude.resume.dismiss', {}).catch(() => undefined);
}

async function guarded(fn: () => Promise<unknown>, ok?: string): Promise<void> {
  try {
    await fn();
    if (ok) toast({ kind: 'info', text: ok });
  } catch (e) {
    toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * "Restart Claude Code, to use an update": the app asks the person first (a native dialog that says what stops and what comes back),
 * then restarts the shell in the same folder; the daemon takes the same conversation up in the new shell, with the usual notice and Cancel.
 */
export async function restartClaude(): Promise<void> {
  try {
    const r = await window.jaffer.restartClaude();
    if (r.cancelled) return;
    toast({ kind: 'info', text: r.resumable ? 'Shell restarted in the same folder. Claude Code comes back in the same conversation.' : 'Shell restarted in the same folder.' });
  } catch (e) {
    toast({ kind: 'error', text: errorText(e) }); // (a session daemon from before 0.5 does not know it: "Restart your session to use this")
  }
}

export const actions: Action[] = [
  { id: 'toggle-memory', title: 'Memory: show or hide', section: 'View', keys: '⇧⌘M', run: () => toggleSide('memory') },
  { id: 'resume-claude', title: 'Resume the Claude Code conversation that was running here', section: 'Terminal', keywords: 'claude code continue restart', run: resumeClaude },
  { id: 'run-claude', title: 'Run Claude Code in the terminal', section: 'Terminal', keys: '⇧⌘C', keywords: 'claude code cli', run: runClaude },
  { id: 'hide-window', title: 'Hide the window (the session keeps running)', section: 'Terminal', keys: '⌘W', run: () => window.close() },
  { id: 'clear', title: 'Clear screen', section: 'Terminal', keys: '⌘K', run: () => term()?.clear() },
  { id: 'find', title: 'Find in terminal', section: 'Terminal', keys: '⌘F', run: () => openOverlay('find') },
  { id: 'restart-shell', title: 'Restart shell', section: 'Terminal', run: () => guarded(() => call('session.restart', {}), 'Shell restarted in the same folder.') },
  { id: 'restart-claude', title: 'Restart Claude Code, to use an update', section: 'Terminal', keywords: 'update claude code new version', run: restartClaude },
  { id: 'settings', title: 'Open settings', section: 'App', keys: '⌘,', run: () => openOverlay('settings') },
  { id: 'zoom-in', title: 'Bigger text', section: 'View', keys: '⌘=', run: () => zoom(1) },
  { id: 'zoom-out', title: 'Smaller text', section: 'View', keys: '⌘-', run: () => zoom(-1) },
  { id: 'zoom-reset', title: 'Actual size', section: 'View', keys: '⌘0', run: () => zoom(0) },
  { id: 'reflect', title: 'Memory: learn from recent activity now', section: 'Memory', keywords: 'reflect evolve', run: () => guarded(async () => (toast({ kind: 'learn', text: (await call('memory.reflect', { force: true })).summary }), refreshMemory(0))) },
  { id: 'consolidate', title: 'Memory: tidy up (merge duplicates, fade stale)', section: 'Memory', keywords: 'consolidate dream cleanup', run: () => guarded(async () => (toast({ kind: 'info', text: (await call('memory.consolidate', {})).summary }), refreshMemory(0))) },
  { id: 'setup-claude', title: 'Connect Claude Code to Jaffer memory (MCP + hooks)', section: 'Integrations', keywords: 'claude mcp hooks', run: () => guarded(async () => (await call('setup.claude.install', {}), undefined), 'Claude Code now shares Jaffer’s memory.') },
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

