import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { activePane, appVersion, cfg, overlay, patchConfig, setSide, toast, updateState, type ClaudeAuthState } from '../state';
import type { UpdateState } from '../../shared/update-policy';
import { InstallCommand } from './ClaudeInstall';
import { actions, restartClaude, runClaude, type Action } from '../actions';
import { terminals } from './TerminalView';
import { THEMES } from '../themes';
import { COMPANIONS, companionOf } from '../../shared/companions';
import { CompanionPreview } from './Pet';
import { DEFAULT_PROTECTED_BRANCHES } from '../../shared/danger-zone';
import { IconAgent, IconBrain, IconCommandKey, IconGear, IconLayout, IconPalette, IconPlug, IconSearch, IconTerminal, IconX, IconBolt, IconClock, IconDownload, IconReset } from './icons';

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

function Modal({ title, onClose, children, wide, xwide, center }: { title?: string; onClose: () => void; children: preact.ComponentChildren; wide?: boolean; xwide?: boolean; center?: boolean }): VNode {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
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

const SECTION_ORDER = ['View', 'Claude', 'Terminal', 'Memory', 'Integrations', 'Appearance', 'App'];
const SECTION_ICON: Record<string, (p: { size: number }) => VNode> = {
  View: IconLayout,
  Claude: IconAgent,
  Terminal: IconTerminal,
  Memory: IconBrain,
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
  useLayoutEffect(() => input.current?.focus(), []);
  const h = () => terminals.get(activePane.value);
  const close = () => {
    h()?.search.clearDecorations();
    overlay.value = null;
    h()?.focus();
  };
  const opts = { decorations: { matchBackground: '#ffcc0055', matchOverviewRuler: '#ffcc00', activeMatchBackground: '#ff8a4c88', activeMatchColorOverviewRuler: '#ff8a4c' } };
  return (
    <div class="findbar">
      <input
        ref={input}
        placeholder="Find in terminal"
        value={q}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setQ(v);
          h()?.search.findNext(v, { ...opts, incremental: true });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.shiftKey ? h()?.search.findPrevious(q, opts) : h()?.search.findNext(q, opts));
          else if (e.key === 'Escape') close();
        }}
      />
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
  // A <label> forwards a click on its words to its first button, which would press "Add memory tools" or "Reset…" for a stray click.
  return buttons ? <div class="field">{body}</div> : <label class="field">{body}</label>;
}

type Section = 'appearance' | 'memory' | 'integrations' | 'updates' | 'reset';

export function Settings(): VNode {
  const c = cfg.value!;
  const [section, setSection] = useState<Section>('appearance');
  const [claude, setClaude] = useState<{ claudeInstalled: boolean; hooks: boolean; mcp: boolean } | null>(null);
  const [targets, setTargets] = useState<{ target: string; label: string; installed: boolean }[]>([]);
  const [busy, setBusy] = useState('');
  const refresh = () => {
    void call('setup.claude.status', {}).then(setClaude).catch(() => undefined);
    void call('setup.targets', {}).then(setTargets).catch(() => undefined);
  };
  useEffect(refresh, []);
  const set = (p: object) => void patchConfig(p).catch((e) => toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) }));
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
  const toggleTarget = (t: string, on: boolean) => set({ export: { targets: on ? [...new Set([...c.export.targets, t])] : c.export.targets.filter((x) => x !== t) } });

  const nav: { id: Section; label: string; icon: VNode }[] = [
    { id: 'appearance', label: 'Appearance', icon: <IconPalette size={14} /> },
    { id: 'memory', label: 'Memory', icon: <IconBrain size={14} /> },
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
              <Field label="Font size">
                <input type="number" min={8} max={28} value={c.appearance.fontSize} onChange={(e) => set({ appearance: { fontSize: Math.min(28, Math.max(8, Math.round(Number((e.target as HTMLInputElement).value)) || c.appearance.fontSize)) } })} />
              </Field>
              <Field label="Font family">
                <input type="text" value={c.appearance.fontFamily} onChange={(e) => set({ appearance: { fontFamily: (e.target as HTMLInputElement).value } })} />
              </Field>
              <Field label="Window opacity" hint="shows the desktop through the window">
                <input type="range" min={0.6} max={1} step={0.02} value={c.appearance.opacity} onInput={(e) => set({ appearance: { opacity: Number((e.target as HTMLInputElement).value) } })} />
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
              <Field label="Keep the screen for a restart" hint="saves your screen and scrollback so they come back after a reboot or an update; off keeps nothing of the screen on disk (the folder still comes back)">
                <Switch checked={c.session?.restoreScreen !== false} onChange={(v) => set({ session: { restoreScreen: v } })} />
              </Field>
              <Field label="Keep my Mac awake while Claude works" hint="While Claude or a long command works, your Mac does not go to sleep on its own (the screen still can). A laptop with its lid closed still sleeps unless it is plugged in with an external display and a keyboard or mouse (macOS’s closed-display mode).">
                <Switch checked={c.session?.stayAwake !== false} onChange={(v) => set({ session: { stayAwake: v } })} />
              </Field>
              <Field label="Mark risky places" hint="tints the title bar on a protected branch (amber) and while an ssh session runs (red), so a command goes where you meant">
                <Switch checked={c.safety?.dangerTint !== false} onChange={(v) => set({ safety: { dangerTint: v } })} />
              </Field>
              <Field label="Protected branches" hint="comma separated; * matches anything, as in release/*">
                <input
                  type="text"
                  disabled={c.safety?.dangerTint === false}
                  value={(c.safety?.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES).join(', ')}
                  onChange={(e) => set({ safety: { protectedBranches: (e.target as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean) } })}
                />
              </Field>
              <Field label="Open at login" hint="so your session is always one keystroke away">
                <Switch
                  checked={openAtLogin}
                  onChange={(v) => {
                    setOpenAtLogin(v);
                    void window.jaffer.setLoginItem(v).catch(() => setOpenAtLogin(!v));
                  }}
                />
              </Field>
            </>
          )}

          {section === 'memory' && (
            <>
              <h4>Memory</h4>
              <p class="lede">What Jaffer learns, how, and for how long. Everything stays on this Mac.</p>
              <Field label="Learn from my sessions" hint="commands and what you tell Claude Code; secrets are redacted first">
                <Switch checked={c.memory.enabled} onChange={(v) => set({ memory: { enabled: v } })} />
              </Field>
              <Field label="Let Claude curate memory" hint="sends redacted summaries to Claude, through your Claude login">
                <Switch checked={c.memory.llm === 'auto'} onChange={(v) => set({ memory: { llm: v ? 'auto' : 'off' } })} />
              </Field>
              <Field label="Keep raw activity for" hint="days; learned memory is kept regardless">
                <input type="number" min={7} max={365} value={c.memory.retentionDays} onChange={(e) => set({ memory: { retentionDays: Number((e.target as HTMLInputElement).value) } })} />
              </Field>
              <div class="settings-foot">
                Session data lives in{' '}
                <button class="linkish" onClick={() => void window.jaffer.reveal()}>
                  ~/.jaffer
                </button>
              </div>
            </>
          )}

          {section === 'integrations' && (
            <>
              <h4>Claude Code</h4>
              <p class="lede">Jaffer runs on your Claude subscription, through your Claude Code login. Share what Jaffer learns with Claude Code, and learn from it in return. Install and sign-in help is right here too; Claude is optional.</p>
              <SignInStep onDone={refresh} />
              <Field buttons label="Claude Code" hint={claude ? (claude.claudeInstalled ? `${claude.hooks ? 'hooks on' : 'hooks off'} · ${claude.mcp ? 'memory tools (MCP) on' : 'memory tools (MCP) off'}` : 'not found on PATH') : '…'}>
                <span class="row">
                  <button class="btn primary" disabled={busy === 'cc' || !claude?.claudeInstalled} onClick={() => void run('cc', () => call('setup.claude.install', {}), 'Claude Code now shares Jaffer’s memory.')}>
                    {claude?.mcp && claude.hooks ? 'Reinstall' : claude?.hooks ? 'Add memory tools' : 'Connect'}
                  </button>
                  {(claude?.mcp || claude?.hooks) && (
                    <button class="btn" disabled={busy === 'ccr'} onClick={() => void run('ccr', () => call('setup.claude.remove', {}), 'Disconnected from Claude Code.')}>
                      Disconnect
                    </button>
                  )}
                </span>
              </Field>
              <Field label="Tell me when Claude finishes" hint="a notification when a turn that took half a minute or more ends while Jaffer is in the background">
                <Switch checked={c.notifications?.claudeFinished !== false} onChange={(v) => set({ notifications: { claudeFinished: v } })} />
              </Field>
              <Field label="Offer to resume Claude Code" hint="after a restart (a reboot, an update, a crash), a button to take up the Claude Code conversation that was running in this folder; off forgets it">
                <Switch checked={c.session?.resumeClaude !== false} onChange={(v) => set({ session: { resumeClaude: v } })} />
              </Field>
              <Field label="Resume Claude automatically" hint="instead of waiting for a click, types claude --resume for that conversation by itself, after a few seconds’ notice you can cancel; after 3 tries in 10 minutes it stops and leaves the button">
                <Switch disabled={c.session?.resumeClaude === false} checked={c.session?.autoResume !== false && c.session?.resumeClaude !== false} onChange={(v) => set({ session: { autoResume: v } })} />
              </Field>
              <Field buttons label="After a Claude Code update" hint="restarts your shell in the same folder and takes up the same conversation on the new version; asks first">
                <button
                  class="btn"
                  disabled={busy === 'rcc'}
                  onClick={() => {
                    setBusy('rcc');
                    void restartClaude().finally(() => setBusy(''));
                  }}
                >
                  Restart Claude Code
                </button>
              </Field>
              <Field label="Show what each answer cost" hint="a small figure in the title bar after every answer: an estimate from token counts at API prices, not a bill">
                <Switch checked={c.claude?.showCost !== false} onChange={(v) => set({ claude: { showCost: v } })} />
              </Field>
              <Field label="Learn from Claude Code sessions" hint="reads its local transcripts (read-only)">
                <Switch checked={c.ingest.claudeCode} onChange={(v) => set({ ingest: { claudeCode: v } })} />
              </Field>
              {targets.map((t) => (
                <Field key={t.target} label={`Share memory with ${t.label}`} hint={t.installed ? 'adds a managed block to its global instructions file' : 'not installed'}>
                  <Switch disabled={!t.installed} checked={c.export.targets.includes(t.target as never)} onChange={(v) => toggleTarget(t.target, v)} />
                </Field>
              ))}
              <Field label="Publish learned skills to Claude Code" hint="as real Claude Code skills">
                <Switch checked={c.export.claudeSkills} onChange={(v) => set({ export: { claudeSkills: v } })} />
              </Field>
            </>
          )}

          {section === 'reset' && <ResetSection />}
          {section === 'updates' && <UpdatesSection auto={c.updates?.auto !== false} onAuto={(v) => set({ updates: { auto: v } })} />}
        </div>
      </div>
    </Modal>
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
      <p class="lede">Start from scratch, for a clean install. This ends your terminal session and removes Jaffer's memory, settings, hooks and memory tools from this Mac. Claude Code itself, its login and your own Claude settings are not touched. Unless you choose to delete it, a backup of ~/.jaffer is kept next to it.</p>
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
  const [learn, setLearn] = useState(true);
  const [curate, setCurate] = useState(true);
  const [claude, setClaude] = useState(true);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      if (plain) {
        // Nothing about Claude is on until the person adds it (Settings → Claude Code offers it): not the hooks, not the curation of memory by Claude
        await patchConfig({ onboarded: true, memory: { enabled: learn, llm: 'off' }, ingest: { claudeCode: false }, claude: { skipped: true } });
        overlay.value = null;
        setSide(null);
        return;
      }
      await patchConfig({
        onboarded: true,
        memory: { enabled: learn, llm: curate && learn ? 'auto' : 'off' },
        ingest: { claudeCode: claude && learn },
      });
      if (claude) await call('setup.claude.install', { mcp: false }).catch((e) => toast({ kind: 'error', text: e.message })); // the hooks, so the mole and the notification can follow Claude; the memory tools are a Settings choice
      overlay.value = null;
      setSide(null); // just the terminal at first
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
              A terminal with <b>one session that never ends</b>. <b>Claude Code</b> runs best in it: sign in to Claude to connect it, or start with a plain terminal.
            </p>
          ) : (
            <p>
              A terminal with <b>one session that never ends</b> and a memory that <b>keeps learning from you</b>.
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
                  <IconClock size={15} />
                </div>
                <b>Always the same session</b>
                Quit the app, close the lid, come back tomorrow — your shell, your running processes and Claude Code are exactly where you left them.
              </div>
              <div class="feature">
                <div class="f-ico">
                  <IconBrain size={15} />
                </div>
                <b>Memory that evolves</b>
                Jaffer notices your preferences, your projects' conventions and the fixes that worked, and lets stale things fade. See, edit, pin and undo all of it.
              </div>
              <div class="feature">
                <div class="f-ico">
                  <IconBolt size={15} />
                </div>
                <b>Claude Code, supercharged</b>
                Run <code>claude</code> right here. Jaffer feeds it what it has learned and learns from what you do together.
              </div>
            </div>
            <div class="choices">
              <label>
                <Switch checked={learn} onChange={setLearn} />
                <span class="t">
                  <b>Learn from my sessions</b>
                  <small>{plain ? 'Commands are redacted for secrets and stay on this Mac.' : 'Commands and conversations are redacted for secrets and stay on this Mac.'}</small>
                </span>
              </label>
              {plain && <p class="faint ob-note">Claude Code is optional. Whenever you want it, add it in Settings → Claude Code.</p>}
              {!plain && (
              <>
              <label class={learn ? '' : 'off'}>
                <Switch disabled={!learn} checked={curate && learn} onChange={setCurate} />
                <span class="t">
                  <b>Let Claude curate memory</b>
                  <small>Sends redacted summaries of recent activity to Claude (through your Claude login) for smarter notes. Otherwise Jaffer learns offline with simple rules.</small>
                </span>
              </label>
              <label>
                <Switch checked={claude} onChange={setClaude} />
                <span class="t">
                  <b>Let Jaffer follow Claude Code</b>
                  <small>Adds hooks to Claude Code. They tell Jaffer what it does in this terminal (your prompts, its tool calls and replies) so the mole can react and you get a notification when Claude needs you; they only listen to a Claude Code running in Jaffer's own terminal. It also learns from Claude Code's local transcripts. More options are in Settings → Claude Code.</small>
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

