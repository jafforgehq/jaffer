import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { activePane, approvals, cfg, claudeToday, clock, currentClaude, layoutHold, panelOpen, patchPanel, tick, turnHistory, usage5h } from '../state';
import { COST_ESTIMATE } from '../claude-ui';
import { nowCardModel, panelWidth, todayTimeline } from '../panel';
import { Conversations } from './Conversations';
import { WhatsNew } from './WhatsNew';
import { terminals } from './TerminalView';
import { ApprovalAsk } from './Chrome';

const SLIDE_MS = 180;
/** The arrow keys on the edge write `panel.width` (and fit the terminal) once they stop for this long. */
const KEY_SETTLE_MS = 400;
const motionOn = () => cfg.value?.appearance?.animations !== false && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const pct = (f: number) => `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;

/** What Claude is doing now: its state, the tool and the turn's time, the cost, today against the budget, its agents, this turn's work. */
export function NowCard(): VNode {
  const s = currentClaude();
  const c = cfg.value?.claude;
  // (the second clock only runs while Claude works; otherwise the slow one keeps the agents' times roughly current)
  const now = s?.state === 'working' ? tick.value : (void clock.value, Date.now());
  const m = nowCardModel(s, { now, cfg: c, today: claudeToday.value, typicalTurnMs: c?.typicalTurnMs ?? 0, turns: turnHistory.value, usage5h: usage5h.value });
  const timeline = todayTimeline(turnHistory.value, now, c?.showCost !== false);
  const [tlOpen, setTlOpen] = useState(false);
  // a permission prompt waiting for a click (approvals): asked here too, and the terminal has no prompt to answer yet
  const ap = approvals.value[0];
  if (ap) m.hint = undefined;
  return (
    <section class="now-card" data-state={ap ? 'needs-you' : m.state} aria-label="Now">
      <div class="now-head">
        <span class="now-dot" />
        <span class="now-label">{m.label}</span>
        {m.elapsed && <span class="now-elapsed">{m.elapsed}</span>}
      </div>
      {m.tool && <div class="now-tool">{m.tool}</div>}
      {ap && <ApprovalAsk key={ap.id} a={ap} place="card" />}
      {m.hint && <div class="now-hint">{m.hint}</div>}
      {m.progress !== null && (
        <div class="now-progress" title="This turn against a typical one">
          <i style={{ width: pct(m.progress) }} />
        </div>
      )}
      {m.cost && (
        <div class="now-cost" data-live={m.cost.live ? '' : undefined} title={COST_ESTIMATE}>
          {m.cost.text}
        </div>
      )}
      {m.today && (
        <div class="now-today" data-level={m.today.level} title={COST_ESTIMATE}>
          <span>{m.today.text}</span>
          {m.today.fraction !== null && (
            <span class="now-budget">
              <i style={{ width: pct(m.today.fraction) }} />
            </span>
          )}
        </div>
      )}
      {m.context && (
        <div class="now-ctx" data-level={m.context.level} title="An estimate from the token counts of the latest response: how much of the context window it used">
          <span>{m.context.text}</span>
          {m.context.fraction !== null && (
            <span class="now-ctx-bar" role="meter" aria-label="Context used (estimate)" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.context.fraction * 100)}>
              <i style={{ width: pct(m.context.fraction) }} />
            </span>
          )}
        </div>
      )}
      {m.worked && (
        <div class="now-worked" data-level={m.workedLevel}>
          {m.worked}
        </div>
      )}
      {m.last5h && (
        <div class="now-5h" title="An estimate from the token counts in Claude Code's transcripts of the last 5 hours, at API list prices; your plan's limits are counted by Anthropic, not here">
          {m.last5h}
        </div>
      )}
      {m.bars && (
        <svg class="now-turns" viewBox={`0 0 ${m.bars.w} ${m.bars.h}`} width={m.bars.w} height={m.bars.h} role="img" aria-label={m.bars.label}>
          {m.bars.bars.map((b, i) => (
            <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx="1.5" data-level={b.level}>
              <title>{b.title}</title>
            </rect>
          ))}
        </svg>
      )}
      {timeline.length > 0 && (
        <div class="now-tl">
          <button class="now-tl-toggle" aria-expanded={tlOpen} onClick={() => setTlOpen(!tlOpen)}>
            Today ({timeline.length})
          </button>
          {tlOpen && (
            <ol class="now-tl-list">
              {timeline.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      {m.agents.length > 0 && (
        <ul class="now-agents">
          {m.agents.map((a, n) => (
            <li key={n}>{a}</li>
          ))}
        </ul>
      )}
      {m.counts && <div class="now-counts">{m.counts}</div>}
      {m.summary && <div class="now-summary">{m.summary}</div>}
      {m.files.length > 0 && (
        <div class="now-files">
          {m.files.map((f) => (
            <button key={f.path} title={`Show ${f.name} in Finder`} onClick={() => void window.jaffer.revealPath(f.path).catch(() => undefined)}>
              {f.name}
            </button>
          ))}
          {m.moreFiles > 0 && <span class="now-more">+{m.moreFiles} more</span>}
        </div>
      )}
    </section>
  );
}

/**
 * The side panel (⌘B): a column at the right of the terminal card. Closed, nothing of it renders. It slides in and out (not with motion
 * off); its layout width changes at once, so the terminal fits once. Its left edge is a handle: while it is dragged the terminal keeps its
 * size (`layoutHold`), and fits once when it is let go.
 */
export function SidePanel(): VNode | null {
  const open = panelOpen();
  const was = useRef(open);
  const anim = useRef<'in' | 'out' | null>(null);
  const [, setDone] = useState(0);
  if (was.current !== open) {
    was.current = open;
    anim.current = motionOn() ? (open ? 'in' : 'out') : null;
    // closed while it has the keyboard: the terminal takes it (read now: without the slide, the panel is gone before any effect runs)
    if (!open && document.activeElement?.closest('.side-panel')) queueMicrotask(() => terminals.get(activePane.value)?.focus());
  }
  const leaving = !open && anim.current === 'out';
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => ((anim.current = null), setDone((n) => n + 1)), SLIDE_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  const [dragW, setDragW] = useState<number | null>(null);
  // the window's width: the panel gives way in a narrow window, so the terminal keeps 360 px of it (the kept width stays as it is)
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // the arrow keys: the width shows at once and the terminal waits; one write and one fit once they stop (or the edge loses the keyboard)
  const keyed = useRef<{ w: number; t: ReturnType<typeof setTimeout> } | null>(null);
  const settleKeys = () => {
    const k = keyed.current;
    if (!k) return;
    keyed.current = null;
    clearTimeout(k.t);
    patchPanel({ width: k.w });
    setDragW(null);
    layoutHold.value = false;
  };
  useEffect(() => () => (settleKeys(), void (layoutHold.value = false)), []);
  if (!open && !leaving) return null;
  const width = dragW ?? panelWidth(cfg.value?.panel?.width, winW);

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const x0 = e.clientX;
    const w0 = width;
    let w = w0;
    layoutHold.value = true;
    const move = (ev: PointerEvent) => setDragW((w = panelWidth(w0 + x0 - ev.clientX, winW)));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (w !== w0) patchPanel({ width: w });
      setDragW(null);
      layoutHold.value = false;
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0;
    if (!step) return;
    e.preventDefault();
    const w = panelWidth(width + step, winW);
    if (keyed.current) clearTimeout(keyed.current.t);
    keyed.current = { w, t: setTimeout(settleKeys, KEY_SETTLE_MS) };
    layoutHold.value = true;
    setDragW(w);
  };

  return (
    <aside class="side-panel" style={{ width: `${width}px` }} data-anim={anim.current ?? undefined} aria-label="Side panel">
      <div
        class="sp-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Side panel width"
        aria-valuemin={220}
        aria-valuemax={480}
        aria-valuenow={width}
        tabIndex={0}
        data-drag={dragW !== null ? '' : undefined}
        onPointerDown={onDown}
        onKeyDown={onKey}
        onBlur={settleKeys}
      />
      <WhatsNew />
      <NowCard />
      <Conversations />
    </aside>
  );
}
