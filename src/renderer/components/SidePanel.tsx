import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cfg, claudeToday, clock, currentClaude, layoutHold, panelOpen, patchPanel, tick } from '../state';
import { COST_ESTIMATE } from '../claude-ui';
import { nowCardModel, panelWidth } from '../panel';

const SLIDE_MS = 180;
const motionOn = () => cfg.value?.appearance?.animations !== false && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const pct = (f: number) => `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;

/** What Claude is doing now: its state, the tool and the turn's time, the cost, today against the budget, its agents, this turn's work. */
export function NowCard(): VNode {
  const s = currentClaude();
  const c = cfg.value?.claude;
  // (the second clock only runs while Claude works; otherwise the slow one keeps the agents' times roughly current)
  const now = s?.state === 'working' ? tick.value : (void clock.value, Date.now());
  const m = nowCardModel(s, { now, cfg: c, today: claudeToday.value, typicalTurnMs: c?.typicalTurnMs ?? 0 });
  return (
    <section class="now-card" data-state={m.state} aria-label="Now">
      <div class="now-head">
        <span class="now-dot" />
        <span class="now-label">{m.label}</span>
        {m.elapsed && <span class="now-elapsed">{m.elapsed}</span>}
      </div>
      {m.tool && <div class="now-tool">{m.tool}</div>}
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

/** Where past conversations go, below the Now card (filled in by the past-conversations section). */
export function ConversationsSlot(): VNode {
  return <section class="sp-convos" data-slot="conversations" />;
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
  }
  const leaving = !open && anim.current === 'out';
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => ((anim.current = null), setDone((n) => n + 1)), SLIDE_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  const [dragW, setDragW] = useState<number | null>(null);
  useEffect(() => () => void (layoutHold.value = false), []);
  if (!open && !leaving) return null;
  const width = dragW ?? panelWidth(cfg.value?.panel?.width);

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const x0 = e.clientX;
    const w0 = width;
    let w = w0;
    layoutHold.value = true;
    const move = (ev: PointerEvent) => setDragW((w = panelWidth(w0 + x0 - ev.clientX)));
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
    patchPanel({ width: panelWidth(width + step) });
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
      />
      <NowCard />
      <ConversationsSlot />
    </aside>
  );
}
