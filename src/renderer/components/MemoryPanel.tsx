import { useEffect, useMemo, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { memItems, memLog, memPulse, memSkills, memStats, refreshMemory, setSide, toast, type MemItemView } from '../state';
import { IconBrain, IconPin, IconRefresh, IconUndo, IconX } from './icons';

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);
type Tab = 'learned' | 'skills' | 'activity' | 'notes';

const KIND_LABEL: Record<string, string> = { preference: 'preference', convention: 'convention', fact: 'fact', workflow: 'workflow', lesson: 'lesson', project: 'project', environment: 'machine' };

function scopeTitle(scope: string): string {
  return scope === 'global' ? 'About you' : `Project · ${scope.slice(8).split('/').filter(Boolean).pop() ?? scope}`;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function ItemRow({ item }: { item: MemItemView }): VNode {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const save = async () => {
    setEditing(false);
    if (text.trim() && text !== item.text) {
      try {
        await call('memory.update', { id: item.id, text });
      } catch (e) {
        toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      }
      refreshMemory(0);
    }
  };
  return (
    <div class={`mem ${item.pinned ? 'pinned' : ''}`}>
      <div class="mem-main">
        {editing ? (
          <textarea class="mem-edit" value={text} autofocus onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} onBlur={() => void save()} onKeyDown={(e) => (e.key === 'Enter' && !e.shiftKey ? (e.preventDefault(), void save()) : e.key === 'Escape' && setEditing(false))} />
        ) : (
          <div class="mem-text" onDblClick={() => (setText(item.text), setEditing(true))} title="Double-click to edit">
            {item.text}
          </div>
        )}
        <div class="mem-meta">
          <span class={`kind k-${item.kind}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
          <span class="conf" title={`confidence ${item.confidence.toFixed(2)} · seen ${item.evidence}× · used ${item.uses}×`}>
            <span class="conf-fill" style={{ width: `${Math.round(item.confidence * 100)}%` }} />
          </span>
          <span class="faint">{item.source === 'user' ? 'you' : item.source}</span>
          <span class="faint">{ago(item.lastSeenAt)}</span>
        </div>
      </div>
      <div class="mem-actions">
        <button class={`icon-btn ${item.pinned ? 'on' : ''}`} title={item.pinned ? 'Unpin' : 'Pin (never fades)'} onClick={() => void call('memory.pin', { id: item.id, pinned: !item.pinned }).then(() => refreshMemory(0))}>
          <IconPin size={14} />
        </button>
        <button class="icon-btn" title="Forget" onClick={() => void call('memory.forget', { id: item.id }).then(() => refreshMemory(0))}>
          <IconX size={14} />
        </button>
      </div>
    </div>
  );
}

function Learned(): VNode {
  const [q, setQ] = useState('');
  const items = memItems.value;
  const groups = useMemo(() => {
    const filtered = items.filter((i) => !q || i.text.toLowerCase().includes(q.toLowerCase()) || i.kind.includes(q.toLowerCase()));
    const m = new Map<string, MemItemView[]>();
    for (const i of filtered.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.confidence - a.confidence)) m.set(i.scope, [...(m.get(i.scope) ?? []), i]);
    return [...m.entries()].sort(([a], [b]) => (a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b)));
  }, [items, q]);
  return (
    <div class="mem-list">
      <input class="search" placeholder="Filter memories…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {groups.length === 0 && (
        <div class="empty">
          <div class="empty-title">Nothing learned yet</div>
          <p>Jaffer watches your commands, your agent conversations and your Claude Code sessions, and distils what is worth keeping — preferences, project conventions, fixes that worked. It shows up here, and you can pin, edit or forget anything.</p>
        </div>
      )}
      {groups.map(([scope, list]) => (
        <section key={scope}>
          <h4>{scopeTitle(scope)}</h4>
          {list.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Skills(): VNode {
  const skills = memSkills.value;
  return (
    <div class="mem-list">
      {skills.length === 0 && (
        <div class="empty">
          <div class="empty-title">No skills yet</div>
          <p>When you repeat a multi-step routine, Jaffer notices and saves it as a skill — and offers it to your agents (including Claude Code) next time.</p>
        </div>
      )}
      {skills.map((s) => (
        <div class="skill" key={s.id}>
          <div class="skill-name">{s.name}</div>
          <div class="skill-when">{s.whenToUse}</div>
          <ol>
            {s.steps.map((st, i) => (
              <li key={i}>
                <code>{st}</code>
              </li>
            ))}
          </ol>
          <div class="mem-meta">
            <span class="faint">seen {s.evidence}×</span>
            <span class="faint">used {s.uses}×</span>
            <div class="grow" />
            <button class="linkish" onClick={() => void call('memory.recall', { query: s.name }).then(() => refreshMemory(0))}>
              {' '}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Activity(): VNode {
  const runs = memLog.value.filter((r) => r.source !== 'user' || r.reason !== 'pin');
  const reverted = new Set(memLog.value.map((r) => /^revert of (run_\w+)/.exec(r.reason ?? '')?.[1]).filter(Boolean) as string[]);
  return (
    <div class="mem-list">
      {runs.length === 0 && (
        <div class="empty">
          <div class="empty-title">No activity yet</div>
          <p>Every change to memory is logged here so you can see how it evolves — and undo any of it.</p>
        </div>
      )}
      {runs.map((r) => {
        const isRevert = (r.reason ?? '').startsWith('revert of');
        return (
          <div class="run" key={r.runId}>
            <div class="run-head">
              {(r.sources?.length ? r.sources : [r.source]).map((src) => (
                <span key={src} class={`src s-${src}`}>
                  {src}
                </span>
              ))}
              <span class="faint">{r.reason ?? ''}</span>
              <div class="grow" />
              <span class="faint">{ago(r.ts)}</span>
              {!isRevert && !reverted.has(r.runId) && (
                <button class="icon-btn" title="Undo this change" onClick={() => void call('memory.revert', { runId: r.runId }).then(() => (refreshMemory(0), toast({ kind: 'info', text: 'Change undone.' })))}>
                  <IconUndo size={13} />
                </button>
              )}
              {reverted.has(r.runId) && <span class="faint">undone</span>}
            </div>
            {r.ops.slice(0, 5).map((o, i) => (
              <div class="op" key={i}>
                <span class={`opname op-${o.op}`}>{o.op}</span>
                <span>{o.text ?? o.id}</span>
              </div>
            ))}
            {r.ops.length > 5 && <div class="faint">+{r.ops.length - 5} more</div>}
          </div>
        );
      })}
    </div>
  );
}

function Notes(): VNode {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void call('memory.notes.get', {}).then((r) => (setText(r.text), setLoaded(true)));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => void call('memory.notes.set', { text }), 500);
    return () => clearTimeout(t);
  }, [text, loaded]);
  return (
    <div class="mem-list notes">
      <p class="faint">Your own notes for every agent. Jaffer never edits this — it is shared with the built-in agent and exported alongside what it learns.</p>
      <textarea value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder={'e.g. My staging server is called atlas.\nI review PRs on Fridays.'} spellcheck={false} />
    </div>
  );
}

export function MemoryPanel(): VNode {
  const [tab, setTab] = useState<Tab>('learned');
  const [busy, setBusy] = useState(false);
  const st = memStats.value;
  void memPulse.value;
  const reflect = async () => {
    setBusy(true);
    try {
      const r = await call('memory.reflect', { force: true });
      toast({ kind: 'learn', text: r.summary }, 5000);
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      refreshMemory(0);
    }
  };
  return (
    <div class="memory">
      <div class="panel-head">
        <div class="title">
          <IconBrain size={15} /> Memory
        </div>
        <div class="grow" />
        <button class="btn small" onClick={() => void reflect()} disabled={busy} title="Review recent activity now">
          <IconRefresh size={13} class={busy ? 'spin' : ''} /> {busy ? 'Learning…' : 'Learn now'}
        </button>
        <button class="icon-btn" title="Close (⇧⌘M)" onClick={() => setSide(null)}>
          <IconX size={15} />
        </button>
      </div>
      <div class="stats">
        <span>
          <b>{st?.active ?? 0}</b> memories
        </span>
        <span>
          <b>{st?.skills ?? 0}</b> skills
        </span>
        <span title="Events that happened since the last reflection">
          <b>{st?.episodesPending ?? 0}</b> new events
        </span>
      </div>
      <div class="tabs">
        {(['learned', 'skills', 'activity', 'notes'] as Tab[]).map((t) => (
          <button key={t} class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'learned' && <Learned />}
      {tab === 'skills' && <Skills />}
      {tab === 'activity' && <Activity />}
      {tab === 'notes' && <Notes />}
    </div>
  );
}
