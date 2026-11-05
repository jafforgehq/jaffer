import { effect } from '@preact/signals';
import { activePane, cfg, claudeFor, focusPane, historyItems, info, overlay, paneInfo, panes, resumeAsk, toast } from './state';
import { freshList, lastConversation, newestOnly } from '../shared/history-label';
import { pinnedIds } from '../shared/history-names';
import { resumeAction, resumeLine } from '../shared/resume-action';
import { isClaudeCommand } from '../shared/process-badge';
import type { Conversation } from '../core/claude/history';
import { terminals } from './components/TerminalView';

/**
 * Resuming a past conversation (1.1.1, shared since 1.2.0 by the side panel's rows, the palette and Resume Last Conversation ⇧⌘R): typed
 * only at an idle prompt (`resumeAction`), else copied and a toast says why. Nothing else is ever typed.
 */

/** When a resume line was last typed: a double click or a repeated Enter must not type a second one before the shell starts the first (cleared by the next command's start, else after 2 s). */
let typedAt = 0;
effect(() => void (info.value.busy && (typedAt = 0)));

const toTerminal = () => terminals.get(activePane.value)?.focus();

/** Text to the clipboard, the toast, and the keyboard to the terminal (so ⌘V lands there). */
export function copyToTerminal(text: string, said: string): void {
  void navigator.clipboard.writeText(text).then(
    () => (toast({ kind: 'info', text: said }, 3500), toTerminal()),
    () => toast({ kind: 'error', text: 'Could not copy to the clipboard.' }),
  );
}

/** `askFirst` false: a Claude at its prompt is not asked about (the answer to that question calls it again, and a second question would loop). */
export function resumeConversation(c: Pick<Conversation, 'id' | 'cwd' | 'title'>, askFirst = true): void {
  const claudeIdle = askFirst && claudeFor(activePane.value)?.state === 'idle';
  const a = resumeAction(info.value, c, { allowTyping: cfg.value?.permissions?.resumeTyping !== false, claudeIdle });
  if (a.kind === 'none') return void toast({ kind: 'error', text: a.why });
  if (a.kind === 'copy') return copyToTerminal(a.text, a.why);
  if (a.kind === 'end-first') return void (resumeAsk.value = { pane: activePane.value, id: c.id, cwd: c.cwd, title: c.title }); // (nothing typed until a click on End and resume)
  const t = terminals.get(activePane.value);
  if (!t) return;
  if (Date.now() - typedAt < 2000) return void toast({ kind: 'info', text: 'Already resuming…' }, 2500);
  typedAt = Date.now();
  t.type(a.text); // (Ctrl-E Ctrl-U Ctrl-X Ctrl-K, the line, Enter: only at an idle prompt, as ⇧⌘C types `claude`)
  toast({ kind: 'info', text: 'Resuming…' }, 2500);
  t.focus();
}

/** How long `/exit` has to end Claude (the shell's end mark) before the resume line is copied instead. */
const EXIT_WAIT_MS = 10_000;
/** True once the terminal's shell says nothing runs; false after `ms`. */
const untilIdle = (pane: string, ms: number) =>
  new Promise<boolean>((done) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (paneInfo.value[pane]?.busy) {
        if (Date.now() - t0 > ms) (clearInterval(tick), done(false));
      } else (clearInterval(tick), done(true));
    }, 100);
  });

/**
 * *End and resume* (1.6.6): the only place Jaffer types anything into a running Claude, and only `/exit`. It is typed only after the
 * person's click, only into the terminal the question was asked in, only while that terminal's Claude is still idle at its prompt (its hooks)
 * and typing is allowed. Then the shell's end mark is awaited (10 s; no guess) and the usual resume typing runs, at the idle prompt.
 */
export async function endAndResume(): Promise<void> {
  const ask = resumeAsk.value;
  resumeAsk.value = null;
  if (!ask || !panes.value.includes(ask.pane)) return;
  const c = { id: ask.id, cwd: ask.cwd };
  focusPane(ask.pane);
  const busy = paneInfo.value[ask.pane]?.busy;
  const t = terminals.get(ask.pane);
  const stillIdle = !!busy && isClaudeCommand(busy) && claudeFor(ask.pane)?.state === 'idle' && cfg.value?.permissions?.resumeTyping !== false;
  if (!busy) return resumeConversation(c, false); // it ended while the question was open
  if (!stillIdle || !t) return resumeConversation(c, false); // it is busy again: the usual copy, with its reason
  t.type('\x05\x15/exit\r'); // (Ctrl-E Ctrl-U clear a half-typed prompt, then Claude Code's own exit command)
  toast({ kind: 'info', text: 'Ending Claude…' }, 2500);
  const ended = await untilIdle(ask.pane, EXIT_WAIT_MS);
  if (!panes.value.includes(ask.pane)) return;
  void loadHistory(); // (the conversation that just ended is now in the list)
  const line = resumeLine(paneInfo.value[ask.pane] ?? { cwd: '' }, c);
  if (!ended) return line ? copyToTerminal(line, 'Claude did not end: command copied') : undefined;
  if (activePane.value !== ask.pane) return line ? copyToTerminal(line, 'Claude ended. Command copied (you moved to another terminal)') : undefined;
  resumeConversation(c, false);
}

/** The past conversations (`claude.history`, with the pinned ones even when older than the 50 newest). */
export async function readHistory(): Promise<Conversation[]> {
  const r = await window.jaffer.call<{ items?: unknown }>('claude.history', { include: pinnedIds(cfg.value?.history?.pinned) });
  return Array.isArray(r?.items) ? (r.items as Conversation[]) : [];
}

/** One sequence for every read that replaces `historyItems`: an answer older than the newest read never overwrites it. */
const newest = newestOnly();

/** Reads the past conversations into `historyItems` (unless a newer read began meanwhile); false when its answer was not the newest. */
export async function loadHistory(): Promise<boolean> {
  const r = await newest(readHistory);
  if (r.newest) historyItems.value = r.value!;
  return r.newest;
}

/**
 * ⇧⌘R: the newest conversation in the shell's folder, else the newest. The list is always read first (one RPC: a list the window kept
 * may be hours old, and an older conversation must not be resumed); when the read fails, the last list is used.
 */
export async function resumeLast(): Promise<void> {
  if (overlay.value === 'onboarding') return; // (first run first, as for What's New)
  const read = await newest(() => freshList(readHistory, historyItems.value)); // (freshList never fails)
  const r = read.value!;
  if (!r.items) return void toast({ kind: 'error', text: r.error ?? 'Could not read the past conversations.' });
  if (!r.error && read.newest) historyItems.value = r.items;
  const c = lastConversation(r.items, info.value.cwd);
  if (!c) return void toast({ kind: 'info', text: 'No past conversations found' }, 3500);
  resumeConversation(c);
}
