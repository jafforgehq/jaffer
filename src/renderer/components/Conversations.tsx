import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { effect } from '@preact/signals';
import { activePane, cfg, clock, historyItems, homeDir, info, panelFocusSearch, patchConfig, toast, turnsEnded, usage5h } from '../state';
import { conversationName, conversationRow, costByFolder, filterConversations, formatBytes, groupConversations, tildeOf, topFolders } from '../../shared/history-label';
import { parseNames, pinnedIds, removeName, setName, togglePin } from '../../shared/history-names';
import { addTag, allTags, dropTags, hiddenIds, MAX_TAG, MAX_TAGS, parseTags, removeTag, tagColor, tagsOf, toggleHidden } from '../../shared/history-tags';
import type { Storage } from '../../core/claude/history';
import type { TrashResult } from '../../main/trash-conversations';
import { formatUsd } from '../../shared/claude-cost';
import { budgetLevels, parseProjectBudgets } from '../../shared/project-budgets';
import { resumeLine } from '../../shared/resume-action';
import { copyToTerminal, loadHistory, resumeConversation } from '../resume';
import { terminals } from './TerminalView';
import { IconCopy, IconEyeOff, IconPencil, IconReset, IconSearch, IconStar, IconTag, IconTrash } from './icons';
import { Menu } from './Blocks';
import { InfoButton } from './InfoButton';

/** The ⇧⌘O bump the search last took (module wide: a panel that opens again must not take the keyboard for an old bump). */
let focusedFor = 0;
/** Only the newest `claude.history` answer counts (a refresh while one is under way). */
let asked = 0;
/** (1.4.0) The same for `claude.search` (each typed query) and `claude.storage`. */
let searched = 0;
let measured = 0;

/** A change to `history.names`, `history.pinned`, `history.tags` or `history.hidden`: shown at once, then kept in the config. */
function patchHistory(p: { names?: string[]; pinned?: string[]; tags?: string[]; hidden?: string[] }): void {
  const c = cfg.value;
  if (!c) return;
  cfg.value = { ...c, history: { ...c.history, ...p } };
  void patchConfig({ history: p }).catch((e) => toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) }));
}

/** The toast after a removal: how many went to the Trash, and why any did not. */
function trashSaid(r: TrashResult): string {
  const n = r.trashed.length;
  if (r.refused.some((x) => x.reason === 'off')) return 'Moving conversations to the Trash is off in Settings → Privacy and permissions';
  if (r.refused.some((x) => x.reason === 'unknown')) return 'Jaffer could not check whether Claude is running, so nothing was moved';
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
 * (1.4.0) A row's tags: the tags in use as switches (this conversation's are on) and "New tag…" (Enter adds it, at most 3 a conversation,
 * 20 characters). ↑/↓ move, Esc or a click elsewhere closes it (Esc gives the keyboard back to the row's tag button).
 */
function TagMenu({ id, x, y, anchor, done }: { id: string; x: number; y: number; anchor: HTMLElement | null; done(back: boolean): void }): VNode {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const list = cfg.value?.history?.tags;
  const mine = tagsOf(list, id).map((t) => t.toLowerCase());
  const all = allTags(list);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>('input')?.focus(); // (a new tag can be typed at once; ↑ reaches the others)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && (e.preventDefault(), done(true)); // (an input method's Esc cancels its own text)
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node) && done(false); // (the tag button closes it itself)
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', away, true);
    return () => (window.removeEventListener('keydown', key, true), window.removeEventListener('mousedown', away, true));
  }, []);
  const set = (tag: string, on: boolean) => {
    const l = cfg.value?.history?.tags;
    const next = on ? addTag(l, id, tag) : removeTag(l, id, tag);
    if (!next) return void toast({ kind: 'info', text: tagsOf(l, id).length >= MAX_TAGS ? `At most ${MAX_TAGS} tags a conversation.` : 'At most 400 tags in all.' }, 3500);
    patchHistory({ tags: next });
  };
  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('button, input') ?? [])];
    const at = items.indexOf(e.target as HTMLElement);
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus());
    else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !e.isComposing) (e.preventDefault(), draft.trim() && (set(draft, true), setDraft('')));
  };
  return (
    <div class="ctx-menu conv-tagmenu" role="menu" aria-label="Tags" ref={ref} style={{ left: `${Math.max(0, Math.min(x, window.innerWidth - 200))}px`, top: `${Math.max(8, Math.min(y, window.innerHeight - 40 - 32 * (all.length + 1)))}px` }} onKeyDown={onKey}>
      {all.map((t) => {
        const on = mine.includes(t.tag.toLowerCase());
        return (
          <button key={t.tag} role="menuitemcheckbox" aria-checked={on} class="conv-tagopt" onClick={() => set(t.tag, !on)}>
            <i class="conv-tagdot" data-c={tagColor(t.tag)} />
            {t.tag}
          </button>
        );
      })}
      <div role="group" aria-label="New tag">
        <input class="conv-tagnew" placeholder="New tag…" aria-label="New tag (Enter adds it)" maxLength={MAX_TAG} value={draft} spellcheck={false} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
      </div>
    </div>
  );
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
  /** (1.4.0) Remove… → Older than 30/60/90 days: how many each, asked once when the menu opens (the ids are asked again on the click). */
  const [old, setOld] = useState<Record<number, number>>({});
  /** (1.4.0) The tag chip chosen (lower case, memory only), the open tag menu, the hidden ones shown, the storage view, deep search. */
  const [tag, setTag] = useState<string | null>(null);
  const [tagAt, setTagAt] = useState<{ id: string; x: number; y: number; anchor: HTMLElement } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [storage, setStorage] = useState<Storage | { error: string } | null>(null);
  const [deep, setDeep] = useState(false);
  const [found, setFound] = useState<{ q: string; hits: Map<string, number>; partial: boolean } | { q: string; error: string } | null>(null);
  const removeBtn = useRef<HTMLButtonElement>(null);
  const removing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  /** What takes the keyboard back once the rows are drawn again: the row after a rename (Enter or Esc; not after a click elsewhere), its star after a pin (the row moves to or from the Pinned group). */
  const refocus = useRef<{ id: string; what: '.conv-row' | '.conv-pin' } | null>(null);
  const items = historyItems.value;
  const showCost = cfg.value?.claude?.showCost !== false;
  const trashOn = cfg.value?.permissions?.trash !== false; // (Settings → Privacy and permissions: off, no trash button, no Remove… and Delete does nothing)
  const names = useMemo(() => parseNames(cfg.value?.history?.names), [cfg.value?.history?.names]);
  const pinned = useMemo(() => pinnedIds(cfg.value?.history?.pinned), [cfg.value?.history?.pinned]);
  const tags = useMemo(() => parseTags(cfg.value?.history?.tags), [cfg.value?.history?.tags]);
  const tagList = useMemo(() => allTags(cfg.value?.history?.tags), [cfg.value?.history?.tags]);
  const hidden = useMemo(() => new Set(hiddenIds(cfg.value?.history?.hidden)), [cfg.value?.history?.hidden]);
  /** (1.4.0) Deep search: only with Settings → Privacy and permissions' switch on, and this panel's "Search text" on, for 3 to 64 characters. */
  const deepOn = deep && cfg.value?.permissions?.deepSearch === true;
  const deepQ = q.trim();
  const deepValid = deepOn && Array.from(deepQ).length >= 3 && Array.from(deepQ).length <= 64;

  const load = () => {
    const n = ++asked;
    setLoading(true);
    // (1.4.0) the Now card's last 5 hours are read with the list: numbers only, and only with the cost shown
    if (cfg.value?.claude?.showCost !== false)
      void window.jaffer
      .call<{ tokens?: unknown; usd?: unknown }>('claude.usage5h', {})
      .then((r) => n === asked && (usage5h.value = typeof r?.tokens === 'number' ? { tokens: r.tokens, ...(typeof r.usd === 'number' ? { usd: r.usd } : {}) } : null))
      .catch(() => undefined);
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
  const loadStorage = () => {
    const n = ++measured;
    void window.jaffer.call<Storage>('claude.storage', {}).then(
      (r) => n === measured && setStorage(r),
      (e) => n === measured && setStorage({ error: e instanceof Error ? e.message : 'Could not measure the conversations.' }),
    );
  };
  useEffect(() => {
    if (storageOpen) loadStorage();
  }, [storageOpen]);
  // deep search: 300 ms after the last key, only the newest answer counts; nothing of it is kept but ids and counts
  useEffect(() => {
    const n = ++searched;
    if (!deepValid) return void setFound(null);
    const t = setTimeout(() => {
      void window.jaffer.call<{ hits: { id: string; count: number }[]; partial: boolean }>('claude.search', { q: deepQ }).then(
        (r) => n === searched && setFound({ q: deepQ, hits: new Map(r.hits.map((h) => [h.id, h.count])), partial: r.partial }),
        (e) => n === searched && setFound({ q: deepQ, error: e instanceof Error ? e.message : 'Could not search.' }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [deepValid, deepQ]);
  useEffect(() => () => void (searched++, measured++), []);
  useEffect(() => {
    load();
    // a finished turn of any session changes the list (working → idle); the focus moving does not
    const ended = turnsEnded.value;
    const off = effect(() => void (turnsEnded.value !== ended && load()));
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
  const activeTag = tag && tagList.some((t) => t.tag.toLowerCase() === tag) ? tag : null;
  /** Deep search's hits for what is typed now (none yet: an empty list while it searches), null: the titles and folders are searched. */
  const hits = deepValid ? (found?.q === deepQ && 'hits' in found ? found.hits : new Map<string, number>()) : null;
  const filter = { q, home, names, tag: activeTag, tags, hidden, hits };
  const shown = useMemo(() => filterConversations(items ?? [], { ...filter, folder: active, showHidden }), [items, q, home, names, active, activeTag, tags, hidden, hits, showHidden]);
  const groups = useMemo(() => groupConversations(shown, clock.value, pinned), [shown, clock.value, pinned]);
  /** All listed: what the list shows without the folder chip (the search and the tag still apply: never a row the person cannot see under All), never a hidden one. */
  const listed = useMemo(() => filterConversations(items ?? [], filter), [items, q, home, names, activeTag, tags, hidden, hits]);
  const thisFolder = useMemo(() => (active ? listed.filter((c) => c.cwd === active) : []), [listed, active]);
  const hiddenCount = useMemo(() => (items ?? []).filter((c) => hidden.has(c.id)).length, [items, hidden]);
  useEffect(() => void (hiddenCount || setShowHidden(false)), [hiddenCount]); // (none hidden: the next one hidden is out of sight again)
  /** Hits in conversations the list does not have (older than the 50 newest). */
  const unlisted = hits ? [...hits.keys()].filter((id) => !(items ?? []).some((c) => c.id === id)).length : 0;
  const flat = groups.flatMap((g) => g.items); // (the order the rows show in)
  const costs = useMemo(() => (showCost && costsOpen ? costByFolder(items ?? [], clock.value, home) : []), [showCost, costsOpen, items, clock.value, home]);
  /** (1.4.0) The person's project budgets, by folder: this week's cost against each (the costed rows, the 30 newest). */
  const budgets = useMemo(() => new Map(costsOpen ? budgetLevels(items ?? [], parseProjectBudgets(cfg.value?.claude?.projectBudgets, home), clock.value).map((b) => [b.cwd, b]) : []), [costsOpen, items, cfg.value?.claude?.projectBudgets, home, clock.value]);
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
  /** The keyboard goes on to the row now at `row` (after one was removed or hidden from the keyboard). */
  const focusRow = (row: number) =>
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const rows = list.current?.querySelectorAll<HTMLElement>('.conv-row');
      (rows?.[Math.min(row, rows.length - 1)] ?? input.current)?.focus();
    });
  const hide = (id: string, row: number) => {
    const next = toggleHidden(cfg.value?.history?.hidden, id);
    if (!next) return void toast({ kind: 'info', text: 'At most 500 conversations can be hidden.' }, 3500);
    patchHistory({ hidden: next });
    if (!showHidden && next.includes(id)) focusRow(row);
  };
  const openTags = (id: string, b: HTMLElement) => {
    if (tagAt?.id === id) return setTagAt(null);
    const r = b.getBoundingClientRect();
    setTagAt({ id, x: r.left, y: r.bottom + 4, anchor: b });
  };
  /**
   * Asks main to move these to the Trash (it asks the person); then their names, pins, tags and hidden marks go, the list (and the storage
   * view) is read again, and a toast says what happened (`more`: how many more Older than … would take: the person repeats it).
   */
  const remove = async (ids: string[], row?: number, more = 0) => {
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
      patchHistory({
        pinned: pinnedIds(h?.pinned).filter((id) => !gone.has(id)),
        names: [...gone].reduce<unknown>((l, id) => removeName(l, id), h?.names) as string[],
        tags: dropTags(h?.tags, gone),
        hidden: hiddenIds(h?.hidden).filter((id) => !gone.has(id)),
      });
      historyItems.value = historyItems.value?.filter((c) => !gone.has(c.id)) ?? null; // (at once; the read below has the last word)
    }
    load();
    if (storageOpen) loadStorage();
    const said = trashSaid({ trashed: [...gone], refused: r.refused ?? [] });
    toast({ kind: r.refused?.some((x) => x.reason === 'error' || x.reason === 'unknown') ? 'error' : 'info', text: more > 0 ? `${said} (${more} more: repeat to move them too)` : said });
    // a row removed from the keyboard: the keyboard goes on to the row that took its place
    if (row !== undefined) focusRow(row);
  };
  const toggleRemove = () => {
    if (removeAt) return setRemoveAt(null);
    const b = removeBtn.current!.getBoundingClientRect();
    setRemoveAt({ x: b.left, y: b.bottom + 4 });
    setOld({});
    void window.jaffer
      .call<{ counts: Record<number, number> }>('claude.old', { days: 30 })
      .then((r) => setOld(r.counts ?? {}))
      .catch(() => undefined);
  };
  /** The oldest 200 of that age as they are now (the app's question names exactly how many it found of them). */
  const removeOld = async (days: number) => {
    let r: { ids: string[]; total: number };
    try {
      r = await window.jaffer.call<{ ids: string[]; total: number }>('claude.old', { days });
    } catch (e) {
      return void toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
    if (!r.ids.length) return void toast({ kind: 'info', text: `No conversations older than ${days} days` }, 3500);
    await remove(r.ids, undefined, r.total - r.ids.length);
  };
  const olderItems = [30, 60, 90].flatMap((days) => ((old[days] ?? 0) > 0 ? [{ label: `Older than ${days} days (${old[days]})`, run: () => void removeOld(days) }] : []));
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
    else if (trashOn && (e.key === 'Delete' || e.key === 'Backspace') && !(t instanceof HTMLInputElement) && t.closest('.conv-item')) {
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
    <section class="sp-convos" data-tour="conversations" data-slot="conversations" aria-label="Past conversations" onKeyDown={onKey}>
      <div class="conv-head">
        <span>
          Past conversations
          <InfoButton id="transcript" />
        </span>
        <span class="conv-head-acts">
          {trashOn && (
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
          )}
          <button class="icon-btn sm conv-refresh" title="Refresh" aria-label="Refresh the past conversations" data-busy={loading ? '' : undefined} onClick={load}>
            <IconReset size={13} />
          </button>
        </span>
      </div>
      {trashOn && removeAt && (
        <Menu
          x={removeAt.x}
          y={removeAt.y}
          items={[
            ...(active ? [{ label: `This folder (${thisFolder.length})`, run: () => void remove(thisFolder.map((c) => c.id)) }] : []),
            { label: `All listed (${listed.length})`, run: () => void remove(listed.map((c) => c.id)) },
            ...olderItems,
          ]}
          note={olderItems.length ? 'Older than…: by when Claude Code last wrote it, all conversations on this Mac; includes pinned and hidden, at most 200 at a time.' : undefined}
          anchor={removeBtn.current}
          done={() => (setRemoveAt(null), removeBtn.current?.focus())}
        />
      )}
      {tagAt && <TagMenu key={tagAt.id} {...tagAt} done={(back) => (setTagAt(null), back && tagAt.anchor.focus())} />}
      <label class="conv-search">
        <IconSearch size={13} />
        <input ref={input} placeholder={deepOn ? 'Search the text of conversations' : 'Search titles and folders'} value={q} spellcheck={false} onInput={(e) => (setQ((e.target as HTMLInputElement).value), setSel(0))} />
        {cfg.value?.permissions?.deepSearch === true && (
          <button class="conv-deep" aria-pressed={deep} title="Search the text of the 200 newest conversations (only which ones match is shown)" onClick={() => (setDeep(!deep), setSel(0))}>
            Search text
          </button>
        )}
      </label>
      {deepOn && deepQ && (
        <div class="conv-deep-note">
          {!deepValid
            ? 'Type 3 to 64 characters to search the text.'
            : found?.q !== deepQ
              ? 'Searching the text…'
              : 'error' in found
                ? found.error
                : [found.partial && 'Stopped after 5 s: not every conversation was searched.', unlisted > 0 && `${unlisted} more in older conversations not listed.`].filter(Boolean).join(' ') || `${found.hits.size} conversation${found.hits.size === 1 ? '' : 's'} with this text.`}
        </div>
      )}
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
      {tagList.length > 0 && (
        <div class="conv-chips conv-tag-chips" role="group" aria-label="Tags">
          {tagList.map((t) => (
            <button key={t.tag} class="conv-chip conv-tag-chip" data-c={tagColor(t.tag)} aria-pressed={activeTag === t.tag.toLowerCase()} onClick={() => (setTag(activeTag === t.tag.toLowerCase() ? null : t.tag.toLowerCase()), setSel(0))}>
              {t.tag}
            </button>
          ))}
        </div>
      )}
      <div class="conv-toggles">
        {showCost && (
          <button class="conv-cost-toggle" aria-expanded={costsOpen} onClick={() => setCostsOpen(!costsOpen)}>
            Cost by folder
          </button>
        )}
        {/* (cleared at each press: never the figures of an earlier opening) */}
        <button class="st-toggle" aria-expanded={storageOpen} onClick={() => (setStorage(null), setStorageOpen(!storageOpen))}>
          Storage
        </button>
        {hiddenCount > 0 && (
          <button class="conv-hidden-toggle" aria-pressed={showHidden} onClick={() => (setShowHidden(!showHidden), setSel(0))}>
            Hidden ({hiddenCount})
          </button>
        )}
      </div>
      {storageOpen && (
        <div class="st-panel">
          {!storage ? (
            <div class="st-note">Measuring…</div>
          ) : 'error' in storage ? (
            <div class="st-note">{storage.error}</div>
          ) : (
            <>
              <div class="st-total">
                {formatBytes(storage.totalBytes)} in {storage.count} conversation{storage.count === 1 ? '' : 's'}
                {storage.partial && (
                  <span class="st-partial" title="Measuring stopped at its limit (20000 files or 3 s): the sizes are of what it measured">
                    {' '}
                    (partial)
                  </span>
                )}
              </div>
              {storage.biggest.map((b) => (
                <div key={b.id} class="st-row" data-id={b.id}>
                  <span class="st-name" title={b.cwd ? tildeOf(b.cwd, home) : undefined}>
                    {conversationName(b, names, home)}
                  </span>
                  <span class="st-size">{formatBytes(b.bytes)}</span>
                  {trashOn && (
                    <button class="icon-btn sm st-trash" title="Move to Trash" aria-label="Move to Trash" onClick={() => void remove([b.id])}>
                      <IconTrash size={12} />
                    </button>
                  )}
                  <span class="st-dir">{b.cwd ? tildeOf(b.cwd, home) : '(folder unknown)'}</span>
                </div>
              ))}
              <div class="st-note">Claude Code's transcripts with their subagent and tool files: the 10 biggest.</div>
            </>
          )}
        </div>
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
              {costs.map((f) => {
                const b = budgets.get(f.cwd);
                return (
                  <div key={f.cwd} class="conv-cost-row" data-level={b?.level}>
                    <span title={f.dir}>{f.dir}</span>
                    <span data-usd>≈ {formatUsd(f.today)}</span>
                    <span data-usd>
                      ≈ {formatUsd(f.week)}
                      {b ? ` of ${formatUsd(b.budget)}` : ''}
                    </span>
                  </div>
                );
              })}
            </>
          ) : (
            <div class="conv-cost-none">No costs in the last 7 days.</div>
          )}
          <div class="conv-cost-note">
            An estimate at API list prices, from the 30 newest conversations (this week: the last 7 days).
            {budgets.size > 0 && ' Budgets (Settings → Claude Code) count the same conversations: a folder turns yellow at 80 % of its budget, red past it.'}
          </div>
        </div>
      )}
      <div class="conv-list" ref={list}>
        {items === null && loading && <div class="conv-note">Loading…</div>}
        {error && <div class="conv-note">{error}</div>}
        {items !== null && shown.length === 0 && !error && (!hits || found?.q === deepQ) && <div class="conv-note">{items.length ? 'No match' : 'No Claude Code conversations found.'}</div>}
        {groups.map((g) => (
          <div class="conv-day" key={g.label}>
            <div class="conv-day-label">{g.label}</div>
            {g.items.map((c) => {
              const n = i++;
              const r = conversationRow(c, home, showCost);
              const isPinned = pinned.includes(c.id);
              const isHidden = hidden.has(c.id);
              const name = conversationName(c, names);
              const own = tags.get(c.id) ?? [];
              const matches = hits?.get(c.id);
              return (
                <div key={c.id} class="conv-item" data-hidden={isHidden ? '' : undefined}>
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
                      {(own.length > 0 || matches !== undefined) && (
                        <span class="conv-tags">
                          {matches !== undefined && <span class="conv-hits">{matches >= 99 ? '99+ matches' : `${matches} match${matches === 1 ? '' : 'es'}`}</span>}
                          {own.map((t) => (
                            <span key={t} class="conv-tag" data-c={tagColor(t)}>
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
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
                    <button
                      class="icon-btn sm conv-tag-btn"
                      title="Tags"
                      aria-label="Tags"
                      aria-haspopup="menu"
                      aria-expanded={tagAt?.id === c.id}
                      onClick={(e) => openTags(c.id, e.currentTarget as HTMLElement)}
                    >
                      <IconTag size={12} />
                    </button>
                    <button class="icon-btn sm conv-hide" title={isHidden ? 'Unhide' : 'Hide'} aria-label={isHidden ? 'Unhide' : 'Hide'} onClick={() => hide(c.id, n)}>
                      <IconEyeOff size={12} />
                    </button>
                    <button class="icon-btn sm conv-pin" title={isPinned ? 'Unpin' : 'Pin'} aria-label={isPinned ? 'Unpin this conversation' : 'Pin this conversation'} aria-pressed={isPinned} onClick={() => pin(c.id)}>
                      <IconStar size={12} />
                    </button>
                    {trashOn && (
                      <button class="icon-btn sm conv-trash" title="Move to Trash" aria-label="Move to Trash" onClick={() => void remove([c.id], n)}>
                        <IconTrash size={12} />
                      </button>
                    )}
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
