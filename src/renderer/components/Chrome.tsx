import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cfg, claudeToday, currentClaude, daemonUp, dismissToast, info, port, safeCommand, systemStats, tick, tildePath, timesAnswered, toasts, turnHistory } from '../state';
import { processBadge } from '../../shared/process-badge';
import { formatTokens, formatUsd } from '../../shared/claude-cost';
import type { ClaudeSession } from '../../core/claude/watcher';
import { baseName, budgetLevel, fmtDuration, gitText, ordinal, progressFraction, sessionClockText, sparkPath } from '../claude-ui';
import { IconBranch, IconInfo, IconPencil, IconX } from './icons';

function shortPath(p: string): string {
  if (!p) return '';
  const s = tildePath(p);
  const parts = s.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : s;
}

/** The folder's name; when it changes, the old one slides out and the new one in (not with Animations off). */
function FolderLabel({ text }: { text: string }): VNode {
  const prev = useRef(text);
  const [old, setOld] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  useLayoutEffect(() => {
    if (prev.current === text) return;
    const was = prev.current;
    prev.current = text;
    setMoved(true);
    if (cfg.value?.appearance.animations === false) return setOld(null);
    setOld(was);
    const t = setTimeout(() => setOld(null), 220);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span class="cwd-box">
      {old !== null && (
        <span class="cwd-old" aria-hidden="true">
          {old}
        </span>
      )}
      <span class={`cwd${moved ? ' morph' : ''}`} key={text}>
        {text}
      </span>
    </span>
  );
}

/** The ring's tooltip: the session clock and the background agents still running (their ids are opaque: never shown). */
function ringTitle(s: ClaudeSession, now: number, showCost: boolean): string {
  const agents = (Array.isArray(s.subagents) ? s.subagents : []).filter((a) => a.status === 'running');
  return [sessionClockText({ startedAt: s.startedAt, now, turns: s.turns, usd: showCost ? s.cost?.totalUsd : undefined }), ...agents.map((a, n) => `Agent ${n + 1} · ${fmtDuration(now - a.startedAt)}`)].join('\n');
}

/** A small line through the last turns' values. */
function Spark({ values, label }: { values: number[]; label: string }): VNode | null {
  const d = sparkPath(values, 120, 20);
  if (!d) return null;
  return (
    <div class="spark-row">
      <span>{label}</span>
      <svg class="spark" viewBox="0 -2 120 24" width="120" height="24" aria-hidden="true">
        <path d={d} />
      </svg>
    </div>
  );
}

/**
 * What the answer Claude just gave cost (lighting up for a moment on every answer), or, while it works, what it has cost so far
 * (greyed); coloured against the daily budget. Hovering shows the session, today, what the figure is, and the last turns.
 */
function CostChip({ s }: { s: ClaudeSession }): VNode | null {
  const c = cfg.value?.claude;
  const cost = s.cost;
  const live = c?.liveCost !== false && (s.state === 'working' || s.state === 'needs-you') ? s.live : undefined;
  if (!cost && !live) return null;
  const today = claudeToday.value;
  const budget = c?.dailyBudgetUsd ?? 0;
  const level = budgetLevel(today?.usd ?? 0, budget);
  const l = cost?.last;
  const text = live
    ? live.usd !== undefined
      ? `≈ ${formatUsd(live.usd)} so far`
      : `${formatTokens(live.input + live.output)} tokens so far`
    : l!.usd !== undefined
      ? `≈ ${formatUsd(l!.usd)}`
      : `${formatTokens(l!.input + l!.output + l!.cacheRead + l!.cacheWrite)} tokens`;
  const lines = [
    live && `This answer so far ${live.usd !== undefined ? `≈ ${formatUsd(live.usd)}` : '(no price known for this model)'}: ${formatTokens(live.input)} in, ${formatTokens(live.output)} out`,
    l && `This answer ${l.usd !== undefined ? `≈ ${formatUsd(l.usd)}` : '(no price known for this model)'}: ${formatTokens(l.input + l.cacheWrite)} new in, ${formatTokens(l.cacheRead)} cached, ${formatTokens(l.output)} out`,
    cost && `This session ${cost.partial ? 'at least ' : ''}≈ ${formatUsd(cost.totalUsd)} over ${cost.answers} answer${cost.answers === 1 ? '' : 's'}`,
    today && `Today ≈ ${formatUsd(today.usd)}${budget > 0 ? ` of ${formatUsd(budget)}` : ''}`,
    'An estimate at API list prices, from token counts: a subscription is not billed per token.',
  ].filter(Boolean) as string[];
  const hist = turnHistory.value;
  return (
    <span class="cost-wrap">
      <span class={`cost-chip${level === 'warn' || level === 'danger' ? ` ${level}` : ''}`} key={live ? 'live' : cost!.at} data-cost-chip data-live={live ? '' : undefined}>
        {text}
      </span>
      <div class="cost-pop" role="tooltip">
        {lines.map((t) => (
          <div key={t}>{t}</div>
        ))}
        <Spark label={`Last ${hist.length} turns: time`} values={hist.map((h) => h.durMs)} />
        <Spark label="cost" values={hist.map((h) => h.usd ?? 0)} />
      </div>
    </span>
  );
}

const level = (v: number, warn: number, danger: number, low = false) => ((low ? v <= danger : v >= danger) ? 'danger' : (low ? v <= warn : v >= warn) ? 'warn' : 'ok');
/** A battery the page can see (a Mac without one reports a full, charging battery that never runs down). */
type Battery = { level: number; charging: boolean; chargingTime: number; dischargingTime: number; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
const hasBattery = (b: Battery) => !(b.charging && b.level === 1 && b.chargingTime === 0 && b.dischargingTime === Infinity);

/** Settings → Appearance → System stats: CPU, memory and battery as three small bars. */
function SystemStats(): VNode | null {
  const [bat, setBat] = useState<number | null>(null);
  useEffect(() => {
    let b: Battery | null = null;
    const up = () => b && setBat(hasBattery(b) ? b.level : null);
    void (navigator as unknown as { getBattery?: () => Promise<Battery> })
      .getBattery?.()
      .then((x) => {
        b = x;
        up();
        b.addEventListener('levelchange', up);
        b.addEventListener('chargingchange', up);
      })
      .catch(() => undefined);
    return () => {
      b?.removeEventListener('levelchange', up);
      b?.removeEventListener('chargingchange', up);
    };
  }, []);
  const s = systemStats.value;
  if (!s) return null;
  const bars: [string, string, number, string][] = [
    ['cpu', 'CPU', s.cpu, level(s.cpu, 0.7, 0.9)],
    ['mem', 'Memory', s.mem, level(s.mem, 0.8, 0.9)],
  ];
  if (bat !== null) bars.push(['bat', 'Battery', bat, level(bat, 0.2, 0.1, true)]);
  return (
    <span class="sys-stats">
      {bars.map(([id, name, v, lv]) => (
        <span key={id} class="stat-bar" data-stat={id} data-level={lv} title={`${name} ${Math.round(v * 100)}%`}>
          <i style={{ width: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%` }} />
        </span>
      ))}
    </span>
  );
}

export function TitleBar(): VNode {
  const i = info.value;
  const c = cfg.value;
  const running = i.busy ?? null;
  const claude = currentClaude();
  const badge = processBadge(running, claude?.state);
  const showCost = c?.claude?.showCost !== false;
  const isClaude = badge.kind === 'claude' && !!claude;
  const compacting = isClaude && !!claude.compacting;
  const working = isClaude && claude.state === 'working';
  const now = working ? tick.value : Date.now();
  const typical = c?.claude?.typicalTurnMs ?? 0;
  // the ring fills against the typical turn (none known yet: a plain spin); past it, it stays full and pulses
  const frac = working && typical > 0 && typeof claude.turnStartedAt === 'number' ? progressFraction(now - claude.turnStartedAt, typical) : null;
  const git = gitText(i.git);
  const file = typeof claude?.file === 'string' ? claude.file : '';
  const asked = claude?.state === 'needs-you' ? claude.tool?.name : undefined;
  const times = claude && asked ? timesAnswered(claude.id, asked) : 0;
  const notice = claude?.state === 'needs-you' && typeof claude.notice === 'string' ? claude.notice.slice(0, 60) : '';
  return (
    <div class="titlebar">
      <div class="tb-left" />
      <div class="tb-center">
        <span class="session-pill" title={i.cwd}>
          <span class={`live ${daemonUp.value ? '' : 'off'}`} />
          <FolderLabel text={shortPath(i.cwd) || 'Jaffer'} />
          {i.branch && (
            <>
              <span class="sep" />
              <span class="branch">
                <IconBranch size={12} /> {i.branch}
              </span>
              {git && <span class="git-stat">{git}</span>}
            </>
          )}
          {running && (
            <>
              <span class="sep" />
              <span class="running" data-kind={badge.kind} title={isClaude ? ringTitle(claude, now, showCost) : undefined}>
                {badge.spin || compacting ? (
                  <span
                    class="spinner"
                    data-progress={frac !== null ? '' : undefined}
                    data-full={frac === 1 ? '' : undefined}
                    data-compacting={compacting ? '' : undefined}
                    style={frac !== null ? { '--p': frac.toFixed(3) } : undefined}
                  />
                ) : (
                  <span class="run-dot" />
                )}{' '}
                {safeCommand(running).slice(0, 28)}
              </span>
              {port.value && c?.terminal?.portLinks !== false && (
                <button class="port-chip" title={`Open http://localhost:${port.value} in your browser`} onClick={() => void window.jaffer.openExternal(`http://localhost:${port.value}`)}>
                  :{port.value} ↗
                </button>
              )}
            </>
          )}
          {file && (
            <button class="edit-chip" title={`Claude is editing ${tildePath(file)}: click to show it in Finder`} onClick={() => void window.jaffer.revealPath(file).catch(() => undefined)}>
              <IconPencil size={11} />
              {baseName(file)}
            </button>
          )}
          {claude?.state === 'needs-you' && (
            <span class="needs-chip" title="Claude needs you: answer it in the terminal">
              <span class="alert-dot" />
              {[asked, notice, times ? `${ordinal(times + 1)} time` : ''].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
      </div>
      <div class="tb-right">
        {c?.appearance?.systemStats === true && <SystemStats />}
        {claude && showCost && <CostChip s={claude} />}
      </div>
    </div>
  );
}

export function Toasts(): VNode {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <span class="toast-ico">{t.kind === 'error' ? <IconX size={13} /> : <IconInfo size={13} />}</span>
          <span class="toast-text">{t.text}</span>
          <button class="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <IconX size={12} />
          </button>
          {!!t.actions?.length && (
            <span class="toast-acts">
              {t.actions.map((a, n) => (
                <button key={n} class="toast-act" onClick={a.run}>
                  {a.label}
                </button>
              ))}
              {t.note && <span class="toast-note">{t.note}</span>}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function DaemonBanner(): VNode | null {
  if (daemonUp.value) return null;
  return <div class="daemon-banner">The terminal stopped.</div>;
}
