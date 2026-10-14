import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { effect } from '@preact/signals';
import { activePane, cfg, clock, currentClaude, historyItems, homeDir, info, panelFocusSearch, toast } from '../state';
import { conversationRow, filterByFolder, groupByDay } from '../../shared/history-label';
import { resumeAction, resumeLine } from '../../shared/resume-action';
import { terminals } from './TerminalView';
import { IconCopy, IconReset, IconSearch } from './icons';

/** The ⇧⌘O bump the search last took (module wide: a panel that opens again must not take the keyboard for an old bump). */
let focusedFor = 0;
/** Only the newest `claude.history` answer counts (a refresh while one is under way). */
let asked = 0;
/** When a click last typed a resume line: a double click or a repeated Enter must not type a second one before the shell starts the first (cleared by the next command's start, else after 2 s). */
let typedAt = 0;

/**
 * Past conversations, below the Now card: Claude Code's 50 newest (the daemon's `claude.history`: ids, folders, times, token costs and,
 * for the 30 newest, a redacted title line), by day, filtered by title or folder. A click or Enter resumes one (`resumeAction`: typed
 * only at an idle prompt, else copied and a toast says why); the row's copy button copies the same line. Nothing is kept.
 * Read when the panel opens, after a turn ends and on the refresh button; closed, the panel is not there, so nothing is read.
 */
export function Conversations(): VNode {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = historyItems.value;
  const showCost = cfg.value?.claude?.showCost !== false;

  const load = () => {
    const n = ++asked;
    setLoading(true);
    window.jaffer.call<{ items?: unknown }>('claude.history', {}).then(
      (r) => {
        if (n !== asked) return;
        historyItems.value = Array.isArray(r?.items) ? (r.items as NonNullable<typeof items>) : [];
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (n !== asked) return;
        const text = e instanceof Error ? e.message : 'Could not read the past conversations.';
        toast({ kind: 'error', text });
        setError(text);
        setLoading(false);
      },
    );
  };
  useEffect(() => {
    load();
    // a finished turn changes the list (working → idle)
    let was = currentClaude()?.state;
    const off = effect(() => {
      const s = currentClaude()?.state;
      if (was === 'working' && s === 'idle') load();
      was = s;
    });
    const offTyped = effect(() => void (info.value.busy && (typedAt = 0)));
    return () => (off(), offTyped(), void asked++); // (an answer that comes after the panel closed is dropped)
  }, []);
  useEffect(() => {
    if (panelFocusSearch.value === focusedFor) return;
    focusedFor = panelFocusSearch.value;
    input.current?.focus();
    input.current?.select();
  }, [panelFocusSearch.value]);

  const home = homeDir();
  const shown = useMemo(() => filterByFolder(items ?? [], q, home), [items, q, home]);
  const groups = useMemo(() => groupByDay(shown, clock.value), [shown, clock.value]);
  const flat = groups.flatMap((g) => g.items); // (the order the rows show in)
  useEffect(() => {
    list.current?.querySelector('.conv-row[data-sel]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const toTerminal = () => terminals.get(activePane.value)?.focus();
  const copy = (text: string, said: string) =>
    void navigator.clipboard.writeText(text).then(
      () => (toast({ kind: 'info', text: said }, 3500), toTerminal()), // (so ⌘V lands in the terminal, not the search)
      () => toast({ kind: 'error', text: 'Could not copy to the clipboard.' }),
    );
  const pick = (i: number) => {
    const c = flat[i];
    if (!c) return;
    setSel(i);
    const a = resumeAction(info.value, c);
    if (a.kind === 'none') return void toast({ kind: 'error', text: a.why });
    if (a.kind === 'copy') return copy(a.text, a.why);
    const t = terminals.get(activePane.value);
    if (!t) return;
    if (Date.now() - typedAt < 2000) return void toast({ kind: 'info', text: 'Already resuming…' }, 2500);
    typedAt = Date.now();
    t.type(a.text); // (Ctrl-E Ctrl-U Ctrl-X Ctrl-K, the line, Enter: only at an idle prompt, as ⇧⌘C types `claude`)
    toast({ kind: 'info', text: 'Resuming…' }, 2500);
    t.focus();
  };
  const copyLine = (c: (typeof flat)[number]) => {
    const line = resumeLine(info.value, c);
    if (!line) return void toast({ kind: 'error', text: 'That conversation has no valid id.' });
    copy(line, 'Copied. Paste it in the terminal.');
  };
  const onKey = (e: KeyboardEvent) => {
    const n = Math.max(1, flat.length);
    const t = e.target as HTMLElement;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      setSel(next);
      // on a row, the keyboard moves along (Enter on a row is the row's own click: it resumes the row that has the keyboard)
      if (t.classList.contains('conv-row')) list.current?.querySelectorAll<HTMLElement>('.conv-row')[next]?.focus();
    }
    // Enter in the search resumes the selected row (not an Enter that commits an input method's text); rows and the refresh button take Enter themselves
    else if (e.key === 'Enter' && t === input.current && !e.isComposing) (e.preventDefault(), pick(sel));
    else if (e.key === 'Escape') (e.preventDefault(), toTerminal());
  };

  let i = 0;
  return (
    <section class="sp-convos" data-slot="conversations" aria-label="Past conversations" onKeyDown={onKey}>
      <div class="conv-head">
        <span>Past conversations</span>
        <button class="icon-btn sm conv-refresh" title="Refresh" aria-label="Refresh the past conversations" data-busy={loading ? '' : undefined} onClick={load}>
          <IconReset size={13} />
        </button>
      </div>
      <label class="conv-search">
        <IconSearch size={13} />
        <input ref={input} placeholder="Search titles and folders" value={q} spellcheck={false} onInput={(e) => (setQ((e.target as HTMLInputElement).value), setSel(0))} />
      </label>
      <div class="conv-list" ref={list}>
        {items === null && loading && <div class="conv-note">Loading…</div>}
        {error && <div class="conv-note">{error}</div>}
        {items !== null && shown.length === 0 && !error && <div class="conv-note">{items.length ? 'No match' : 'No Claude Code conversations found.'}</div>}
        {groups.map((g) => (
          <div class="conv-day" key={g.label}>
            <div class="conv-day-label">{g.label}</div>
            {g.items.map((c) => {
              const n = i++;
              const r = conversationRow(c, home, showCost);
              return (
                <div key={`${n}-${c.id}`} class="conv-item">
                  <button class="conv-row" data-id={c.id} data-sel={n === sel ? '' : undefined} title={r.dir || undefined} onFocus={() => setSel(n)} onMouseEnter={() => setSel(n)} onClick={() => pick(n)}>
                    <b class="conv-name">{typeof c.title === 'string' && c.title ? c.title : 'Conversation'}</b>
                    <span class="conv-dir">{r.dir || r.name}</span>
                    <span class="conv-meta">{[r.time, r.dur, ...(r.cost === null ? [] : [r.cost])].join(' · ')}</span>
                  </button>
                  <button class="icon-btn sm conv-copy" title="Copy the resume command" aria-label="Copy the resume command" onClick={() => copyLine(c)}>
                    <IconCopy size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
