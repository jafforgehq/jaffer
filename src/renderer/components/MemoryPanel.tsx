import { useEffect, useMemo, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { clock, fmtAgo, memItems, memLog, memPulse, memSkills, memStats, refreshMemory, setSide, toast, type MemItemView } from '../state';
import { IconBolt, IconBook, IconBrain, IconCpu, IconFolder, IconInfo, IconLightbulb, IconPin, IconPlay, IconRefresh, IconSliders, IconUndo, IconUser, IconWand, IconX } from './icons';

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);
type Tab = 'learned' | 'skills' | 'activity' | 'notes';

const KIND_LABEL: Record<string, string> = { preference: 'preference', convention: 'convention', fact: 'fact', workflow: 'workflow', lesson: 'lesson', project: 'project', environment: 'machine' };

function kindIcon(kind: string): VNode {
  switch (kind) {
    case 'preference':
      return <IconSliders size={13} />;
    case 'convention':
      return <IconBook size={13} />;
    case 'lesson':
      return <IconLightbulb size={13} />;
    case 'workflow':
      return <IconPlay size={12} />;
    case 'environment':
      return <IconCpu size={13} />;
    case 'project':
      return <IconFolder size={13} />;
    default:
      return <IconInfo size={13} />;
  }
}

function scopeTitle(scope: string): string {
  return scope === 'global' ? 'About you' : `Project · ${scope.slice(8).split('/').filter(Boolean).pop() ?? scope}`;
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
    <div class={`mem ${item.pinned ? 'pinned' : ''}`} data-kind={item.kind}>
      <span class="mem-ico">{kindIcon(item.kind)}</span>
      <div class="mem-main">
        {editing ? (
          <textarea class="mem-edit" value={text} autofocus onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} onBlur={() => void save()} onKeyDown={(e) => (e.key === 'Enter' && !e.shiftKey ? (e.preventDefault(), void save()) : e.key === 'Escape' && setEditing(false))} />
        ) : (
          <div class="mem-text" onDblClick={() => (setText(item.text), setEditing(true))} title="Double-click to edit">
            {item.text}
          </div>
        )}
        <div class="mem-meta">
          <span class="kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
          <span class="conf" title={`confidence ${item.confidence.toFixed(2)} · seen ${item.evidence}× · used ${item.uses}×`}>
            <span class="conf-fill" style={{ width: `${Math.round(item.confidence * 100)}%` }} />
          </span>
          <span>{item.source === 'user' ? 'you' : item.source}</span>
          <span>{fmtAgo(item.lastSeenAt, clock.value)}</span>
        </div>
      </div>
      <div class="mem-actions">
        <button class={`icon-btn sm ${item.pinned ? 'on' : ''}`} title={item.pinned ? 'Unpin' : 'Pin (never fades)'} onClick={() => void call('memory.pin', { id: item.id, pinned: !item.pinned }).then(() => refreshMemory(0))}>
          <IconPin size={13} />
        </button>
        <button class="icon-btn sm" title="Forget" onClick={() => void call('memory.forget', { id: item.id }).then(() => refreshMemory(0))}>
          <IconX size={13} />
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
          <div class="empty-mark is-mem">
            <IconBrain size={22} />
          </div>
          <div class="empty-title">Nothing learned yet</div>
          <p>Jaffer watches your commands, your agent conversations and your Claude Code sessions, and distils what is worth keeping — preferences, project conventions, fixes that worked. It shows up here, and you can pin, edit or forget anything.</p>
        </div>
      )}
      {groups.map(([scope, list]) => (
        <section key={scope}>
          <h4>
            {scope === 'global' ? <IconUser size={12} /> : <IconFolder size={12} />}
            {scopeTitle(scope)}
            <span class="n">{list.length}</span>
          </h4>
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
          <div class="empty-mark is-mem">
            <IconWand size={22} />
          </div>
          <div class="empty-title">No skills yet</div>
          <p>When you repeat a multi-step routine, Jaffer notices and saves it as a skill — and offers it to your agents (including Claude Code) next time.</p>
        </div>
      )}
      {skills.map((s) => (
        <div class="skill" key={s.id}>
          <div class="skill-name">
            <IconBolt size={14} /> {s.name}
          </div>
          <div class="skill-when">{s.whenToUse}</div>
          <ol>
            {s.steps.map((st, i) => (
              <li key={i}>
                <code>{st}</code>
              </li>
            ))}
          </ol>
          <div class="mem-meta">
            <span>seen {s.evidence}×</span>
            <span>used {s.uses}×</span>
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
          <div class="empty-mark is-mem">
            <IconUndo size={22} />
          </div>
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
              <span class="faint">{fmtAgo(r.ts, clock.value)}</span>
              {!isRevert && !reverted.has(r.runId) && (
                <button class="icon-btn sm" title="Undo this change" onClick={() => void call('memory.revert', { runId: r.runId }).then(() => (refreshMemory(0), toast({ kind: 'info', text: 'Change undone.' })))}>
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
      <p class="faint" style={{ margin: '0 0 8px' }}>
        Your own notes for every agent. Jaffer never edits this — it is shared with the built-in agent and exported alongside what it learns.
      </p>
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
          <span class="title-ico is-mem">
            <IconBrain size={13} />
          </span>
          Memory
        </div>
        <div class="grow" />
        <button class="btn small" onClick={() => void reflect()} disabled={busy} title="Review recent activity now">
          <IconRefresh size={12} class={busy ? 'spin' : ''} /> {busy ? 'Learning…' : 'Learn now'}
        </button>
        <button class="icon-btn" title="Close (⇧⌘M)" onClick={() => setSide(null)}>
          <IconX size={15} />
        </button>
      </div>
      <div class="stat-tiles">
        <div class="tile">
          <b>{st?.active ?? 0}</b>
          <span>memories</span>
        </div>
        <div class="tile skills">
          <b>{st?.skills ?? 0}</b>
          <span>skills</span>
        </div>
        <div class="tile events" title="Events that happened since the last reflection">
          <b>{st?.episodesPending ?? 0}</b>
          <span>new events</span>
        </div>
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
