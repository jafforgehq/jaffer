import { effect } from '@preact/signals';
import { activePane, cfg, historyItems, info, toast } from './state';
import { freshList, lastConversation } from '../shared/history-label';
import { pinnedIds } from '../shared/history-names';
import { resumeAction } from '../shared/resume-action';
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

export function resumeConversation(c: Pick<Conversation, 'id' | 'cwd'>): void {
  const a = resumeAction(info.value, c);
  if (a.kind === 'none') return void toast({ kind: 'error', text: a.why });
  if (a.kind === 'copy') return copyToTerminal(a.text, a.why);
  const t = terminals.get(activePane.value);
  if (!t) return;
  if (Date.now() - typedAt < 2000) return void toast({ kind: 'info', text: 'Already resuming…' }, 2500);
  typedAt = Date.now();
  t.type(a.text); // (Ctrl-E Ctrl-U Ctrl-X Ctrl-K, the line, Enter: only at an idle prompt, as ⇧⌘C types `claude`)
  toast({ kind: 'info', text: 'Resuming…' }, 2500);
  t.focus();
}

/** The past conversations (`claude.history`, with the pinned ones even when older than the 50 newest). */
export async function readHistory(): Promise<Conversation[]> {
  const r = await window.jaffer.call<{ items?: unknown }>('claude.history', { include: pinnedIds(cfg.value?.history?.pinned) });
  return Array.isArray(r?.items) ? (r.items as Conversation[]) : [];
}

/**
 * ⇧⌘R: the newest conversation in the shell's folder, else the newest. The list is always read first (one RPC: a list the window kept
 * may be hours old, and an older conversation must not be resumed); when the read fails, the last list is used.
 */
export async function resumeLast(): Promise<void> {
  const r = await freshList(readHistory, historyItems.value);
  if (!r.items) return void toast({ kind: 'error', text: r.error ?? 'Could not read the past conversations.' });
  if (!r.error) historyItems.value = r.items;
  const c = lastConversation(r.items, info.value.cwd);
  if (!c) return void toast({ kind: 'info', text: 'No past conversations found' }, 3500);
  resumeConversation(c);
}
