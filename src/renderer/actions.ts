import { activePane, addPin, cfg, focusMode, info, lastFind, openOverlay, overlay, patchConfig, safeCommand, setFocusMode, showConversations, showWhatsNew, toast, togglePanel } from './state';
import { redactText } from '../shared/redact';
import { COMMAND_HEAD } from '../shared/process-badge';
import { isClaudeCommand } from '../shared/process-badge';
import { FIND_OPTS, terminals } from './components/TerminalView';
import { THEMES } from './themes';
import { resumeLast } from './resume';

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

/** ⌘G / ⇧⌘G: the last search again, also with the find bar closed (then without highlights: the match is selected). */
function findAgain(dir: 1 | -1): void {
  const t = term();
  const q = lastFind.value;
  if (!t || !q) return void openOverlay('find');
  const opts = overlay.value === 'find' ? FIND_OPTS : {};
  if (dir > 0) t.search.findNext(q, opts);
  else t.search.findPrevious(q, opts);
}

/** ⇧⌘L: the selection's first line (redacted, at most 200 characters) pinned under the title bar; memory only. */
function pinSelection(): void {
  const first = (term()?.term.getSelection() ?? '').slice(0, 4 * COMMAND_HEAD).split(/\r?\n/).find((l) => l.trim()) ?? '';
  if (!first.trim()) return void toast({ kind: 'info', text: 'Select something first' }, 2500);
  addPin(redactText(first.trim()).slice(0, 200));
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
  { id: 'find-next', title: 'Find next', section: 'Terminal', keys: '⌘G', keywords: 'search again match', run: () => findAgain(1) },
  { id: 'find-prev', title: 'Find previous', section: 'Terminal', keys: '⇧⌘G', keywords: 'search again match', run: () => findAgain(-1) },
  { id: 'recent-commands', title: 'Recent commands', section: 'Terminal', keys: '⌘R', keywords: 'history copy clipboard', run: () => openOverlay('recent') },
  { id: 'shortcuts', title: 'Keyboard shortcuts', section: 'App', keys: '⌘/', keywords: 'keys accelerators cheat sheet help', run: () => openOverlay('keys') },
  { id: 'whats-new', title: "What's new", section: 'App', keywords: 'release notes changelog version update news', run: showWhatsNew },
  { id: 'history', title: 'Past Claude conversations…', section: 'App', keys: '⇧⌘O', keywords: 'resume claude history copy clipboard', run: showConversations },
  { id: 'resume-last', title: 'Resume last conversation', section: 'App', keys: '⇧⌘R', keywords: 'continue past history newest folder', run: resumeLast },
  { id: 'pin-selection', title: 'Pin selection', section: 'Terminal', keys: '⇧⌘L', keywords: 'pin line keep', run: pinSelection },
  { id: 'prompt-prev', title: 'Previous prompt', section: 'Terminal', keys: '⌘↑', keywords: 'jump command block scroll up', run: () => term()?.blocks.jump(-1) },
  { id: 'prompt-next', title: 'Next prompt', section: 'Terminal', keys: '⌘↓', keywords: 'jump command block scroll down', run: () => term()?.blocks.jump(1) },
  { id: 'copy-markdown', title: 'Copy as Markdown', section: 'Terminal', keys: '⌥⌘C', keywords: 'selection fenced code block clipboard', run: () => term()?.blocks.copyMarkdown() },
  { id: 'focus-mode', get title() { return focusMode.value ? 'Leave focus mode' : 'Focus mode'; }, section: 'App', keys: '⌥⌘F', keywords: 'quiet distraction notifications hold fade', run: () => setFocusMode(!focusMode.value) },
  { id: 'restart-shell', title: 'Restart shell', section: 'Terminal', run: () => guarded(() => call('session.restart', {}), 'Shell restarted in the same folder.') },
  { id: 'settings', title: 'Open settings', section: 'App', keys: '⌘,', run: () => openOverlay('settings') },
  { id: 'toggle-panel', title: 'Toggle side panel', section: 'View', keys: '⌘B', keywords: 'sidebar now claude status conversations', run: () => togglePanel('menu') },
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

