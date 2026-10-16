import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { info, setupOpen } from '../state';
import { formatBytes } from '../../shared/history-label';
import type { SetupInfo } from '../../core/claude/setup';
import type { McpCheck, McpStatus } from '../../core/claude/mcp';

/** Only the newest `claude.setup` answer counts (the folder changed while one was read). */
let asked = 0;
/** A group with more items than this shows its count and a Show all button. */
const FOLD = 6;

type Dot = 'ok' | 'attention' | 'unknown' | 'off';
interface Item {
  name: string;
  state: Dot;
  note?: string;
  title?: string;
  tag?: string;
  danger?: boolean;
}

const MCP_DOT: Record<McpStatus, Dot> = { connected: 'ok', 'needs-auth': 'attention', pending: 'attention', failed: 'attention', disabled: 'off', unknown: 'unknown' };
const SKILL_NOTE = { 'name-only': 'name only', 'user-invocable-only': 'only by you' } as const;
const RULE_KIND = { user: 'Your memory (all projects)', project: 'Project memory', local: 'Your local project memory', managed: 'Managed by your organization', rule: 'A rule file' } as const;
const MCP_SAID = {
  'no-claude': 'Claude Code was not found, so the servers were not checked.',
  timeout: 'The check took longer than 25 seconds and was stopped.',
  error: 'The check did not finish; what it saw is shown.',
} as const;

/**
 * (1.4.0) The side panel's third section, collapsed at first: what Claude Code is set up with in the focused terminal's folder (MCP servers,
 * skills, rules and memory, plugins, subagents, hooks), each with a state dot. Read only: nothing here changes a setting. It reads
 * `claude.setup` (files only) when it opens and when the folder changes; the MCP servers are asked (`claude.mcp`, which starts them) only
 * on the Check button, and that answer is kept for this folder only, in memory.
 */
export function Setup(): VNode {
  const open = setupOpen.value;
  const cwd = info.value.cwd;
  const [data, setData] = useState<SetupInfo | null>(null);
  const [mcp, setMcp] = useState<{ cwd: string; busy: boolean; result?: McpCheck } | null>(null);
  const [all, setAll] = useState<Set<string>>(new Set());
  const cwdNow = useRef(cwd);
  cwdNow.current = cwd;

  useEffect(() => {
    if (!open) return;
    const n = ++asked;
    const t = setTimeout(
      () =>
        void window.jaffer.call<SetupInfo>('claude.setup', { cwd }).then(
          (r) => n === asked && setData(r),
          () => n === asked && setData(null),
        ),
      data ? 200 : 0, // (a folder change waits a moment: a cd chain reads once)
    );
    return () => clearTimeout(t);
  }, [open, cwd]);
  useEffect(() => setMcp((m) => (m && m.cwd !== cwd ? null : m)), [cwd]);

  const check = () => {
    if (mcp?.busy) return;
    const at = cwd;
    setMcp({ cwd: at, busy: true });
    void window.jaffer.call<McpCheck>('claude.mcp', { cwd: at }).then(
      (result) => cwdNow.current === at && setMcp({ cwd: at, busy: false, result }),
      () => cwdNow.current === at && setMcp({ cwd: at, busy: false, result: { servers: [], ok: false, reason: 'error' } }),
    );
  };

  const checked = mcp?.cwd === cwd ? mcp.result : undefined;
  const mcpItems: Item[] = (data?.mcpFile ?? []).map((m) => {
    const s = checked?.servers.find((x) => x.name === m.name);
    return s ? { name: m.name, state: MCP_DOT[s.status], note: s.label, danger: s.status === 'failed' } : { name: m.name, state: 'unknown', note: 'not checked', title: 'Listed in .mcp.json; not checked yet' };
  });
  for (const s of checked?.servers ?? []) if (!mcpItems.some((m) => m.name === s.name)) mcpItems.push({ name: s.name, state: MCP_DOT[s.status], note: s.label, danger: s.status === 'failed' });

  const groups: { key: string; title: string; items: Item[] }[] = data
    ? [
        { key: 'mcp', title: 'MCP servers', items: mcpItems },
        {
          key: 'skills',
          title: 'Skills',
          items: data.skills.map((k) => ({
            name: k.name,
            state: k.state === 'on' ? 'ok' : k.state === 'off' ? 'off' : 'unknown',
            note: k.state === 'off' ? 'off' : k.state === 'on' ? undefined : SKILL_NOTE[k.state],
            title: [k.description, k.scope === 'project' ? 'A skill of this project' : 'Your skill'].filter(Boolean).join(' · '),
          })),
        },
        { key: 'rules', title: 'Rules and memory', items: data.rules.map((r) => ({ name: r.path, state: 'ok', note: formatBytes(r.bytes), tag: r.scoped ? 'scoped' : undefined, title: `${r.path} · ${RULE_KIND[r.kind]}${r.scoped ? ' · only for the paths it names' : ''}` })) },
        { key: 'plugins', title: 'Plugins', items: data.plugins.map((p) => ({ name: p.id, state: p.enabled ? 'ok' : 'off', note: p.enabled ? p.version : 'off', title: p.version ? `${p.id} ${p.version}` : p.id })) },
        { key: 'agents', title: 'Subagents', items: data.agents.map((a) => ({ name: a.name, state: 'ok', title: a.scope === 'project' ? 'A subagent of this project' : 'Your subagent' })) },
        { key: 'hooks', title: 'Hooks', items: data.hooks.map((h) => ({ name: h.event, state: 'ok', note: `${h.count}`, title: `${h.count} hook${h.count === 1 ? '' : 's'} on ${h.event}` })) },
      ]
    : [];

  return (
    <section class="sx-setup" aria-label="Setup">
      <button class="sx-head" aria-expanded={open} onClick={() => (setupOpen.value = !open)}>
        Setup
      </button>
      {open && (
        <div class="sx-body" data-loaded={data ? '' : undefined}>
          {!data && <div class="sx-none">Reading…</div>}
          {groups.map((g) => {
            const folded = g.items.length > FOLD && !all.has(g.key);
            return (
              <div key={g.key} class="sx-group" data-group={g.key}>
                <div class="sx-ghead">
                  <span>{g.title}</span>
                  <span class="sx-count">{g.items.length}</span>
                </div>
                {g.items.length === 0 && g.key !== 'mcp' && <div class="sx-none">None here</div>}
                {!folded && g.items.length > 0 && (
                  <ul class="sx-list">
                    {g.items.map((it, i) => (
                      <li key={i} class="sx-item" title={it.title ?? it.name}>
                        <span class="sx-dot" data-state={it.state} data-danger={it.danger ? '' : undefined} />
                        <span class="sx-name">{it.name}</span>
                        {it.tag && <span class="sx-tag">{it.tag}</span>}
                        {it.note && <span class="sx-note">{it.note}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {g.items.length > FOLD && (
                  <button class="sx-more" aria-expanded={!folded} onClick={() => setAll((s) => new Set(folded ? [...s, g.key] : [...s].filter((k) => k !== g.key)))}>
                    {folded ? `Show all ${g.items.length}` : 'Show fewer'}
                  </button>
                )}
                {g.key === 'mcp' && (
                  <div class="sx-mcp">
                    <button class="sx-check" disabled={mcp?.busy} aria-busy={mcp?.busy ? 'true' : undefined} onClick={check}>
                      {mcp?.busy ? 'Checking…' : 'Check MCP servers'}
                    </button>
                    <div class="sx-hint">This starts your MCP servers briefly to see if they answer.</div>
                    {checked && !checked.ok && checked.reason && <div class="sx-said">{MCP_SAID[checked.reason]}</div>}
                    {checked?.ok && checked.servers.length === 0 && <div class="sx-said">Claude Code lists no MCP servers here.</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
