import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { effect } from '@preact/signals';
import { activePane, cfg, clock, currentClaude, historyItems, homeDir, info, panelFocusSearch, patchConfig, toast } from '../state';
import { conversationName, conversationRow, costByFolder, filterByFolder, groupConversations, topFolders } from '../../shared/history-label';
import { parseNames, pinnedIds, removeName, setName, togglePin } from '../../shared/history-names';
import type { TrashResult } from '../../main/trash-conversations';
import { formatUsd } from '../../shared/claude-cost';
import { resumeLine } from '../../shared/resume-action';
import { copyToTerminal, loadHistory, resumeConversation } from '../resume';
import { terminals } from './TerminalView';
import { IconCopy, IconPencil, IconReset, IconSearch, IconStar, IconTrash } from './icons';
import { Menu } from './Blocks';

/** The ⇧⌘O bump the search last took (module wide: a panel that opens again must not take the keyboard for an old bump). */
let focusedFor = 0;
/** Only the newest `claude.history` answer counts (a refresh while one is under way). */
let asked = 0;

/** A change to `history.names` or `history.pinned`: shown at once, then kept in the config. */
function patchHistory(p: { names?: string[]; pinned?: string[] }): void {
  const c = cfg.value;
  if (!c) return;
  cfg.value = { ...c, history: { ...c.history, ...p } };
  void patchConfig({ history: p }).catch((e) => toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) }));
}

/** The toast after a removal: how many went to the Trash, and why any did not. */
function trashSaid(r: TrashResult): string {
  const n = r.trashed.length;
  const of = (reason: string) => r.refused.filter((x) => x.reason === reason).length;
  const [running, gone, failed] = [of('running'), of('not found'), of('error')];
  const why = [
    running && `${running} ${running === 1 ? 'is' : 'are'} still running`,
    gone && `${gone} ${gone === 1 ? 'was' : 'were'} not found`,
    failed && `${failed} could not be moved`,
  ].filter(Boolean);
  const head = n ? `Moved ${n} conversation${n === 1 ? '' : 's'} to the Trash` : 'Nothing moved to the Trash';
  return why.length ? `${head}${n ? ';' : ':'} ${why.join(', ')}` : head;
}

/**
 * Past conversations, below the Now card: Claude Code's 50 newest and the pinned ones (the daemon's `claude.history`: ids, folders, times,
 * token costs and, for the 30 newest, a redacted title line), the pinned first, then by day, filtered by name, title or folder and by the
 * folder chips. A click or Enter resumes one (`resumeConversation`: typed only at an idle prompt, else copied and a toast says why); the
 * row's copy button copies the same line; the pencil (or F2) names it, the star pins it (`history.names`, `history.pinned`: the person's
 * own text and ids, nothing of the transcript). The trash button (or Delete on a row) and the header's Remove… (this folder, all
 * listed) move conversations to the Trash: main asks first (a native dialog) and refuses a running one; the page only names ids. Read when
 * the panel opens, after a turn ends and on the refresh button; closed, the panel is not there, so nothing is read.
 */
export function Conversations(): VNode {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The row being named (its id). */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The folder chip chosen (memory only), null: all. */
  const [folder, setFolder] = useState<string | null>(null);
  const [costsOpen, setCostsOpen] = useState(false);
  /** Where the Remove… menu shows, null: closed. */
  const [removeAt, setRemoveAt] = useState<{ x: number; y: number } | null>(null);
  const removeBtn = useRef<HTMLButtonElement>(null);
  const removing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  /** What takes the keyboard back once the rows are drawn again: the row after a rename (Enter or Esc; not after a click elsewhere), its star after a pin (the row moves to or from the Pinned group). */
  const refocus = useRef<{ id: string; what: '.conv-row' | '.conv-pin' } | null>(null);
  const items = historyItems.value;
  const showCost = cfg.value?.claude?.showCost !== false;
  const names = useMemo(() => parseNames(cfg.value?.history?.names), [cfg.value?.history?.names]);
  const pinned = useMemo(() => pinnedIds(cfg.value?.history?.pinned), [cfg.value?.history?.pinned]);

  const load = () => {
    const n = ++asked;
    setLoading(true);
    loadHistory().then(
      () => {
        if (n !== asked) return;
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
  // (a layout effect: the keys typed right after F2 or the pencil must already land in the name)
  useLayoutEffect(() => {
    if (editing) return void (nameInput.current?.focus(), nameInput.current?.select());
    const to = refocus.current;
    refocus.current = null;
    if (to) list.current?.querySelector(`.conv-row[data-id="${CSS.escape(to.id)}"]`)?.closest('.conv-item')?.querySelector<HTMLElement>(to.what)?.focus();
  }, [editing, pinned]);

  const home = homeDir();
  const chips = useMemo(() => topFolders(items ?? [], home), [items, home]);
  const active = chips.some((f) => f.cwd === folder) ? folder : null; // (a chip gone after a refresh is All again)
  const shown = useMemo(() => filterByFolder(items ?? [], q, home, names).filter((c) => !active || c.cwd === active), [items, q, home, names, active]);
  const groups = useMemo(() => groupConversations(shown, clock.value, pinned), [shown, clock.value, pinned]);
  /** All listed: what the list shows without the folder chip (the search still applies: never a row the person cannot see under All). */
  const listed = useMemo(() => (active ? filterByFolder(items ?? [], q, home, names) : shown), [active, items, q, home, names, shown]);
  const flat = groups.flatMap((g) => g.items); // (the order the rows show in)
  const costs = useMemo(() => (showCost && costsOpen ? costByFolder(items ?? [], clock.value, home) : []), [showCost, costsOpen, items, clock.value, home]);
  useEffect(() => {
    list.current?.querySelector('.conv-row[data-sel]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const toTerminal = () => terminals.get(activePane.value)?.focus();
  const pick = (i: number) => {
    const c = flat[i];
    if (!c) return;
    setSel(i);
    resumeConversation(c);
  };
  const copyLine = (c: (typeof flat)[number]) => {
    const line = resumeLine(info.value, c);
    if (!line) return void toast({ kind: 'error', text: 'That conversation has no valid id.' });
    copyToTerminal(line, 'Copied. Paste it in the terminal.');
  };
  const startEdit = (id: string) => (setDraft(names.get(id) ?? ''), setEditing(id)); // (only the person's own name: a title is never written as one)
  const saveName = (id: string, name: string) => {
    patchHistory({ names: setName(cfg.value?.history?.names, id, name) });
    refocus.current = { id, what: '.conv-row' };
    setEditing(null);
  };
  const pin = (id: string) => {
    const next = togglePin(cfg.value?.history?.pinned, id);
    if (!next) return void toast({ kind: 'info', text: 'At most 50 conversations can be pinned.' }, 3500);
    if (document.activeElement?.matches('.conv-pin')) refocus.current = { id, what: '.conv-pin' };
    patchHistory({ pinned: next });
  };
  /** Asks main to move these to the Trash (it asks the person); then their names and pins go, the list is read again, and a toast says what happened. */
  const remove = async (ids: string[], row?: number) => {
    if (!ids.length || removing.current) return;
    removing.current = true;
    let r: TrashResult;
    try {
      r = await window.jaffer.trashConversations(ids);
    } catch (e) {
      return void toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      removing.current = false;
    }
    if (r.cancelled) return;
    const gone = new Set(r.trashed ?? []);
    if (gone.size) {
      const h = cfg.value?.history;
      patchHistory({ pinned: pinnedIds(h?.pinned).filter((id) => !gone.has(id)), names: [...gone].reduce<unknown>((l, id) => removeName(l, id), h?.names) as string[] });
      historyItems.value = historyItems.value?.filter((c) => !gone.has(c.id)) ?? null; // (at once; the read below has the last word)
    }
    load();
    toast({ kind: r.refused?.some((x) => x.reason === 'error') ? 'error' : 'info', text: trashSaid({ trashed: [...gone], refused: r.refused ?? [] }) });
    // a row removed from the keyboard: the keyboard goes on to the row that took its place
    if (row !== undefined)
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const rows = list.current?.querySelectorAll<HTMLElement>('.conv-row');
        (rows?.[Math.min(row, rows.length - 1)] ?? input.current)?.focus();
      });
  };
  const toggleRemove = () => {
    if (removeAt) return setRemoveAt(null);
    const b = removeBtn.current!.getBoundingClientRect();
    setRemoveAt({ x: b.left, y: b.bottom + 4 });
  };
  const onKey = (e: KeyboardEvent) => {
    const n = Math.max(1, flat.length);
    const t = e.target as HTMLElement;
    if (t.closest('.ctx-menu')) return; // (the Remove… menu's keys are its own)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      setSel(next);
      // on a row, the keyboard moves along (Enter on a row is the row's own click: it resumes the row that has the keyboard)
      if (t.classList.contains('conv-row')) list.current?.querySelectorAll<HTMLElement>('.conv-row')[next]?.focus();
    }
    // Enter in the search resumes the selected row (not an Enter that commits an input method's text); rows and the refresh button take Enter themselves
    else if (e.key === 'Enter' && t === input.current && !e.isComposing) (e.preventDefault(), pick(sel));
    else if (e.key === 'F2' && flat[sel]) (e.preventDefault(), startEdit(flat[sel]!.id));
    // Delete on a row (or one of its buttons) removes that row: the one with the keyboard, not the one under the mouse
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !(t instanceof HTMLInputElement) && t.closest('.conv-item')) {
      e.preventDefault();
      const id = t.closest('.conv-item')!.querySelector<HTMLElement>('.conv-row')?.dataset.id;
      const at = flat.findIndex((c) => c.id === id);
      if (id) void remove([id], at);
    }
    else if (e.key === 'Escape') (e.preventDefault(), toTerminal());
  };
  // the name's own keys stay with it (the arrows, Enter and Esc of the list must not act on the rows while it is typed in)
  const onNameKey = (e: KeyboardEvent, id: string) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), saveName(id, draft));
    else if (e.key === 'Escape') (e.preventDefault(), (refocus.current = { id, what: '.conv-row' }), setEditing(null));
  };

  let i = 0;
  return (
    <section class="sp-convos" data-slot="conversations" aria-label="Past conversations" onKeyDown={onKey}>
      <div class="conv-head">
        <span>Past conversations</span>
        <span class="conv-head-acts">
          <button
            ref={removeBtn}
            class="conv-remove"
            aria-haspopup="menu"
            aria-expanded={!!removeAt}
            disabled={!listed.length}
            onClick={toggleRemove}
          >
            Remove…
          </button>
          <button class="icon-btn sm conv-refresh" title="Refresh" aria-label="Refresh the past conversations" data-busy={loading ? '' : undefined} onClick={load}>
            <IconReset size={13} />
          </button>
        </span>
      </div>
      {removeAt && (
        <Menu
          x={removeAt.x}
          y={removeAt.y}
          items={[
            ...(active ? [{ label: `This folder (${shown.length})`, run: () => void remove(shown.map((c) => c.id)) }] : []),
            { label: `All listed (${listed.length})`, run: () => void remove(listed.map((c) => c.id)) },
          ]}
          anchor={removeBtn.current}
          done={() => (setRemoveAt(null), removeBtn.current?.focus())}
        />
      )}
      <label class="conv-search">
        <IconSearch size={13} />
        <input ref={input} placeholder="Search titles and folders" value={q} spellcheck={false} onInput={(e) => (setQ((e.target as HTMLInputElement).value), setSel(0))} />
      </label>
      {chips.length >= 2 && (
        <div class="conv-chips" role="group" aria-label="Folders">
          <button class="conv-chip" aria-pressed={active === null} onClick={() => (setFolder(null), setSel(0))}>
            All
          </button>
          {chips.map((f) => (
            <button key={f.cwd} class="conv-chip" aria-pressed={active === f.cwd} title={f.dir} data-cwd={f.cwd} onClick={() => (setFolder(f.cwd), setSel(0))}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {showCost && (
        <button class="conv-cost-toggle" aria-expanded={costsOpen} onClick={() => setCostsOpen(!costsOpen)}>
          Cost by folder
        </button>
      )}
      {showCost && costsOpen && (
        <div class="conv-costs">
          {costs.length ? (
            <>
              <div class="conv-cost-row conv-cost-head">
                <span>Folder</span>
                <span>Today</span>
                <span>This week</span>
              </div>
              {costs.map((f) => (
                <div key={f.cwd} class="conv-cost-row">
                  <span title={f.dir}>{f.dir}</span>
                  <span data-usd>≈ {formatUsd(f.today)}</span>
                  <span data-usd>≈ {formatUsd(f.week)}</span>
                </div>
              ))}
            </>
          ) : (
            <div class="conv-cost-none">No costs in the last 7 days.</div>
          )}
          <div class="conv-cost-note">An estimate at API list prices, from the 30 newest conversations (this week: the last 7 days).</div>
        </div>
      )}
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
              const isPinned = pinned.includes(c.id);
              const name = conversationName(c, names);
              return (
                <div key={c.id} class="conv-item">
                  {editing === c.id ? (
                    <input
                      ref={nameInput}
                      class="conv-rename"
                      value={draft}
                      placeholder={typeof c.title === 'string' && c.title ? c.title : 'Name this conversation'}
                      aria-label="Name this conversation (Enter saves, Esc cancels, empty removes the name)"
                      maxLength={80}
                      spellcheck={false}
                      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => onNameKey(e, c.id)}
                      onBlur={() => editing === c.id && setEditing(null)}
                    />
                  ) : (
                    <button class="conv-row" data-id={c.id} data-sel={n === sel ? '' : undefined} title={r.dir || undefined} onFocus={() => setSel(n)} onMouseEnter={() => setSel(n)} onClick={() => pick(n)}>
                      <b class="conv-name">{name}</b>
                      <span class="conv-dir">{r.dir || r.name}</span>
                      <span class="conv-meta">{[r.time, r.dur, ...(r.cost === null ? [] : [r.cost])].join(' · ')}</span>
                    </button>
                  )}
                  {/* the row's buttons sit over its right end and show on hover or with the keyboard: hidden, they take none of a narrow panel's width */}
                  <span class="conv-acts">
                    <button class="icon-btn sm conv-copy" title="Copy the resume command" aria-label="Copy the resume command" onClick={() => copyLine(c)}>
                      <IconCopy size={12} />
                    </button>
                    <button class="icon-btn sm conv-name-btn" title="Name it (F2)" aria-label="Name this conversation" onMouseDown={(e) => e.preventDefault()} onClick={() => (editing === c.id ? setEditing(null) : startEdit(c.id))}>
                      <IconPencil size={12} />
                    </button>
                    <button class="icon-btn sm conv-pin" title={isPinned ? 'Unpin' : 'Pin'} aria-label={isPinned ? 'Unpin this conversation' : 'Pin this conversation'} aria-pressed={isPinned} onClick={() => pin(c.id)}>
                      <IconStar size={12} />
                    </button>
                    <button class="icon-btn sm conv-trash" title="Move to Trash" aria-label="Move to Trash" onClick={() => void remove([c.id], n)}>
                      <IconTrash size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
