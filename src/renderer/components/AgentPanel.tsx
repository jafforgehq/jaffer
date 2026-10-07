import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { runClaude } from '../actions';
import { agentEngine, agentStatus, agentUsage, cfg, checkClaudeAuth, claudeAuth, engines, fmtDuration, agentReady, loadThread, overlay, patchConfig, refreshKeyStatus, sendToAgent, setSide, thread, tildePath, toast, turn, type LiveItem } from '../state';
import { Markdown } from './Markdown';
import { IconAgent, IconBolt, IconBranch, IconBrain, IconCheck, IconClock, IconEdit, IconFile, IconSearch, IconShield, IconStop, IconTerminal, IconWand, IconX, IconArrowUp, IconList } from './icons';

export const composerFocus = signal(0);

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

type Kind = 'read' | 'search' | 'write' | 'run' | 'memory';
const KIND: Record<string, Kind> = {
  run_command: 'run',
  read_terminal: 'run',
  terminal_input: 'run',
  read_file: 'read',
  list_dir: 'read',
  search_files: 'search',
  write_file: 'write',
  edit_file: 'write',
  recall: 'memory',
  remember: 'memory',
  forget: 'memory',
  WebFetch: 'search',
  WebSearch: 'search',
};

function toolIcon(name: string): VNode {
  switch (name) {
    case 'run_command':
    case 'read_terminal':
    case 'terminal_input':
      return <IconTerminal size={12} />;
    case 'recall':
    case 'remember':
    case 'forget':
      return <IconBrain size={12} />;
    case 'search_files':
    case 'WebFetch':
    case 'WebSearch':
      return <IconSearch size={12} />;
    case 'list_dir':
      return <IconList size={12} />;
    case 'edit_file':
    case 'write_file':
      return <IconEdit size={12} />;
    default:
      return <IconFile size={12} />;
  }
}

const TOOL_LABEL: Record<string, string> = {
  run_command: 'Run',
  read_terminal: 'Screen',
  terminal_input: 'Type',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  list_dir: 'List',
  search_files: 'Search',
  recall: 'Recall',
  remember: 'Remember',
  forget: 'Forget',
  WebFetch: 'Fetch',
  WebSearch: 'Web',
  Task: 'Task',
  TodoWrite: 'Plan',
};

/** What the agent is about to do, shown before the user decides. */
function ApprovalPreview({ name, input }: { name: string; input: any }): VNode | null {
  const clip = (lines: string[], n = 14) => (lines.length > n ? [...lines.slice(0, n), `… ${lines.length - n} more lines`] : lines);
  if (name === 'edit_file' && input) {
    const del = clip(String(input.old_string ?? '').split('\n'));
    const add = clip(String(input.new_string ?? '').split('\n'));
    return (
      <div class="approval-preview">
        <div class="ap-file">{tildePath(String(input.path ?? ''))}</div>
        <div class="ap-body">
          {del.map((l, i) => (
            <span key={`d${i}`} class="dl del">
              {l || ' '}
            </span>
          ))}
          {add.map((l, i) => (
            <span key={`a${i}`} class="dl add">
              {l || ' '}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (name === 'write_file' && input) {
    const lines = clip(String(input.content ?? '').split('\n'), 12);
    return (
      <div class="approval-preview">
        <div class="ap-file">{tildePath(String(input.path ?? ''))} · new contents</div>
        <div class="ap-body">
          {lines.map((l, i) => (
            <span key={i} class="dl add">
              {l || ' '}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (name === 'run_command' && input) {
    return (
      <div class="approval-preview">
        <div class="ap-body">
          <span class="dl ctx">$ {String(input.command ?? '')}</span>
        </div>
      </div>
    );
  }
  return null;
}

function ToolRow({ item }: { item: Extract<LiveItem, { kind: 'tool' }> }): VNode {
  const [open, setOpen] = useState(false);
  const decide = (decision: 'allow' | 'allow-always' | 'deny') => void call('agent.approve', { callId: item.id, decision });
  const approving = item.state === 'approval';
  const running = item.state === 'running';
  const done = item.state === 'done' || (item.state === undefined && item.output !== undefined);
  return (
    <div class={`tool ${item.isError ? 'err' : ''} ${approving ? 'needs-approval' : ''}`} data-k={KIND[item.name] ?? 'read'}>
      <button class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="tool-ico">{toolIcon(item.name)}</span>
        <span class="tool-name">{TOOL_LABEL[item.name] ?? item.name}</span>
        <span class="tool-sum">{item.summary || (item.input ? JSON.stringify(item.input).slice(0, 80) : '')}</span>
        {item.dur !== undefined && item.dur > 400 && <span class="tool-dur">{fmtDuration(item.dur)}</span>}
        <span class="tool-state">
          {running && <span class="spinner" />}
          {done && (item.isError ? <IconX size={13} /> : <IconCheck size={13} />)}
        </span>
      </button>
      {approving && (
        <div class="approval">
          <div class={`approval-head ${item.risk === 'risky' ? 'risky' : ''}`}>
            <IconShield size={13} /> {item.risk === 'risky' ? 'Risky — needs your approval' : 'Needs your approval'}
          </div>
          <div class="approval-reason">{item.reason}</div>
          <ApprovalPreview name={item.name} input={item.input} />
          <div class="approval-actions">
            <button class="btn primary" onClick={() => decide('allow')} autofocus>
              Allow <kbd>↵</kbd>
            </button>
            <button class="btn" onClick={() => decide('allow-always')} title="Don't ask again for this kind of action">
              Always allow
            </button>
            <button class="btn danger" onClick={() => decide('deny')}>
              Deny
            </button>
          </div>
        </div>
      )}
      {open && item.output !== undefined && <pre class="tool-out">{item.output || '(no output)'}</pre>}
    </div>
  );
}

function Item({ item }: { item: LiveItem }): VNode {
  if (item.kind === 'user') return <div class="msg user">{item.text}</div>;
  if (item.kind === 'assistant') return <div class="msg assistant">{item.text ? <Markdown text={item.text} /> : <span class="spinner" />}</div>;
  if (item.kind === 'summary')
    return (
      <details class="summary">
        <summary>Earlier conversation was compacted into a briefing</summary>
        <Markdown text={item.text} />
      </details>
    );
  return <ToolRow item={item} />;
}

/** Consecutive tool calls read better as one card of steps. */
function Items({ items }: { items: LiveItem[] }): VNode {
  const out: VNode[] = [];
  for (let i = 0; i < items.length; ) {
    const it = items[i]!;
    if (it.kind === 'tool') {
      const group: LiveItem[] = [];
      while (i < items.length && items[i]!.kind === 'tool') group.push(items[i++]!);
      out.push(
        <div class="tool-group" key={`g-${group[0]!.id}`}>
          {group.map((g) => (
            <Item key={g.id} item={g} />
          ))}
        </div>,
      );
    } else {
      out.push(<Item key={it.id} item={it} />);
      i++;
    }
  }
  return <>{out}</>;
}

function ContextMeter(): VNode | null {
  const st = agentStatus.value;
  const limit = cfg.value?.agent.compactAtTokens ?? 140_000;
  if (!st) return null;
  const pct = Math.min(100, Math.round((st.threadTokens / limit) * 100));
  return (
    <div class="meter" title={`Conversation: ~${st.threadTokens.toLocaleString()} tokens. It is compacted automatically near ${limit.toLocaleString()}.`}>
      <div class="meter-bar">
        <div class={`meter-fill ${pct > 85 ? 'hot' : ''}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span>{pct}%</span>
    </div>
  );
}

/** Shown only when neither Claude Code nor an API key is available. */
function SetupBanner(): VNode {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('secrets.setAnthropicKey', { key });
      toast({ kind: 'info', text: r.verified ? 'API key saved to your Keychain.' : `Key saved (${r.note ?? 'could not verify'}).` });
      setKey('');
      await refreshKeyStatus();
      await loadThread();
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="banner">
      <strong>Claude needs a way in.</strong> Install <b>Claude Code</b> and sign in with <code>/login</code>: this panel then works with your own Claude login, no API key needed. Or paste an Anthropic API key (kept in your macOS Keychain).
      <div class="row">
        <input type="password" placeholder="sk-ant-…" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && key && void save()} />
        <button class="btn primary" disabled={!key || busy} onClick={() => void save()}>
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/** Claude Code is installed but its login is gone (expired, signed out): say so and offer the sign-in, right here. */
function SignedOutBanner(): VNode | null {
  const a = claudeAuth.value;
  const [busy, setBusy] = useState(false);
  const running = a?.loginRunning ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void checkClaudeAuth(), 1000); // only while a sign-in is open in the browser
    return () => clearInterval(t);
  }, [running]);
  if (!a || !a.installed || a.loggedIn) return null;
  const signIn = async () => {
    setBusy(true);
    try {
      await window.jaffer.call('setup.claude.login', {});
      await checkClaudeAuth();
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="banner panel-signin" role="alert">
      <strong>Claude is signed out.</strong> Sign in to keep using this panel and Claude Code.
      {a.loginError && <div class="panel-signin-err">{a.loginError}</div>}
      <div class="row">
        <button class="btn primary small" disabled={busy || running} onClick={() => void signIn()}>
          {running ? 'Waiting for your browser…' : 'Sign in with Claude'}
        </button>
      </div>
    </div>
  );
}

const HISTORY_KEY = 'jaffer.prompts';
function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

const SLASH: { cmd: string; hint: string; arg?: boolean }[] = [
  { cmd: '/compact', hint: 'Summarize the conversation to free up context' },
  { cmd: '/remember', hint: 'Save something to memory', arg: true },
  { cmd: '/forget', hint: 'Forget a memory by id', arg: true },
  { cmd: '/model', hint: 'Switch model', arg: true },
  { cmd: '/auto', hint: 'Auto-approve changes (risky actions still ask)' },
  { cmd: '/ask', hint: 'Ask before changing anything' },
  { cmd: '/memory', hint: 'Open the memory panel' },
];

async function runSlash(text: string): Promise<boolean> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'compact': {
      toast({ kind: 'info', text: 'Compacting the conversation…' });
      try {
        const r = await call('agent.compact', {});
        toast({ kind: 'info', text: r.compacted ? 'Conversation compacted.' : agentEngine.value === 'claude-code' ? 'Claude Code compacts its own context automatically.' : 'Nothing to compact yet.' });
        await loadThread();
      } catch (e) {
        toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    case 'memory':
      setSide('memory');
      return true;
    case 'remember':
      if (!arg) return true;
      try {
        await call('memory.remember', { text: arg, cwd: undefined });
      } catch (e) {
        toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      }
      return true;
    case 'forget':
      if (arg) await call('memory.forget', { id: arg });
      return true;
    case 'model':
      if (arg) {
        await patchConfig({ agent: agentEngine.value === 'claude-code' ? { cliModel: arg } : { model: arg } });
        toast({ kind: 'info', text: `Model set to ${arg}.` });
      }
      return true;
    case 'auto':
      await patchConfig({ agent: { approvals: 'auto' } });
      toast({ kind: 'info', text: 'Auto mode: risky actions still ask.' });
      return true;
    case 'ask':
      await patchConfig({ agent: { approvals: 'ask' } });
      toast({ kind: 'info', text: 'Ask mode: changes need your approval.' });
      return true;
    default:
      return false;
  }
}

const SUGGESTIONS: { text: string; icon: VNode }[] = [
  { text: 'What changed in this repo today?', icon: <IconBranch size={14} /> },
  { text: 'Find and fix the failing test', icon: <IconWand size={14} /> },
  { text: 'Summarize what I worked on this week', icon: <IconClock size={14} /> },
];

export function AgentPanel(): VNode {
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [hist, setHist] = useState<{ items: string[]; i: number }>({ items: loadHistory(), i: -1 });
  const [, tick] = useState(0);
  const stick = useRef(true);
  const busy = !!turn.value;
  const items = thread.value;

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, turn.value?.thinking]);

  useEffect(() => {
    input.current?.focus();
  }, [composerFocus.value]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const grow = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(220, el.scrollHeight) + 'px';
  };
  useEffect(grow, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    const items = [t, ...hist.items.filter((x) => x !== t)].slice(0, 50);
    setHist({ items, i: -1 });
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
    } catch {
      /* ignore */
    }
    stick.current = true;
    if (t.startsWith('/') && (await runSlash(t))) return;
    await sendToAgent(t);
  };

  const slash = text.startsWith('/') && !/\s/.test(text) ? SLASH.filter((s) => s.cmd.startsWith(text.toLowerCase())) : [];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab' && slash.length) {
      e.preventDefault();
      setText(slash[0]!.cmd + ' ');
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      void call('agent.cancel', {});
    } else if (e.key === 'ArrowUp' && !text && hist.items.length) {
      e.preventDefault();
      const i = Math.min(hist.items.length - 1, hist.i + 1);
      setHist({ ...hist, i });
      setText(hist.items[i]!);
    } else if (e.key === 'ArrowDown' && hist.i >= 0) {
      e.preventDefault();
      const i = hist.i - 1;
      setHist({ ...hist, i });
      setText(i >= 0 ? hist.items[i]! : '');
    }
  };

  const cost = agentUsage.value?.costUsd ?? 0;
  const t = turn.value;
  const lastIsAssistantStreaming = items.length > 0 && items[items.length - 1]!.kind === 'assistant';
  const auto = cfg.value?.agent.approvals === 'auto';
  const viaCli = agentEngine.value === 'claude-code';
  const model = viaCli ? (cfg.value?.agent.cliModel || 'default model') : (cfg.value?.agent.model ?? '').replace(/^claude-/, '');
  const engineTitle = viaCli ? 'This panel runs on your Claude Code login: no API key, and your plan covers it.' : 'This panel runs on your Anthropic API key.';

  return (
    <div class="agent">
      <div class="panel-head">
        <div class="title">
          <span class="title-ico">
            <IconAgent size={13} />
          </span>
          Claude
          <span class="engine-chip" title={engineTitle}>
            {agentEngine.value === 'claude-code' ? 'Claude Code login' : 'API key'}
          </span>
        </div>
        <div class="grow" />
        <ContextMeter />
        <button class="icon-btn" title="Open the full Claude Code in your terminal (⇧⌘C)" onClick={() => void runClaude()}>
          <IconTerminal size={15} />
        </button>
        <button class="icon-btn" title="Close (⌘J)" onClick={() => setSide(null)}>
          <IconX size={15} />
        </button>
      </div>
      <div class="panel-sub">
        Jaffer’s Claude: it works in your terminal. This chat is separate from the <code>claude</code> you run there.
      </div>
      {busy && <div class="progress-line" />}

      {!agentReady.value && <SetupBanner />}
      <SignedOutBanner />

      <div
        class="thread"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLElement;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {items.length === 0 && !busy && (
          <div class="empty">
            <div class="empty-mark">
              <IconAgent size={22} />
            </div>
            <div class="empty-title">Claude, in your terminal</div>
            <p>One conversation that never resets. It works in your own shell, remembers what it learns, and picks up where you left off, even after you quit the app.{agentEngine.value === 'claude-code' ? ' It runs on your Claude Code login.' : ''}</p>
            <div class="suggests">
              {SUGGESTIONS.map((s) => (
                <button key={s.text} class="suggest" onClick={() => void sendToAgent(s.text)}>
                  {s.icon}
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        )}
        <Items items={items} />
        {t && (
          <div class="working">
            <span class="spinner" />
            <span class="working-label">{t.thinking ? 'Thinking' : lastIsAssistantStreaming ? 'Writing' : 'Working'}…</span>
            <span class="secs">{Math.max(0, Math.round((Date.now() - t.started) / 1000))}s</span>
            {t.thinking && <span class="thinking-peek">{t.thinking.replace(/\s+/g, ' ').slice(-90)}</span>}
          </div>
        )}
      </div>

      <div class="composer">
        {slash.length > 0 && (
          <div class="slash-list">
            {slash.map((s, k) => (
              <button key={s.cmd} class={`slash-item ${k === 0 ? 'sel' : ''}`} onClick={() => (setText(s.cmd + ' '), input.current?.focus())}>
                <code>{s.cmd}</code>
                <span>{s.hint}</span>
              </button>
            ))}
          </div>
        )}
        <div class="composer-box">
          <textarea ref={input} rows={1} placeholder={busy ? 'Working… (esc to stop)' : 'Ask Claude, or tell it what to do…  (type / for commands)'} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey} spellcheck={false} />
          <div class="composer-bar">
            <button class={`pill-btn ${auto ? 'auto' : ''}`} onClick={() => void patchConfig({ agent: { approvals: auto ? 'ask' : 'auto' } })} title="Whether changes need your approval">
              {auto ? <IconBolt size={11} /> : <IconShield size={11} />}
              {auto ? 'auto-approve' : 'asks first'}
            </button>
            <button class="pill-btn" onClick={() => (overlay.value = 'settings')} title={viaCli ? `Runs on your Claude Code login${agentStatus.value?.model ? ` (${agentStatus.value.model})` : ''}. Change in Settings.` : 'Change model in Settings'}>
              {model}
            </button>
            <div class="grow" />
            <button class={`send ${busy ? 'stop' : ''}`} onClick={() => (busy ? void call('agent.cancel', {}) : void submit())} disabled={!busy && !text.trim()} title={busy ? 'Stop (esc)' : 'Send (↵)'}>
              {busy ? <IconStop size={13} /> : <IconArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>
      <div class="composer-foot">
        <span>↵ send · ⇧↵ new line</span>
        <div class="grow" />
        {cost > 0 && !viaCli && <span>${cost.toFixed(cost < 1 ? 3 : 2)} this session</span>}
      </div>
    </div>
  );
}
