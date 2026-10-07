import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { activePane, appVersion, cfg, engines, loadThread, overlay, patchConfig, refreshKeyStatus, sendToAgent, setSide, toast, type ClaudeAuthState } from '../state';
import { actions, type Action } from '../actions';
import { terminals } from './TerminalView';
import { THEMES } from '../themes';
import { IconAgent, IconBrain, IconCommandKey, IconGear, IconLayout, IconPalette, IconPlug, IconSearch, IconShield, IconTerminal, IconWand, IconX, IconBolt, IconClock } from './icons';

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

function Modal({ title, onClose, children, wide, xwide, center }: { title?: string; onClose: () => void; children: preact.ComponentChildren; wide?: boolean; xwide?: boolean; center?: boolean }): VNode {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div class={`scrim ${center ? 'center' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''} ${xwide ? 'xwide' : ''}`} role="dialog" aria-label={title}>
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
  const askRow = q.trim().length > 0;
  const total = results.length + (askRow ? 1 : 0);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.pal-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const close = () => (overlay.value = null);
  const run = (i: number) => {
    close();
    if (i < results.length) void results[i]!.run();
    else if (askRow) {
      setSide('agent');
      void sendToAgent(q.trim());
    }
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
            placeholder="Type a command, or ask Claude anything…"
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
          {askRow && (
            <button class={`pal-row ask ${sel === results.length ? 'sel' : ''}`} onMouseEnter={() => setSel(results.length)} onClick={() => run(results.length)}>
              <span class="pal-ico">
                <IconWand size={13} />
              </span>
              <span class="pal-title">Ask Claude: {q.trim()}</span>
              <kbd>↵</kbd>
            </button>
          )}
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
      <button class="icon-btn" onClick={() => h()?.search.findPrevious(q, opts)} title="Previous (⇧↵)">
        ↑
      </button>
      <button class="icon-btn" onClick={() => h()?.search.findNext(q, opts)} title="Next (↵)">
        ↓
      </button>
      <button class="icon-btn" onClick={close}>
        <IconX size={14} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ settings

function Field({ label, hint, children }: { label: string; hint?: string; children: preact.ComponentChildren }): VNode {
  return (
    <label class="field">
      <span class="field-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span class="field-ctl">{children}</span>
    </label>
  );
}

type Section = 'appearance' | 'agent' | 'memory' | 'integrations';

export function Settings(): VNode {
  const c = cfg.value!;
  const [section, setSection] = useState<Section>('appearance');
  const [claude, setClaude] = useState<{ claudeInstalled: boolean; hooks: boolean; mcp: boolean } | null>(null);
  const [targets, setTargets] = useState<{ target: string; label: string; installed: boolean }[]>([]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const refresh = () => {
    void call('setup.claude.status', {}).then(setClaude).catch(() => undefined);
    void call('setup.targets', {}).then(setTargets).catch(() => undefined);
  };
  useEffect(refresh, []);
  const set = (p: object) => void patchConfig(p);
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
    { id: 'agent', label: 'Claude', icon: <IconAgent size={14} /> },
    { id: 'memory', label: 'Memory', icon: <IconBrain size={14} /> },
    { id: 'integrations', label: 'Claude Code', icon: <IconPlug size={14} /> },
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
                <input type="number" min={8} max={28} value={c.appearance.fontSize} onChange={(e) => set({ appearance: { fontSize: Number((e.target as HTMLInputElement).value) } })} />
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
              <Field label="GPU rendering" hint="turn off if text looks wrong (needs a new pane to apply)">
                <Switch checked={c.appearance.renderer !== 'dom'} onChange={(v) => set({ appearance: { renderer: v ? 'webgl' : 'dom' } })} />
              </Field>
              <Field label="Global hotkey" hint="summons Jaffer from anywhere">
                <input type="text" value={c.hotkey} onChange={(e) => set({ hotkey: (e.target as HTMLInputElement).value })} />
              </Field>
              <Field label="Open at login" hint="so your session is always one keystroke away">
                <Switch checked={false} onChange={(v) => void window.jaffer.setLoginItem(v)} />
              </Field>
            </>
          )}

          {section === 'agent' && (
            <>
              <h4>Claude</h4>
              <p class="lede">The Claude panel works in your own shell and asks before it changes anything.</p>
              <Field label="Runs on" hint={`Claude Code: ${claude?.claudeInstalled ? 'found' : 'not found'} · API key: ${engines.value.api ? 'saved' : 'none'}`}>
                <select value={c.agent.engine} onChange={(e) => set({ agent: { engine: (e.target as HTMLSelectElement).value } })}>
                  <option value="auto">Automatic (API key if there is one, otherwise Claude Code)</option>
                  <option value="claude-code">My Claude Code login (no API key needed)</option>
                  <option value="api">My Anthropic API key</option>
                </select>
              </Field>
              <Field label="Approvals" hint="risky commands always ask">
                <select value={c.agent.approvals} onChange={(e) => set({ agent: { approvals: (e.target as HTMLSelectElement).value } })}>
                  <option value="ask">Ask before changing anything</option>
                  <option value="auto">Auto-approve (risky actions still ask)</option>
                </select>
              </Field>
              <Field label="Run commands" hint="where Claude's commands execute (the Claude Code engine needs “in my terminal”)">
                <select value={c.agent.runIn} onChange={(e) => set({ agent: { runIn: (e.target as HTMLSelectElement).value } })}>
                  <option value="session">In my terminal session (visible, shared state)</option>
                  <option value="subprocess">In an isolated background process</option>
                </select>
              </Field>
              {c.agent.allow.length > 0 && (
                <Field label="Always-allowed" hint={c.agent.allow.join(', ')}>
                  <button class="btn" onClick={() => set({ agent: { allow: [] } })}>
                    Reset
                  </button>
                </Field>
              )}

              <h4>Claude Code login</h4>
              <p class="lede">Uses the account you are signed in with in Claude Code, so your plan covers it. Not signed in yet? Run <code>claude</code> in the terminal and type <code>/login</code>.</p>
              <Field label="Model" hint="what Claude Code should use for this panel">
                <select value={c.agent.cliModel} onChange={(e) => set({ agent: { cliModel: (e.target as HTMLSelectElement).value } })}>
                  <option value="">Claude Code's default</option>
                  {['sonnet', 'opus', 'fable', 'haiku'].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>

              <h4>Anthropic API key</h4>
              <p class="lede">Optional. If you add a key, Automatic mode uses it instead.</p>
              <Field label="API key" hint={engines.value.api ? 'saved in your Keychain' : 'stored in your Keychain'}>
                <span class="row">
                  <input type="password" placeholder={engines.value.api ? '•••••••• (saved)' : 'sk-ant-…'} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
                  <button
                    class="btn"
                    disabled={!key || busy === 'key'}
                    onClick={() =>
                      void run(
                        'key',
                        async () => {
                          await call('secrets.setAnthropicKey', { key });
                          setKey('');
                          await refreshKeyStatus();
                          await loadThread();
                        },
                        'API key saved.',
                      )
                    }
                  >
                    Save
                  </button>
                  {engines.value.api && (
                    <button class="btn danger" onClick={() => void run('keyclear', async () => (await call('secrets.clearAnthropicKey', {}), await refreshKeyStatus(), await loadThread()), 'API key removed.')}>
                      Remove
                    </button>
                  )}
                </span>
              </Field>
              <Field label="Model">
                <select value={c.agent.model} onChange={(e) => set({ agent: { model: (e.target as HTMLSelectElement).value } })}>
                  {['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Effort" hint="how hard it thinks">
                <select value={c.agent.effort} onChange={(e) => set({ agent: { effort: (e.target as HTMLSelectElement).value } })}>
                  {['low', 'medium', 'high', 'xhigh', 'max'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
            </>
          )}

          {section === 'memory' && (
            <>
              <h4>Memory</h4>
              <p class="lede">What Jaffer learns, how, and for how long. Everything stays on this Mac.</p>
              <Field label="Learn from my sessions" hint="commands and agent chats; secrets are redacted first">
                <Switch checked={c.memory.enabled} onChange={(v) => set({ memory: { enabled: v } })} />
              </Field>
              <Field label="Let Claude curate memory" hint="sends redacted summaries to Claude: your API key, or your Claude Code login">
                <Switch checked={c.memory.llm === 'auto'} onChange={(v) => set({ memory: { llm: v ? 'auto' : 'off' } })} />
              </Field>
              <Field label="Keep raw activity for" hint="days; learned memory is kept regardless">
                <input type="number" min={7} max={365} value={c.memory.retentionDays} onChange={(e) => set({ memory: { retentionDays: Number((e.target as HTMLInputElement).value) } })} />
              </Field>
              <div class="settings-foot">
                Session data lives in{' '}
                <button class="linkish" onClick={async () => void window.jaffer.reveal((await window.jaffer.appInfo()).home)}>
                  ~/.jaffer
                </button>
              </div>
            </>
          )}

          {section === 'integrations' && (
            <>
              <h4>Claude Code</h4>
              <p class="lede">Share what Jaffer learns with Claude Code, and learn from it in return.</p>
              <Field label="Claude Code" hint={claude ? (claude.claudeInstalled ? `${claude.mcp ? 'MCP on' : 'MCP off'} · ${claude.hooks ? 'hooks on' : 'hooks off'}` : 'not found on PATH') : '…'}>
                <span class="row">
                  <button class="btn primary" disabled={busy === 'cc' || !claude?.claudeInstalled} onClick={() => void run('cc', () => call('setup.claude.install', {}), 'Claude Code now shares Jaffer’s memory.')}>
                    {claude?.mcp && claude.hooks ? 'Reinstall' : 'Connect'}
                  </button>
                  {(claude?.mcp || claude?.hooks) && (
                    <button class="btn" disabled={busy === 'ccr'} onClick={() => void run('ccr', () => call('setup.claude.remove', {}), 'Disconnected from Claude Code.')}>
                      Disconnect
                    </button>
                  )}
                </span>
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
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ onboarding

const INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';

/** First thing on a first run: is Claude Code installed and signed in? Nothing is typed into the terminal here. */
function SignInStep({ onDone }: { onDone: () => void }): VNode {
  const [auth, setAuth] = useState<ClaudeAuthState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
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
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, running ? 1000 : 2500);
    return () => clearInterval(t);
  }, [running]);
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
  const copy = () => {
    void navigator.clipboard?.writeText(INSTALL_CMD).then(() => setCopied(true)).catch(() => undefined);
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
          <div class="ob-cmdrow">
            <code class="ob-cmd">{INSTALL_CMD}</code>
            <button class="btn small" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
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
      <p class="faint ob-note">
        Sign-in opens your browser. Claude Code needs a Claude Pro, Max, Team or Enterprise plan, or an Anthropic Console account. Nothing is typed into your terminal during setup.
      </p>
    </div>
  );
}

export function Onboarding(): VNode {
  const [stage, setStage] = useState<'signin' | 'choices'>('signin');
  const [learn, setLearn] = useState(true);
  const [curate, setCurate] = useState(true);
  const [claude, setClaude] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await patchConfig({
        onboarded: true,
        memory: { enabled: learn, llm: curate && learn ? 'auto' : 'off' },
        ingest: { claudeCode: claude && learn },
      });
      if (claude) await call('setup.claude.install', {}).catch((e) => toast({ kind: 'error', text: e.message }));
      await refreshKeyStatus();
      overlay.value = null;
      setSide(null); // just the terminal at first; Claude's panel is one click or ⌘J away
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
              A terminal built for <b>Claude Code</b>. First, let’s make sure you are signed in to Claude.
            </p>
          ) : (
            <p>
              A terminal with <b>one session that never ends</b> and a memory that <b>keeps learning from you</b>.
            </p>
          )}
        </div>
        {stage === 'signin' ? (
          <SignInStep onDone={() => setStage('choices')} />
        ) : (
          <>
            <div class="features">
              <div class="feature">
                <div class="f-ico">
                  <IconClock size={15} />
                </div>
                <b>Always the same session</b>
                Quit the app, close the lid, come back tomorrow — your shell, your running processes and your conversation are exactly where you left them.
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
                  <small>Commands and conversations are redacted for secrets and stay on this Mac.</small>
                </span>
              </label>
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
                  <b>Connect Claude Code</b>
                  <small>Adds an MCP server and start-up hooks, and learns from its local transcripts.</small>
                </span>
              </label>
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

void IconGear;
void IconShield;
