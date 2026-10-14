import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { effect } from '@preact/signals';
import { activePane, cfg, clock, currentClaude, historyItems, homeDir, panelFocusSearch, toast } from '../state';
import { conversationRow, filterByFolder, groupByDay, resumeCommand } from '../../shared/history-label';
import { terminals } from './TerminalView';
import { IconReset, IconSearch } from './icons';

/** The ⇧⌘O bump the search last took (module wide: a panel that opens again must not take the keyboard for an old bump). */
let focusedFor = 0;
/** Only the newest `claude.history` answer counts (a refresh while one is under way). */
let asked = 0;

/**
 * Past conversations, below the Now card: Claude Code's 50 newest (the daemon's `claude.history`: ids, folders, times, token costs,
 * never what was said), by day, filtered by folder. A click or Enter copies `claude --resume <id>`; nothing is typed, nothing is kept.
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
    return () => (off(), void asked++); // (an answer that comes after the panel closed is dropped)
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
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.conv-row[data-sel]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const toTerminal = () => terminals.get(activePane.value)?.focus();
  const pick = (i: number) => {
    const c = flat[i];
    if (!c) return;
    setSel(i);
    const cmd = resumeCommand(c.id);
    if (!cmd) return void toast({ kind: 'error', text: 'That conversation has no valid id.' });
    void navigator.clipboard.writeText(cmd).then(
      () => (toast({ kind: 'info', text: 'Copied. Paste it in the terminal.' }, 3500), toTerminal()), // (so ⌘V lands in the terminal, not the search)
      () => toast({ kind: 'error', text: 'Could not copy to the clipboard.' }),
    );
  };
  const onKey = (e: KeyboardEvent) => {
    const n = Math.max(1, flat.length);
    if (e.key === 'ArrowDown') (e.preventDefault(), setSel((sel + 1) % n));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((sel - 1 + n) % n));
    else if (e.key === 'Enter') (e.preventDefault(), pick(sel)); // (preventDefault: a focused row is not clicked a second time)
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
        <input ref={input} placeholder="Search folders" value={q} spellcheck={false} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
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
                <button key={`${n}-${c.id}`} class="conv-row" data-id={c.id} data-sel={n === sel ? '' : undefined} title={r.dir || undefined} onClick={() => pick(n)}>
                  <b class="conv-name">{r.name}</b>
                  <span class="conv-time">{r.time}</span>
                  <span class="conv-dir">{r.dir}</span>
                  <span class="conv-meta">{r.cost === null ? r.dur : `${r.dur} · ${r.cost}`}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
