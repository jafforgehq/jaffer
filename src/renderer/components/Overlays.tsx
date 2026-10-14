import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { activePane, appVersion, cfg, claudeLive, commands, fmtAgo, lastFind, overlay, pasteAsk, patchConfig, pins, safeCommand, tildePath, toast, updateState, type ClaudeAuthState } from '../state';
import { EDITOR_SCHEMES, editorUrl } from '../../shared/editor-url';
import type { UpdateState } from '../../shared/update-policy';
import { InstallCommand } from './ClaudeInstall';
import { actions, runClaude, type Action } from '../actions';
import { FIND_OPTS, terminals } from './TerminalView';
import { THEMES } from '../themes';
import { fmtDuration, hookHealthWarning } from '../claude-ui';
import { formatUsd } from '../../shared/claude-cost';
import { resumeCommand } from '../../shared/history-label';
import { COMPANIONS, companionOf } from '../../shared/companions';
import { CompanionPreview } from './Pet';
import { IconAgent, IconCommandKey, IconGear, IconLayout, IconPalette, IconPlug, IconSearch, IconTerminal, IconX, IconBolt, IconDownload, IconReset } from './icons';

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

function Modal({ title, onClose, children, wide, xwide, center }: { title?: string; onClose: () => void; children: preact.ComponentChildren; wide?: boolean; xwide?: boolean; center?: boolean }): VNode {
  const dialog = useRef<HTMLDivElement>(null);
  // (a layout effect: an Esc pressed right after the dialog appeared must already find this listener)
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', k, true);
    // keyboard focus goes into the dialog (the terminal keeps it otherwise, and Tab and typing would go to the shell behind it)
    const el = dialog.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      window.removeEventListener('keydown', k, true);
      // and back to the terminal when the dialog goes, unless something else has taken it
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) terminals.get(activePane.value)?.focus();
      });
    };
  }, []);
  return (
    <div class={`scrim ${center ? 'center' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} tabIndex={-1} class={`modal ${wide ? 'wide' : ''} ${xwide ? 'xwide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {title && (
          <div class="modal-head">
            <h3>{title}</h3>
            <button class="icon-btn" onClick={onClose} aria-label="Close">
              <IconX size={15} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): VNode {
  return (
    <span class="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <i />
    </span>
  );
}

// ------------------------------------------------------------------ palette

const SECTION_ORDER = ['View', 'Claude', 'Terminal', 'Integrations', 'Appearance', 'App'];
const SECTION_ICON: Record<string, (p: { size: number }) => VNode> = {
  View: IconLayout,
  Claude: IconAgent,
  Terminal: IconTerminal,
  Integrations: IconPlug,
  Appearance: IconPalette,
  App: IconGear,
};

function highlight(text: string, q: string): VNode | string {
  const t = q.trim().toLowerCase();
  const i = t ? text.toLowerCase().indexOf(t) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + t.length)}</mark>
      {text.slice(i + t.length)}
    </>
  );
}

export function Palette(): VNode {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => input.current?.focus(), []); // before paint, so the first keystrokes land here
  const results = useMemo<Action[]>(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [...actions].sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));
    return actions
      .map((a) => {
        const hay = `${a.title} ${a.section} ${a.keywords ?? ''}`.toLowerCase();
        let s = 0;
        if (hay.includes(t)) s = 10 - Math.min(9, hay.indexOf(t) / 6);
        else if (t.split(/\s+/).every((w) => hay.includes(w))) s = 4;
        return { a, s };
      })
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .map((x) => x.a);
  }, [q]);
  const total = results.length;
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.pal-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const close = () => (overlay.value = null);
  const run = (i: number) => {
    close();
    if (i < results.length) void results[i]!.run();
  };
  const rows: VNode[] = [];
  let lastSection = '';
  results.slice(0, 60).forEach((a, i) => {
    if (!q.trim() && a.section !== lastSection) {
      lastSection = a.section;
      rows.push(
        <div class="pal-group" key={`g-${a.section}`}>
          {a.section}
        </div>,
      );
    }
    const Ico = SECTION_ICON[a.section] ?? IconCommandKey;
    rows.push(
      <button key={a.id} class={`pal-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(i)}>
        <span class="pal-ico">
          <Ico size={13} />
        </span>
        <span class="pal-title">{highlight(a.title, q)}</span>
        {q.trim() && <span class="pal-sec">{a.section}</span>}
        {a.keys && <kbd>{a.keys}</kbd>}
      </button>,
    );
  });
  return (
    <Modal onClose={close}>
      <div class="palette">
        <div class="pal-input">
          <IconSearch size={17} />
          <input
            ref={input}
            placeholder="Type a command…"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((sel + 1) % Math.max(1, total)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((sel - 1 + total) % Math.max(1, total)));
              else if (e.key === 'Enter') (e.preventDefault(), total && run(sel));
            }}
          />
        </div>
        <div class="palette-list" ref={list}>
          {rows}
        </div>
        <div class="pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ find

export function FindBar(): VNode {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  useLayoutEffect(() => input.current?.focus(), []);
  const h = () => terminals.get(activePane.value);
  useEffect(() => {
    const sub = h()?.search.onDidChangeResults(setHits);
    return () => sub?.dispose();
  }, []);
  const close = () => {
    h()?.search.clearDecorations();
    overlay.value = null;
    h()?.focus();
  };
  const opts = FIND_OPTS;
  const count = !q || !hits ? '' : hits.resultCount === 0 ? 'No results' : hits.resultIndex >= 0 ? `${hits.resultIndex + 1} of ${hits.resultCount}` : `${hits.resultCount}+`;
  return (
    <div class="findbar">
      <input
        ref={input}
        placeholder="Find in terminal"
        value={q}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setQ(v);
          if (v) lastFind.value = v;
          h()?.search.findNext(v, { ...opts, incremental: true });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.shiftKey ? h()?.search.findPrevious(q, opts) : h()?.search.findNext(q, opts));
          else if (e.key === 'Escape') close();
        }}
      />
      <span class="find-count" aria-live="polite">
        {count}
      </span>
      <button class="icon-btn" onClick={() => h()?.search.findPrevious(q, opts)} title="Previous (⇧↵)" aria-label="Previous match">
        ↑
      </button>
      <button class="icon-btn" onClick={() => h()?.search.findNext(q, opts)} title="Next (↵)" aria-label="Next match">
        ↓
      </button>
      <button class="icon-btn" onClick={close} aria-label="Close search">
        <IconX size={14} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ recent commands, the paste question, pins

/** ⌘R: this session's commands (sensitive ones were never kept). Enter copies the chosen one to the clipboard; nothing is typed. */
export function RecentCommands(): VNode {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => input.current?.focus(), []);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return commands.value.map((c) => ({ c, shown: safeCommand(c.cmd).replace(/\s+/g, ' ').trim() })).filter((r) => !t || r.shown.toLowerCase().includes(t));
  }, [q, commands.value]); // (a command that ends while the list is open shows up)
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.pal-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const close = () => (overlay.value = null);
  const pick = (i: number) => {
    const r = rows[i];
    close();
    if (!r) return;
    void navigator.clipboard.writeText(r.c.cmd).then(
      () => toast({ kind: 'info', text: 'Copied. Paste it in the terminal.' }, 3500),
      () => toast({ kind: 'error', text: 'Could not copy to the clipboard.' }),
    );
  };
  return (
    <Modal onClose={close}>
      <div class="palette recent-list">
        <div class="pal-input">
          <IconSearch size={17} />
          <input
            ref={input}
            placeholder="Recent commands…"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              const n = Math.max(1, rows.length);
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((sel + 1) % n));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((sel - 1 + n) % n));
              else if (e.key === 'Enter') (e.preventDefault(), pick(sel));
            }}
          />
        </div>
        <div class="palette-list" ref={list}>
          {rows.length === 0 && <div class="pal-group">{commands.value.length ? 'No match' : 'No commands yet in this session'}</div>}
          {rows.slice(0, 200).map((r, i) => (
            <button key={`${r.c.at}-${i}`} class={`pal-row ${i === sel ? 'sel' : ''}`} data-exit={r.c.exit ?? ''} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              <span class="pal-title recent-cmd">{highlight(r.shown.slice(0, 200), q)}</span>
              <span class="recent-ago">{fmtAgo(r.c.at)}</span>
            </button>
          ))}
        </div>
        <div class="pal-foot">
          <span>
            <kbd>↵</kbd> copy to the clipboard
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span>Nothing is typed; this list is not saved.</span>
        </div>
      </div>
    </Modal>
  );
}

/** One of Claude Code's past conversations (the daemon's `claude.history`: only what the transcript's ends say, never what was said). */
interface PastConversation {
  id: string;
  cwd?: string;
  endedAt: number;
  durMs?: number;
  usd?: number;
}

/** ⇧⌘O: the 50 newest Claude Code conversations. Enter copies `claude --resume <id>` to the clipboard; nothing is typed, nothing is kept. */
export function PastConversations(): VNode {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [items, setItems] = useState<PastConversation[] | null>(null); // null: still loading
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const showCost = cfg.value?.claude?.showCost !== false;
  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => {
    let on = true;
    window.jaffer.call<{ items: PastConversation[] }>('claude.history', {}).then(
      (r) => on && setItems(Array.isArray(r?.items) ? r.items : []),
      (e) => {
        if (!on) return;
        setItems([]);
        toast({ kind: 'error', text: e instanceof Error ? e.message : 'Could not read the past conversations.' });
      },
    );
    return () => void (on = false);
  }, []);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).map((c) => ({ c, dir: c.cwd ? tildePath(c.cwd) : '' })).filter((r) => !t || r.dir.toLowerCase().includes(t));
  }, [q, items]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.pal-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const close = () => (overlay.value = null);
  const pick = (i: number) => {
    const r = rows[i];
    if (!r) return;
    const cmd = resumeCommand(r.c.id);
    close();
    if (!cmd) return toast({ kind: 'error', text: 'That conversation has no valid id.' });
    void navigator.clipboard.writeText(cmd).then(
      () => toast({ kind: 'info', text: 'Copied. Paste it in the terminal.' }, 3500),
      () => toast({ kind: 'error', text: 'Could not copy to the clipboard.' }),
    );
  };
  return (
    <Modal onClose={close}>
      <div class="palette hist-list">
        <div class="pal-input">
          <IconSearch size={17} />
          <input
            ref={input}
            placeholder="Past Claude conversations… (filter by folder)"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              const n = Math.max(1, rows.length);
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((sel + 1) % n));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((sel - 1 + n) % n));
              else if (e.key === 'Enter') (e.preventDefault(), pick(sel));
            }}
          />
        </div>
        <div class="palette-list" ref={list}>
          {items === null && <div class="pal-group">Loading…</div>}
          {items !== null && rows.length === 0 && <div class="pal-group">{items.length ? 'No match' : 'No Claude Code conversations found.'}</div>}
          {rows.map((r, i) => (
            <button key={`${i}-${r.c.id}`} class={`pal-row ${i === sel ? 'sel' : ''}`} data-id={r.c.id} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              <span class="hist-ago">{fmtAgo(r.c.endedAt)}</span>
              <span class="pal-title hist-dir">{highlight(r.dir || '(folder unknown)', q)}</span>
              <span class="hist-dur">{typeof r.c.durMs === 'number' ? fmtDuration(r.c.durMs) : '–'}</span>
              {showCost && <span class="hist-cost">{typeof r.c.usd === 'number' ? `≈ ${formatUsd(r.c.usd)}` : '–'}</span>}
            </button>
          ))}
        </div>
        <div class="pal-foot">
          <span>
            <kbd>↵</kbd> copy <code>claude --resume</code> to the clipboard
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span>Nothing is typed; this list is not saved.</span>
        </div>
      </div>
    </Modal>
  );
}

/** Feature 10: "Paste 14 lines?" over the bottom of the terminal; Enter pastes, Esc does not. */
export function PasteBar(): VNode | null {
  const ask = pasteAsk.value;
  const done = (paste: boolean) => {
    const t = terminals.get(activePane.value);
    pasteAsk.value = null;
    if (paste && ask) t?.paste(ask.text);
    t?.focus();
  };
  useLayoutEffect(() => {
    if (!ask) return;
    const key = (e: KeyboardEvent) => {
      if ((e.key !== 'Enter' && e.key !== 'Escape') || (overlay.value && overlay.value !== 'find')) return; // another dialog's keys are its own (the find bar is no dialog)
      e.preventDefault();
      e.stopPropagation();
      done(e.key === 'Enter');
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [ask]);
  if (!ask) return null;
  return (
    <div class="paste-bar" role="alertdialog" aria-label={`Paste ${ask.lines} lines?`}>
      <b>Paste {ask.lines} lines?</b>
      <code class="paste-first">{ask.first}</code>
      <button class="btn primary" onClick={() => done(true)}>
        Paste <kbd>↵</kbd>
      </button>
      <button class="btn" onClick={() => done(false)}>
        Cancel <kbd>esc</kbd>
      </button>
    </div>
  );
}

/** Feature 39: up to three pinned lines under the title bar; memory only. */
export function Pins(): VNode | null {
  const strip = useRef<HTMLDivElement>(null);
  const n = pins.value.length;
  // what anchors at the top of the card (the sticky command header, the find bar) moves down by the strip's height
  useLayoutEffect(() => {
    const area = strip.current?.parentElement ?? document.querySelector<HTMLElement>('.terminal-area');
    area?.style.setProperty('--pins-h', `${strip.current?.offsetHeight ?? 0}px`);
  }, [n]);
  if (!n) return null;
  return (
    <div class="pins" ref={strip}>
      {pins.value.map((p) => (
        <div key={p.id} class="pin" title={p.text}>
          <span class="pin-text">{p.text}</span>
          <button class="icon-btn sm" aria-label="Unpin" onClick={() => (pins.value = pins.value.filter((x) => x.id !== p.id))}>
            <IconX size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ settings

function Field({ label, hint, children, buttons }: { label: string; hint?: string; children: preact.ComponentChildren; buttons?: boolean }): VNode {
  const body = (
    <>
      <span class="field-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span class="field-ctl">{children}</span>
    </>
  );
  // A <label> forwards a click on its words to its first button, which would press "Reinstall" or "Reset…" for a stray click.
  return buttons ? <div class="field">{body}</div> : <label class="field">{body}</label>;
}

type Section = 'appearance' | 'terminal' | 'integrations' | 'updates' | 'reset';

export function Settings(): VNode {
  const c = cfg.value!;
  const [section, setSection] = useState<Section>('appearance');
  const [claude, setClaude] = useState<{ claudeInstalled: boolean; hooks: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const refresh = () => {
    void call('setup.claude.status', {}).then(setClaude).catch(() => undefined);
  };
  useEffect(refresh, []);
  const set = (p: object) => void patchConfig(p).catch((e) => toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) }));
  /** The daily budget field: what was typed, kept to 0..100000 (anything else keeps the setting); the field shows what was kept, also when the config does not change and nothing re-renders. */
  const commitBudget = (el: HTMLInputElement) => {
    const kept = cfg.value?.claude?.dailyBudgetUsd ?? 0;
    const v = Number(el.value);
    const usd = Number.isFinite(v) ? Math.min(100_000, Math.max(0, v)) : kept;
    el.value = String(usd);
    if (usd !== kept) set({ claude: { dailyBudgetUsd: usd } });
  };
  const [openAtLogin, setOpenAtLogin] = useState(false);
  useEffect(() => void window.jaffer.appInfo().then((i) => setOpenAtLogin(!!i.openAtLogin)).catch(() => undefined), []);
  const run = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name);
    try {
      await fn();
      toast({ kind: 'info', text: ok });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
      refresh();
    }
  };

  const nav: { id: Section; label: string; icon: VNode }[] = [
    { id: 'appearance', label: 'Appearance', icon: <IconPalette size={14} /> },
    { id: 'terminal', label: 'Terminal', icon: <IconTerminal size={14} /> },
    { id: 'integrations', label: 'Claude Code', icon: <IconPlug size={14} /> },
    { id: 'updates', label: 'Updates', icon: <IconDownload size={14} /> },
    { id: 'reset', label: 'Reset', icon: <IconReset size={14} /> },
  ];

  return (
    <Modal title="Settings" onClose={() => (overlay.value = null)} xwide center>
      <div class="settings">
        <nav class="settings-nav">
          {nav.map((n) => (
            <button key={n.id} class={section === n.id ? 'on' : ''} onClick={() => setSection(n.id)}>
              {n.icon}
              {n.label}
            </button>
          ))}
          <div class="grow" />
          <div class="faint" style={{ padding: '0 9px', fontSize: '11px' }}>
            Jaffer {appVersion.value}
          </div>
        </nav>
        <div class="settings-body">
          {section === 'appearance' && (
            <>
              <h4>Appearance</h4>
              <p class="lede">Themes restyle the whole app, not just the terminal.</p>
              <div class="themes">
                {THEMES.map((t) => (
                  <button key={t.id} class={`theme-card ${c.appearance.theme === t.id ? 'on' : ''}`} onClick={() => set({ appearance: { theme: t.id } })}>
                    <span class="theme-prev" style={{ background: t.term.background, color: t.term.foreground }}>
                      <span class="tl">
                        <b style={{ color: t.accent }}>❯</b> git log
                      </span>
                      <span class="tl" style={{ color: t.term.green }}>
                        ✓ 16 passed
                      </span>
                      <span class="tl">
                        <span style={{ color: t.term.blue }}>src/</span> <span style={{ color: t.term.magenta }}>app.ts</span>
                      </span>
                    </span>
                    {t.name}
                  </button>
                ))}
              </div>
              <Field label="Follow macOS / time of day" hint="the theme above is the dark one; the light theme below takes over in macOS's light appearance, or from 07:00 to 19:00">
                <select value={c.appearance.autoTheme ?? 'off'} onChange={(e) => set({ appearance: { autoTheme: (e.target as HTMLSelectElement).value } })}>
                  <option value="off">Off</option>
                  <option value="system">macOS appearance</option>
                  <option value="time">Time of day</option>
                </select>
              </Field>
              <Field label="Light theme">
                <select value={c.appearance.lightTheme} onChange={(e) => set({ appearance: { lightTheme: (e.target as HTMLSelectElement).value } })}>
                  {THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Font size">
                <input type="number" min={8} max={28} value={c.appearance.fontSize} onChange={(e) => set({ appearance: { fontSize: Math.min(28, Math.max(8, Math.round(Number((e.target as HTMLInputElement).value)) || c.appearance.fontSize)) } })} />
              </Field>
              <Field label="Font family">
                <input type="text" value={c.appearance.fontFamily} onChange={(e) => set({ appearance: { fontFamily: (e.target as HTMLInputElement).value } })} />
              </Field>
              <Field label="Cursor">
                <select value={c.appearance.cursorStyle} onChange={(e) => set({ appearance: { cursorStyle: (e.target as HTMLSelectElement).value } })}>
                  <option value="block">Block</option>
                  <option value="bar">Bar</option>
                  <option value="underline">Underline</option>
                </select>
              </Field>
              <Field label="Option key acts as Meta" hint="word movement and Claude Code shortcuts">
                <Switch checked={c.appearance.optionAsMeta} onChange={(v) => set({ appearance: { optionAsMeta: v } })} />
              </Field>
              <Field label="Window opacity" hint="shows the desktop through the window (only while the blur below is on)">
                <input type="range" min={0.6} max={1} step={0.02} value={c.appearance.opacity} onInput={(e) => set({ appearance: { opacity: Number((e.target as HTMLInputElement).value) } })} />
              </Field>
              <Field label="Blur behind the window" hint="frosted glass: what is behind the window is blurred. Off, the window is solid">
                <Switch checked={c.appearance.blur !== false} onChange={(v) => set({ appearance: { blur: v } })} />
              </Field>
              <Field label="Window glow" hint="a soft light on the window's edge: a pulse while Claude needs you, steady while it works, a flash when it is done. Not with Animations off">
                <Switch checked={c.appearance.glow !== false} onChange={(v) => set({ appearance: { glow: v } })} />
              </Field>
              <Field label="System stats in the title bar" hint="small bars for CPU, memory and battery, refreshed every 5 seconds while this is on">
                <Switch checked={c.appearance.systemStats === true} onChange={(v) => set({ appearance: { systemStats: v } })} />
              </Field>
              <Field label="Animations" hint="a little life while Claude works. Also off when macOS Reduce motion is on">
                <Switch checked={c.appearance.animations !== false} onChange={(v) => set({ appearance: { animations: v } })} />
              </Field>
              <Field label="Companion" hint="a little animation in a corner of the terminal: it works while something runs, and shows when Claude needs you">
                <Switch checked={c.appearance.pet !== false} onChange={(v) => set({ appearance: { pet: v } })} />
              </Field>
              <div
                class="companions"
                role="radiogroup"
                aria-label="Companion"
                data-off={c.appearance.pet === false ? '' : undefined}
                onKeyDown={(e) => {
                  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                  if (!step) return;
                  e.preventDefault();
                  // one step from the card that has the focus (not from the last render: a held key repeats faster than the config comes back)
                  const group = e.currentTarget as HTMLElement;
                  const here = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-id]')?.dataset.id ?? companionOf(c.appearance.companion);
                  const at = Math.max(0, COMPANIONS.findIndex((o) => o.id === here));
                  const next = COMPANIONS[(at + step + COMPANIONS.length) % COMPANIONS.length]!;
                  group.querySelector<HTMLElement>(`[data-id='${next.id}']`)?.focus();
                  set({ appearance: { companion: next.id } });
                }}
              >
                {COMPANIONS.map((o) => {
                  const on = companionOf(c.appearance.companion) === o.id;
                  return (
                    <button
                      key={o.id}
                      data-id={o.id}
                      role="radio"
                      aria-checked={on}
                      tabIndex={on ? 0 : -1}
                      class={`companion-card ${on ? 'on' : ''}`}
                      onClick={() => set({ appearance: { companion: o.id } })}
                    >
                      <span class="comp-prev" data-companion={o.id} aria-hidden="true">
                        <CompanionPreview companion={o.id} />
                      </span>
                      <span class="comp-name">{o.name}</span>
                      <span class="comp-blurb">{o.blurb}</span>
                    </button>
                  );
                })}
              </div>
              <Field label="GPU rendering" hint="turn off if text looks wrong (applies the next time you open Jaffer)">
                <Switch checked={c.appearance.renderer !== 'dom'} onChange={(v) => set({ appearance: { renderer: v ? 'webgl' : 'dom' } })} />
              </Field>
              <Field label="Global hotkey" hint="summons Jaffer from anywhere">
                <input type="text" value={c.hotkey} onChange={(e) => set({ hotkey: (e.target as HTMLInputElement).value })} />
              </Field>
              <Field label="Keep my Mac awake while Claude works" hint="While Claude or a long command works, your Mac does not go to sleep on its own (the screen still can). A laptop with its lid closed still sleeps unless it is plugged in with an external display and a keyboard or mouse (macOS’s closed-display mode).">
                <Switch checked={c.session?.stayAwake !== false} onChange={(v) => set({ session: { stayAwake: v } })} />
              </Field>
              <Field label="Open at login" hint="so Jaffer is always one keystroke away">
                <Switch
                  checked={openAtLogin}
                  onChange={(v) => {
                    setOpenAtLogin(v);
                    void window.jaffer.setLoginItem(v).catch(() => setOpenAtLogin(!v));
                  }}
                />
              </Field>
              <h4>Window</h4>
              <Field label="When I close the window" hint="the red button and ⌘W. A hidden window keeps the terminal running: the menu bar icon, the hotkey or the Dock bring it back. Ask needs the menu bar icon">
                <select value={c.window?.closeAction ?? 'menubar'} onChange={(e) => set({ window: { closeAction: (e.target as HTMLSelectElement).value } })}>
                  <option value="menubar">Hide to the menu bar</option>
                  <option value="quit">Quit Jaffer</option>
                  <option value="ask">Ask</option>
                </select>
              </Field>
              <Field label="Show Jaffer in the menu bar" hint="an icon that shows what Claude is doing: click it to show or hide the window, right-click it for a menu (hold ⌥ for more)">
                <Switch checked={c.window?.menuBar !== false} onChange={(v) => set({ window: { menuBar: v } })} />
              </Field>
              <Field label="Only in the menu bar (hide the Dock icon)" hint="needs the menu bar icon; quit from its menu">
                <Switch checked={c.window?.menuBarOnly === true && c.window?.menuBar !== false} disabled={c.window?.menuBar === false} onChange={(v) => set({ window: { menuBarOnly: v } })} />
              </Field>
              <Field label="Menu bar text" hint="beside the icon. The costs are estimates and need “Show what each answer cost” (Claude Code)">
                <select value={c.window?.menuBarTitle ?? 'off'} onChange={(e) => set({ window: { menuBarTitle: (e.target as HTMLSelectElement).value } })}>
                  <option value="off">Nothing</option>
                  <option value="cost">This session’s cost</option>
                  <option value="time">Running turn</option>
                  <option value="today">Today’s cost</option>
                </select>
              </Field>
            </>
          )}

          {section === 'terminal' && (
            <>
              <h4>Terminal</h4>
              <p class="lede">What the terminal adds around your commands. Nothing of a command or its output is kept.</p>
              <Field label="Command blocks" hint="a mark beside every command (green when it worked, red when it failed; hover for its times, click to select its output, right-click to copy or save it), ⌘↑ / ⌘↓ between prompts, and the command pinned on top while you read its output">
                <Switch checked={c.terminal?.blocks !== false} onChange={(v) => set({ terminal: { blocks: v } })} />
              </Field>
              <Field label="Ask before pasting several lines" hint="a paste of two or more lines waits for Paste (↵) or Cancel (esc), so a stray newline does not run anything">
                <Switch checked={c.terminal?.pasteGuard !== false} onChange={(v) => set({ terminal: { pasteGuard: v } })} />
              </Field>
              <Field label="Column ruler" hint="a faint line at that column">
                <select value={String(c.terminal?.ruler ?? 0)} onChange={(e) => set({ terminal: { ruler: Number((e.target as HTMLSelectElement).value) } })}>
                  <option value="0">Off</option>
                  <option value="80">80</option>
                  <option value="100">100</option>
                  <option value="120">120</option>
                </select>
              </Field>
              <Field
                label="Open file links in"
                hint={`⌘-click a file path the terminal printed. Empty: it is shown in Finder. Or an editor link with {path}, {line} and {col}; allowed: ${EDITOR_SCHEMES.join(', ')}.${c.terminal?.editorUrl && !editorUrl(c.terminal.editorUrl, '/') ? ' This one is not allowed, so files are shown in Finder.' : ''}`}
              >
                <input type="text" placeholder="vscode://file/{path}:{line}:{col}" value={c.terminal?.editorUrl ?? ''} onChange={(e) => set({ terminal: { editorUrl: (e.target as HTMLInputElement).value.trim() } })} />
              </Field>
              <Field label="Inline images" hint="pictures programs print in the terminal (sixel, iTerm inline images)">
                <Switch checked={c.terminal?.images !== false} onChange={(v) => set({ terminal: { images: v } })} />
              </Field>
              <Field label="Links to local servers" hint="when a running command prints localhost:5173, a chip in the title bar opens it in your browser">
                <Switch checked={c.terminal?.portLinks !== false} onChange={(v) => set({ terminal: { portLinks: v } })} />
              </Field>
            </>
          )}

          {section === 'integrations' && (
            <>
              <h4>Claude Code</h4>
              <p class="lede">Jaffer follows the Claude Code you run in its terminal, through hooks: the companion and the notification show what Claude is doing. Install and sign-in help is right here too; Claude is optional.</p>
              <SignInStep onDone={refresh} />
              <Field buttons label="Claude Code" hint={claude ? (claude.claudeInstalled ? (claude.hooks ? 'hooks on' : 'hooks off') : 'not found on PATH') : '…'}>
                <span class="row">
                  <button class="btn primary" disabled={busy === 'cc' || !claude?.claudeInstalled} onClick={() => void run('cc', () => call('setup.claude.install', {}), 'Claude Code is connected: Jaffer’s hooks are installed.')}>
                    {claude?.hooks ? 'Reinstall' : 'Connect'}
                  </button>
                  {claude?.hooks && (
                    <button class="btn" disabled={busy === 'ccr'} onClick={() => void run('ccr', () => call('setup.claude.remove', {}), 'Disconnected from Claude Code.')}>
                      Disconnect
                    </button>
                  )}
                </span>
              </Field>
              <Field label="Tell me when Claude finishes" hint="a notification when a turn that took half a minute or more ends while Jaffer is in the background">
                <Switch checked={c.notifications?.claudeFinished !== false} onChange={(v) => set({ notifications: { claudeFinished: v } })} />
              </Field>
              <Field label="Show what each answer cost" hint="a small figure in the title bar after every answer: an estimate from token counts at API prices, not a bill">
                <Switch checked={c.claude?.showCost !== false} onChange={(v) => set({ claude: { showCost: v } })} />
              </Field>
              <Field label="Live cost while Claude works" hint="the figure grows while Claude answers (greyed), read from the token counts every 2 seconds">
                <Switch checked={c.claude?.liveCost !== false} disabled={c.claude?.showCost === false} onChange={(v) => set({ claude: { liveCost: v } })} />
              </Field>
              <Field label="Daily budget (USD, 0 = off)" hint="the figure turns yellow at 80 % of today's estimate and red past it; memory only, it starts again at midnight">
                <input type="number" min={0} max={100_000} step={0.5} value={c.claude?.dailyBudgetUsd ?? 0}
                  /* on change and on blur: whether the browser fires `change` for a value that was set from code differs between Chromium versions */
                  onChange={(e) => commitBudget(e.target as HTMLInputElement)} onBlur={(e) => commitBudget(e.target as HTMLInputElement)}
                />
              </Field>
              <Field label="Tool strip" hint="a thin line under the title bar: this turn's tool calls, coloured by kind, red when one failed">
                <Switch checked={c.claude?.toolStrip !== false} onChange={(v) => set({ claude: { toolStrip: v } })} />
              </Field>
              <Field label="Turn summary" hint="when a turn of 10 seconds or more ends: how long it took, what Claude did and the files it edited (click one to show it in Finder)">
                <Switch checked={c.claude?.turnSummary !== false} onChange={(v) => set({ claude: { turnSummary: v } })} />
              </Field>
              <HookHealth />
            </>
          )}

          {section === 'reset' && <ResetSection />}
          {section === 'updates' && <UpdatesSection auto={c.updates?.auto !== false} onAuto={(v) => set({ updates: { auto: v } })} />}
        </div>
      </div>
    </Modal>
  );
}

/** Settings → Claude Code → Hook health: when each of the eleven hook events was last heard since the app started (asked now, and every 10 s while this is open). */
function HookHealth(): VNode {
  const [events, setEvents] = useState<Record<string, number | null> | null>(null);
  useEffect(() => {
    let open = true;
    const load = () =>
      void call<{ events: Record<string, number | null> }>('claude.hooks', {})
        .then((r) => open && setEvents(r.events))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 10_000);
    return () => {
      open = false;
      clearInterval(t);
    };
  }, []);
  const now = Date.now();
  const warning = events && hookHealthWarning(events, now, claudeLive.value.some((s) => s.state === 'working' || s.state === 'needs-you'));
  return (
    <div class="hook-health">
      <span class="field-label">
        Hook health
        <small>when each of Claude Code's hook events was last heard (since Jaffer started)</small>
      </span>
      <ul>
        {Object.entries(events ?? {}).map(([name, at]) => (
          <li key={name} data-seen={at === null ? '0' : '1'}>
            <span>{name}</span>
            <span>{at === null ? 'not seen yet' : `last seen ${fmtAgo(at, now)}`}</span>
          </li>
        ))}
      </ul>
      {warning && <p class="hh-warn">{warning}</p>}
    </div>
  );
}

/** Start from scratch. The app asks again in a dialog of its own (and offers to keep a backup) before it touches anything. */
function ResetSection(): VNode {
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      await window.jaffer.reset();
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h4>Reset</h4>
      <p class="lede">Start from scratch, for a clean install. This ends your terminal session and removes Jaffer's settings and hooks from this Mac. Claude Code itself, its login and your own Claude settings are not touched. Unless you choose to delete it, a backup of ~/.jaffer is kept next to it.</p>
      <Field buttons label="Reset Jaffer" hint="asks first; the app restarts as if it were freshly installed">
        <button class="btn danger" disabled={busy} onClick={() => void reset()}>
          Reset…
        </button>
      </Field>
    </>
  );
}

function updateText(s: UpdateState): string {
  switch (s.status) {
    case 'unavailable':
      return 'Updates are off in this build: only the signed release updates itself.';
    case 'checking':
      return 'Checking…';
    case 'downloading':
      return `Downloading ${s.version ?? 'the update'}…`;
    case 'ready':
      return `${s.version} is ready`;
    case 'uptodate':
      return 'Up to date';
    case 'error':
      return `Could not check: ${s.error ?? 'unknown error'}`;
    default:
      return 'Not checked yet';
  }
}

/** Jaffer asks before it updates (a native dialog); this is where to look, switch the background check off, or ask now. */
function UpdatesSection({ auto, onAuto }: { auto: boolean; onAuto: (v: boolean) => void }): VNode {
  const s = updateState.value;
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      updateState.value = await window.jaffer.updates.check();
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const status = s?.status ?? 'idle';
  return (
    <>
      <h4>Updates</h4>
      <p class="lede">Jaffer looks for new signed releases on GitHub and asks before installing one. Updating restarts Jaffer and ends your terminal session, so it is always your call.</p>
      <Field label="Check automatically" hint="shortly after launch, then every few hours">
        <Switch checked={auto} onChange={onAuto} />
      </Field>
      <div class="upd-line" data-upd-status={status}>
        <span>
          Jaffer {s?.current ?? appVersion.value}
          <small>{updateText(s ?? { status: 'idle', current: appVersion.value, auto })}</small>
        </span>
        {status !== 'unavailable' && (
          <button class={status === 'ready' ? 'btn primary' : 'btn'} disabled={busy || status === 'checking' || status === 'downloading'} onClick={() => void check()}>
            {status === 'ready' ? `Install ${s?.version}` : 'Check now'}
          </button>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ onboarding

/** First thing on a first run: is Claude Code installed and signed in? Nothing is typed into the terminal here. */
function SignInStep({ onDone, onSkip }: { onDone: () => void; onSkip?: () => void }): VNode {
  const [auth, setAuth] = useState<ClaudeAuthState | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const refresh = () => {
    if (inflight.current) return;
    inflight.current = true;
    void call<ClaudeAuthState>('setup.claude.auth', {})
      .then(setAuth)
      .catch(() => undefined)
      .finally(() => (inflight.current = false));
  };
  const running = auth?.loginRunning ?? false;
  const signedIn = auth?.loggedIn ?? false;
  useEffect(() => {
    refresh();
    if (signedIn) return; // signed in: nothing to wait for (each check starts `claude auth status`)
    const t = setInterval(refresh, running ? 1000 : 2500);
    return () => clearInterval(t);
  }, [running, signedIn]);
  useEffect(() => {
    if (!auth?.loggedIn) return;
    const t = setTimeout(onDone, 700); // long enough to see the tick
    return () => clearTimeout(t);
  }, [auth?.loggedIn]);
  const signIn = async (restart = false) => {
    setBusy(true);
    try {
      await call('setup.claude.login', { restart });
      refresh();
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const installState = !auth ? 'wait' : auth.installed ? 'ok' : 'bad';
  const signedState = !auth ? 'wait' : auth.loggedIn ? 'ok' : auth.loginRunning ? 'wait' : auth.installed ? 'bad' : 'idle';
  return (
    <div class="ob-signin">
      <ul class="ob-checks" aria-live="polite">
        <li data-state={installState}>
          <span class="ob-mark" />
          Claude Code is installed
        </li>
        <li data-state={signedState}>
          <span class="ob-mark" />
          Signed in to Claude
        </li>
      </ul>
      {auth && !auth.installed && (
        <div class="ob-install">
          <p>
            Claude Code is not installed yet. Run this in any terminal (Terminal.app works), then come back: Jaffer notices by itself.
          </p>
          <InstallCommand />
          <div class="ob-actions">
            <button class="btn primary big" onClick={refresh}>
              Check again
            </button>
          </div>
        </div>
      )}
      {auth && auth.installed && !auth.loggedIn && (
        <div class="ob-actions">
          <button class="btn primary big" disabled={busy || auth.loginRunning} onClick={() => void signIn()}>
            {auth.loginRunning ? 'Waiting for your browser…' : 'Sign in with Claude'}
          </button>
          {auth.loginRunning && (
            <button class="btn ghost" onClick={() => void signIn(true)}>
              Try again
            </button>
          )}
        </div>
      )}
      {auth?.loginError && <p class="ob-error">{auth.loginError}</p>}
      {!auth?.loggedIn && onSkip && (
        <div class="ob-actions">
          <button class="btn ghost" onClick={onSkip}>
            Use Jaffer as a plain terminal for now
          </button>
        </div>
      )}
      <p class="faint ob-note">
        Sign-in opens your browser. Claude Code needs a Claude Pro, Max, Team or Enterprise plan. Nothing is typed into your terminal during setup.
      </p>
    </div>
  );
}

/** The person said yes to starting Claude Code: wait for the terminal to be there and its prompt to draw, then type `claude` for them. */
async function startClaudeWhenReady(): Promise<void> {
  for (let i = 0; i < 50 && !terminals.get(activePane.value); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400));
  await runClaude();
}

export function Onboarding(): VNode {
  const [stage, setStage] = useState<'signin' | 'choices'>('signin');
  const [plain, setPlain] = useState(false); // chose a terminal without Claude: no Claude choices, nothing installed, nothing typed
  const [claude, setClaude] = useState(true);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      if (plain) {
        // Nothing about Claude is on until the person adds it (Settings → Claude Code offers it): not the hooks
        await patchConfig({ onboarded: true, claude: { skipped: true } });
        overlay.value = null;
        return;
      }
      await patchConfig({ onboarded: true });
      if (claude) await call('setup.claude.install', {}).catch((e) => toast({ kind: 'error', text: e.message })); // the hooks, so the mole and the notification can follow Claude
      overlay.value = null;
      if (start) void startClaudeWhenReady(); // after the hooks are in, so this very session is seen
    } catch (e) {
      toast({ kind: 'error', text: `Could not save your choices: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => undefined} xwide center>
      <div class="onboard" data-step={stage}>
        <div class="hero">
          <div class="logo-mark" aria-hidden="true">
            <span>❯</span>
            <i />
          </div>
          <h2>Welcome to Jaffer</h2>
          {stage === 'signin' ? (
            <p>
              A calm terminal with a companion that shows what <b>Claude Code</b> is doing. Sign in to Claude to connect it, or start with a plain terminal.
            </p>
          ) : (
            <p>
              A calm terminal, with a companion for <b>Claude Code</b>.
            </p>
          )}
        </div>
        {stage === 'signin' ? (
          <SignInStep onDone={() => setStage('choices')} onSkip={() => (setPlain(true), setStage('choices'))} />
        ) : (
          <>
            <div class="features">
              <div class="feature">
                <div class="f-ico">
                  <IconTerminal size={15} />
                </div>
                <b>One calm terminal</b>
                One shell, a thin title bar and the companion. Closing the window hides it to the menu bar (you can change that in Settings); quitting Jaffer ends the shell and anything running in it.
              </div>
              <div class="feature">
                <div class="f-ico">
                  <IconBolt size={15} />
                </div>
                <b>Claude Code, supercharged</b>
                Run <code>claude</code> right here. A little companion shows when it works and when it needs you, and Jaffer tells you when it has finished.
              </div>
            </div>
            <div class="choices">
              {!plain && (
              <>
              <label>
                <Switch checked={claude} onChange={setClaude} />
                <span class="t">
                  <b>Let Jaffer follow Claude Code</b>
                  <small>Adds hooks to Claude Code. They tell Jaffer what it does in this terminal (your prompts, its tool calls and replies) so the mole can react and you get a notification when Claude needs you; they only listen to a Claude Code running in Jaffer's own terminal. More options are in Settings → Claude Code.</small>
                </span>
              </label>
              <label>
                <Switch checked={start} onChange={setStart} />
                <span class="t">
                  <b>Start Claude Code in the terminal now</b>
                  <small>Types claude for you. Claude Code then asks its own questions (trust this folder, allow a tool) right there in the terminal; Jaffer never answers them for you.</small>
                </span>
              </label>
              </>
              )}
              {plain && <p class="faint ob-note">Claude Code is optional. Whenever you want it, add it in Settings → Claude Code.</p>}
            </div>
            <div class="onboard-foot">
              <button class="btn primary big" onClick={() => void go()} disabled={busy}>
                {busy ? 'Setting up…' : 'Get started'}
              </button>
              <span class="faint">Everything here can be changed later in Settings.</span>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

