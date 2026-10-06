import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { agentStatus, agentUsage, cfg, keyReady, loadThread, patchConfig, refreshKeyStatus, sendToAgent, setSide, thread, toast, turn, type LiveItem } from '../state';
import { Markdown } from './Markdown';
import { IconBrain, IconCheck, IconChevron, IconFile, IconSearch, IconSend, IconStop, IconTerminal, IconX } from './icons';

export const composerFocus = signal(0);

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

function toolIcon(name: string): VNode {
  if (name === 'run_command' || name === 'read_terminal' || name === 'terminal_input') return <IconTerminal size={14} />;
  if (name === 'recall' || name === 'remember' || name === 'forget') return <IconBrain size={14} />;
  if (name === 'search_files' || name === 'list_dir') return <IconSearch size={14} />;
  return <IconFile size={14} />;
}

const TOOL_LABEL: Record<string, string> = {
  run_command: 'Run',
  read_terminal: 'Read terminal',
  terminal_input: 'Type into terminal',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  list_dir: 'List',
  search_files: 'Search',
  recall: 'Recall',
  remember: 'Remember',
  forget: 'Forget',
};

function ToolRow({ item }: { item: Extract<LiveItem, { kind: 'tool' }> }): VNode {
  const [open, setOpen] = useState(false);
  const decide = (decision: 'allow' | 'allow-always' | 'deny') => void call('agent.approve', { callId: item.id, decision });
  const approving = item.state === 'approval';
  const running = item.state === 'running';
  return (
    <div class={`tool ${item.isError ? 'err' : ''} ${approving ? 'needs-approval' : ''}`}>
      <button class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="tool-ico">{toolIcon(item.name)}</span>
        <span class="tool-name">{TOOL_LABEL[item.name] ?? item.name}</span>
        <span class="tool-sum">{item.summary || (item.input ? JSON.stringify(item.input).slice(0, 80) : '')}</span>
        <span class="tool-state">
          {running && <span class="spinner" />}
          {item.state === 'done' && (item.isError ? <IconX size={13} /> : <IconCheck size={13} />)}
          {item.state === undefined && item.output !== undefined && (item.isError ? <IconX size={13} /> : <IconCheck size={13} />)}
        </span>
      </button>
      {approving && (
        <div class="approval">
          <div class="approval-reason">{item.reason}</div>
          <div class="approval-actions">
            <button class="btn primary" onClick={() => decide('allow')} autofocus>
              Allow
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

function KeyBanner(): VNode {
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
      <strong>Add an Anthropic API key</strong> to talk to the built-in agent. It is stored in your macOS Keychain. Claude Code in the terminal works without it.
      <div class="row">
        <input type="password" placeholder="sk-ant-…" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && key && void save()} />
        <button class="btn primary" disabled={!key || busy} onClick={() => void save()}>
          {busy ? 'Checking…' : 'Save'}
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

async function runSlash(text: string): Promise<boolean> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'compact': {
      toast({ kind: 'info', text: 'Compacting the conversation…' });
      try {
        const r = await call('agent.compact', {});
        toast({ kind: 'info', text: r.compacted ? 'Conversation compacted.' : 'Nothing to compact yet.' });
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
        await patchConfig({ agent: { model: arg } });
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

export function AgentPanel(): VNode {
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [hist, setHist] = useState<{ items: string[]; i: number }>({ items: loadHistory(), i: -1 });
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

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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

  return (
    <div class="agent">
      <div class="panel-head">
        <div class="title">
          <span class="dot ok" /> Agent
        </div>
        <div class="grow" />
        <ContextMeter />
        <button class="icon-btn" title="Close (⌘J)" onClick={() => setSide(null)}>
          <IconX size={15} />
        </button>
      </div>

      {!keyReady.value && <KeyBanner />}

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
            <div class="empty-title">One continuous session</div>
            <p>This conversation never resets. It shares your shell, remembers what it learns, and picks up where you left off — even after you quit the app.</p>
            <div class="chips">
              {['What changed in this repo today?', 'Find and fix the failing test', 'Summarize what I worked on this week'].map((s) => (
                <button key={s} class="chip" onClick={() => void sendToAgent(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it) => (
          <Item key={it.id} item={it} />
        ))}
        {t && (
          <div class="working">
            <span class="spinner" />
            <span class="working-label">{t.thinking ? 'Thinking' : lastIsAssistantStreaming ? 'Writing' : 'Working'}…</span>
            {t.thinking && <span class="thinking-peek">{t.thinking.replace(/\s+/g, ' ').slice(-90)}</span>}
          </div>
        )}
      </div>

      <div class="composer">
        <textarea ref={input} rows={1} placeholder={busy ? 'Working… (esc to stop)' : 'Ask, or tell it what to do…'} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey} spellcheck={false} />
        <button class={`send ${busy ? 'stop' : ''}`} onClick={() => (busy ? void call('agent.cancel', {}) : void submit())} disabled={!busy && !text.trim()} title={busy ? 'Stop (esc)' : 'Send (↵)'}>
          {busy ? <IconStop size={14} /> : <IconSend size={15} />}
        </button>
      </div>
      <div class="composer-foot">
        <span>{cfg.value?.agent.model}</span>
        <span class="sep">·</span>
        <button class="linkish" onClick={() => void patchConfig({ agent: { approvals: cfg.value?.agent.approvals === 'auto' ? 'ask' : 'auto' } })} title="Whether changes need your approval">
          {cfg.value?.agent.approvals === 'auto' ? 'auto-approve' : 'asks first'}
        </button>
        {cost > 0 && (
          <>
            <span class="sep">·</span>
            <span>${cost.toFixed(cost < 1 ? 3 : 2)} this session</span>
          </>
        )}
        <div class="grow" />
        <IconChevron size={12} class="muted-ico" />
      </div>
    </div>
  );
}
