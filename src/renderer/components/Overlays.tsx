import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { activePane, appVersion, cfg, keyReady, overlay, patchConfig, refreshKeyStatus, sendToAgent, setSide, toast } from '../state';
import { actions } from '../actions';
import { terminals } from './TerminalView';
import { THEMES } from '../themes';
import { IconBrain, IconX } from './icons';

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

function Modal({ title, onClose, children, wide }: { title?: string; onClose: () => void; children: preact.ComponentChildren; wide?: boolean }): VNode {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
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

// ------------------------------------------------------------------ palette

export function Palette(): VNode {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.focus(), []); // before paint, so the first keystrokes land here
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const scored = actions
      .map((a) => {
        const hay = `${a.title} ${a.section} ${a.keywords ?? ''}`.toLowerCase();
        if (!t) return { a, s: 1 };
        let s = 0;
        if (hay.includes(t)) s = 10 - Math.min(9, hay.indexOf(t) / 6);
        else if (t.split(/\s+/).every((w) => hay.includes(w))) s = 4;
        return { a, s };
      })
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s);
    return scored.map((x) => x.a);
  }, [q]);
  const askRow = q.trim().length > 0;
  const total = results.length + (askRow ? 1 : 0);
  useEffect(() => setSel(0), [q]);
  const close = () => (overlay.value = null);
  const run = (i: number) => {
    close();
    if (i < results.length) void results[i]!.run();
    else if (askRow) {
      setSide('agent');
      void sendToAgent(q.trim());
    }
  };
  return (
    <Modal onClose={close}>
      <div class="palette">
        <input
          ref={input}
          placeholder="Type a command, or ask the agent anything…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((sel + 1) % Math.max(1, total)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((sel - 1 + total) % Math.max(1, total)));
            else if (e.key === 'Enter') (e.preventDefault(), total && run(sel));
          }}
        />
        <div class="palette-list">
          {results.slice(0, 40).map((a, i) => (
            <button key={a.id} class={`pal-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(i)}>
              <span class="pal-sec">{a.section}</span>
              <span class="pal-title">{a.title}</span>
              {a.keys && <kbd>{a.keys}</kbd>}
            </button>
          ))}
          {askRow && (
            <button class={`pal-row ask ${sel === results.length ? 'sel' : ''}`} onMouseEnter={() => setSel(results.length)} onClick={() => run(results.length)}>
              <span class="pal-sec">Agent</span>
              <span class="pal-title">Ask: {q.trim()}</span>
              <kbd>↵</kbd>
            </button>
          )}
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

export function Settings(): VNode {
  const c = cfg.value!;
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

  return (
    <Modal title="Settings" onClose={() => (overlay.value = null)} wide>
      <div class="settings">
        <section>
          <h4>Appearance</h4>
          <Field label="Theme">
            <select value={c.appearance.theme} onChange={(e) => set({ appearance: { theme: (e.target as HTMLSelectElement).value } })}>
              {THEMES.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Font size">
            <input type="number" min={8} max={28} value={c.appearance.fontSize} onChange={(e) => set({ appearance: { fontSize: Number((e.target as HTMLInputElement).value) } })} />
          </Field>
          <Field label="Font family">
            <input type="text" value={c.appearance.fontFamily} onChange={(e) => set({ appearance: { fontFamily: (e.target as HTMLInputElement).value } })} />
          </Field>
          <Field label="Window opacity" hint="shows the desktop through the terminal">
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
            <input type="checkbox" checked={c.appearance.optionAsMeta} onChange={(e) => set({ appearance: { optionAsMeta: (e.target as HTMLInputElement).checked } })} />
          </Field>
          <Field label="GPU rendering" hint="turn off if text looks wrong (needs a new pane to apply)">
            <input type="checkbox" checked={c.appearance.renderer !== 'dom'} onChange={(e) => set({ appearance: { renderer: (e.target as HTMLInputElement).checked ? 'webgl' : 'dom' } })} />
          </Field>
          <Field label="Global hotkey" hint="summons Jaffer from anywhere">
            <input type="text" value={c.hotkey} onChange={(e) => set({ hotkey: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label="Open at login" hint="so your session is always one keystroke away">
            <input type="checkbox" onChange={(e) => void window.jaffer.setLoginItem((e.target as HTMLInputElement).checked)} />
          </Field>
        </section>

        <section>
          <h4>Agent</h4>
          <Field label="Anthropic API key" hint={keyReady.value ? 'saved in your Keychain' : 'needed for the built-in agent'}>
            <span class="row">
              <input type="password" placeholder={keyReady.value ? '•••••••• (saved)' : 'sk-ant-…'} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
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
                    },
                    'API key saved.',
                  )
                }
              >
                Save
              </button>
              {keyReady.value && (
                <button class="btn danger" onClick={() => void run('keyclear', async () => (await call('secrets.clearAnthropicKey', {}), await refreshKeyStatus()), 'API key removed.')}>
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
          <Field label="Approvals" hint="risky commands always ask">
            <select value={c.agent.approvals} onChange={(e) => set({ agent: { approvals: (e.target as HTMLSelectElement).value } })}>
              <option value="ask">Ask before changing anything</option>
              <option value="auto">Auto-approve (risky actions still ask)</option>
            </select>
          </Field>
          <Field label="Run commands" hint="where the agent's commands execute">
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
        </section>

        <section>
          <h4>Memory</h4>
          <Field label="Learn from my sessions" hint="commands, agent chats; secrets are redacted and everything stays on this Mac">
            <input type="checkbox" checked={c.memory.enabled} onChange={(e) => set({ memory: { enabled: (e.target as HTMLInputElement).checked } })} />
          </Field>
          <Field label="Let Claude curate memory" hint="sends redacted summaries of recent activity to the Anthropic API">
            <input type="checkbox" checked={c.memory.llm === 'auto'} onChange={(e) => set({ memory: { llm: (e.target as HTMLInputElement).checked ? 'auto' : 'off' } })} />
          </Field>
          <Field label="Keep raw activity for" hint="days; learned memory is kept regardless">
            <input type="number" min={7} max={365} value={c.memory.retentionDays} onChange={(e) => set({ memory: { retentionDays: Number((e.target as HTMLInputElement).value) } })} />
          </Field>
        </section>

        <section>
          <h4>Claude Code &amp; other agents</h4>
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
            <input type="checkbox" checked={c.ingest.claudeCode} onChange={(e) => set({ ingest: { claudeCode: (e.target as HTMLInputElement).checked } })} />
          </Field>
          {targets.map((t) => (
            <Field key={t.target} label={`Share memory with ${t.label}`} hint={t.installed ? 'adds a managed block to its global instructions file' : 'not installed'}>
              <input type="checkbox" disabled={!t.installed} checked={c.export.targets.includes(t.target as never)} onChange={(e) => toggleTarget(t.target, (e.target as HTMLInputElement).checked)} />
            </Field>
          ))}
          <Field label="Publish learned skills to Claude Code" hint="as real Claude Code skills">
            <input type="checkbox" checked={c.export.claudeSkills} onChange={(e) => set({ export: { claudeSkills: (e.target as HTMLInputElement).checked } })} />
          </Field>
        </section>
        <div class="settings-foot">
          Jaffer {appVersion.value} · session data in <button class="linkish" onClick={async () => void window.jaffer.reveal((await window.jaffer.appInfo()).home)}>~/.jaffer</button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ onboarding

export function Onboarding(): VNode {
  const [learn, setLearn] = useState(true);
  const [curate, setCurate] = useState(true);
  const [claude, setClaude] = useState(true);
  const [share, setShare] = useState(true);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<{ target: string; label: string; installed: boolean }[]>([]);
  const [claudeFound, setClaudeFound] = useState(true);
  useEffect(() => {
    void call('setup.targets', {}).then(setTargets).catch(() => undefined);
    void call('setup.claude.status', {}).then((s) => (setClaudeFound(s.claudeInstalled), s.claudeInstalled || setClaude(false))).catch(() => undefined);
  }, []);
  const others = targets.filter((t) => t.target !== 'claude-code' && t.installed);
  const go = async () => {
    setBusy(true);
    try {
      if (key.trim()) await call('secrets.setAnthropicKey', { key: key.trim() }).catch((e) => toast({ kind: 'error', text: e.message }));
      await patchConfig({
        onboarded: true,
        memory: { enabled: learn, llm: curate && learn ? 'auto' : 'off' },
        ingest: { claudeCode: claude && learn },
        export: { targets: share ? others.map((t) => t.target) : [] },
      });
      if (claude && claudeFound) await call('setup.claude.install', {}).catch((e) => toast({ kind: 'error', text: e.message }));
      await refreshKeyStatus();
      overlay.value = null;
      setSide('agent');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => undefined} wide>
      <div class="onboard">
        <div class="hero">
          <div class="logo-mark" aria-hidden="true">
            <span>❯</span>
            <i />
          </div>
          <h2>Welcome to Jaffer</h2>
          <p>
            A terminal with <b>one session that never ends</b> and a memory that <b>keeps learning from you</b>.
          </p>
        </div>
        <div class="points">
          <div>
            <b>Always the same session.</b> Quit the app, close the lid, come back tomorrow — your shell, your running processes and your conversation are exactly where you left them.
          </div>
          <div>
            <b>Memory that evolves.</b> Jaffer notices your preferences, your projects' conventions and the fixes that worked, merges what repeats, and lets stale things fade. You can see, edit, pin and undo all of it.
          </div>
          <div>
            <b>Claude Code, supercharged.</b> Run <code>claude</code> right here. Jaffer feeds it what it has learned and learns from what you do together.
          </div>
        </div>
        <div class="choices">
          <label>
            <input type="checkbox" checked={learn} onChange={(e) => setLearn((e.target as HTMLInputElement).checked)} />
            <span>
              <b>Learn from my sessions</b>
              <small>Commands and conversations are redacted for secrets and stay on this Mac.</small>
            </span>
          </label>
          <label class={learn ? '' : 'off'}>
            <input type="checkbox" disabled={!learn} checked={curate && learn} onChange={(e) => setCurate((e.target as HTMLInputElement).checked)} />
            <span>
              <b>Let Claude curate memory</b>
              <small>Sends redacted summaries of recent activity to the Anthropic API for smarter notes. Otherwise Jaffer learns offline with simple rules.</small>
            </span>
          </label>
          <label class={claudeFound ? '' : 'off'}>
            <input type="checkbox" disabled={!claudeFound} checked={claude && claudeFound} onChange={(e) => setClaude((e.target as HTMLInputElement).checked)} />
            <span>
              <b>Connect Claude Code</b>
              <small>{claudeFound ? 'Adds an MCP server and start-up hooks, and learns from its local transcripts.' : 'Claude Code was not found on your PATH — install it, then connect from Settings.'}</small>
            </span>
          </label>
          {others.length > 0 && (
            <label>
              <input type="checkbox" checked={share} onChange={(e) => setShare((e.target as HTMLInputElement).checked)} />
              <span>
                <b>Share memory with {others.map((o) => o.label).join(' & ')}</b>
                <small>Adds a clearly marked block to their global instructions file. Removable any time.</small>
              </span>
            </label>
          )}
        </div>
        <div class="keybox">
          <input type="password" placeholder="Anthropic API key for the built-in agent (optional — stored in your Keychain)" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
        </div>
        <div class="onboard-foot">
          <button class="btn primary big" onClick={() => void go()} disabled={busy}>
            {busy ? 'Setting up…' : 'Get started'}
          </button>
          <span class="faint">Everything here can be changed later in Settings.</span>
        </div>
      </div>
    </Modal>
  );
}

void IconBrain;
