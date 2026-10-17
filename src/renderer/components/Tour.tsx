import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { activePane, endTour, openOverlay, openSettings, paneLayout, panelOpen, patchPanel, setupOpen, tourStep } from '../state';
import { TOUR_STEPS } from '../../shared/tour';
import { Settings } from './Overlays';
import { splitTerminal } from './PaneTree';
import { terminals } from './TerminalView';

/** How long a step looks for its element (made visible first) before it is skipped: the tour never blocks. */
const FIND_MS = 1200;
const PAD = 6;
const CARD_W = 320;
/** What the tour opened to show a step (the panel, the Setup section): closed again when the tour ends, so it changes nothing of the window. */
const opened = { panel: false, setup: false };

/** The tour is over (finished or skipped): `tour.done`, what it opened is closed again, and the terminal has the keyboard. */
function finish(): void {
  endTour();
  if (opened.panel && panelOpen()) patchPanel({ open: false });
  if (opened.setup) setupOpen.value = false;
  opened.panel = opened.setup = false;
  requestAnimationFrame(() => terminals.get(activePane.value)?.focus());
}

/**
 * (1.4.0) The tour (overlay `tour`): a dim layer with a spotlight on a real part of the window (its `data-tour` mark) and a card with the
 * step's words, its dots, Back / Next / Skip tour and, where an action exists, a Try it. → and Enter go on, ← goes back, Esc skips; the
 * keyboard stays in the card. A step first shows what it points at (the panel, Setup expanded, Settings on Privacy) and is skipped when
 * its element is still not there. Try it runs only the named UI action (the palette and Settings pause the tour until they close). It
 * types nothing and writes no setting but `tour.done`.
 */
export function Tour(): VNode | null {
  const i = tourStep.value ?? 0;
  const step = TOUR_STEPS[i]!;
  const last = i === TOUR_STEPS.length - 1;
  const [hole, setHole] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const dir = useRef<1 | -1>(1);
  const go = (d: 1 | -1) => {
    dir.current = d;
    const n = i + d;
    if (n >= TOUR_STEPS.length) return finish();
    if (n >= 0) (setHole(null), (tourStep.value = n));
  };

  // what the step points at is shown first
  useLayoutEffect(() => {
    if ((step.needs === 'panel' || step.needs === 'setup') && !panelOpen()) (opened.panel = true), patchPanel({ open: true });
    if (step.needs === 'setup' && !setupOpen.value) (opened.setup = true), (setupOpen.value = true);
  }, [i]);

  // the spotlight follows its element (a resize, a scroll, a split); a step whose element does not come is skipped
  void paneLayout.value;
  useEffect(() => {
    let el: HTMLElement | null = null;
    let raf = 0;
    const t0 = performance.now();
    const measure = () => {
      if (!el?.isConnected) return;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left - PAD);
      const y = Math.max(0, r.top - PAD);
      setHole({ x, y, w: Math.max(0, Math.min(window.innerWidth, r.right + PAD) - x), h: Math.max(0, Math.min(window.innerHeight, r.bottom + PAD) - y) });
    };
    const ro = new ResizeObserver(measure);
    const find = () => {
      el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el && el.getClientRects().length) {
        el.scrollIntoView({ block: 'nearest' });
        ro.observe(el);
        return measure();
      }
      if (performance.now() - t0 > FIND_MS) return i + dir.current < 0 ? go(1) : go(dir.current);
      raf = requestAnimationFrame(find);
    };
    find();
    // (and once an entrance has moved it: the panel slides in, a dialog pops up)
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    document.addEventListener('animationend', measure, true);
    document.addEventListener('transitionend', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.removeEventListener('animationend', measure, true);
      document.removeEventListener('transitionend', measure, true);
    };
  }, [i, paneLayout.value]);

  // the card sits beside the spotlight: below, above, left or right of it, where it fits (else over its bottom), always on screen
  useLayoutEffect(() => {
    const c = card.current;
    if (!c || !hole) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ch = c.offsetHeight;
    const cw = Math.min(CARD_W, vw - 24);
    const centreX = hole.x + hole.w / 2 - cw / 2;
    const centreY = hole.y + hole.h / 2 - ch / 2;
    const at =
      vh - (hole.y + hole.h) >= ch + 24 ? { x: centreX, y: hole.y + hole.h + 12 }
      : hole.y >= ch + 24 ? { x: centreX, y: hole.y - ch - 12 }
      : hole.x >= cw + 24 ? { x: hole.x - cw - 12, y: centreY }
      : vw - (hole.x + hole.w) >= cw + 24 ? { x: hole.x + hole.w + 12, y: centreY }
      : { x: centreX, y: hole.y + hole.h - ch - 24 };
    c.style.left = `${Math.round(Math.max(12, Math.min(at.x, vw - cw - 12)))}px`;
    c.style.top = `${Math.round(Math.max(12, Math.min(at.y, vh - ch - 12)))}px`;
  }, [hole, i]);

  // the keyboard: → / Enter on, ← back, Esc skips, Tab stays in the card
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => {
      const onButton = (e.target as HTMLElement | null)?.closest?.('.lr-card button');
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !onButton && !e.isComposing)) go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Tab') {
        const bs = [...(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
        const k = bs.indexOf(document.activeElement as HTMLElement);
        bs[(k + (e.shiftKey ? -1 : 1) + bs.length) % bs.length]?.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // (focus that lands outside the card, a split's new terminal or Settings' own dialog, comes back to it)
    const trap = (e: FocusEvent) => card.current && !card.current.contains(e.target as Node) && card.current.querySelector<HTMLElement>('.lr-next')?.focus();
    window.addEventListener('keydown', key, true);
    document.addEventListener('focusin', trap, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', trap, true);
    };
  }, [i]);
  // (once the card shows: a hidden one cannot take the keyboard)
  useEffect(() => void (hole && card.current?.querySelector<HTMLElement>('.lr-next')?.focus()), [i, !!hole]);

  const tryIt = () => {
    const run = step.action?.run;
    if (run === 'palette') openOverlay('palette');
    else if (run === 'settings') openSettings('privacy');
    else if (run === 'split-terminal') void splitTerminal().then(() => card.current?.querySelector<HTMLElement>('.lr-next')?.focus());
  };

  return (
    <>
      {step.needs === 'settings' && <Settings at="privacy" />}
      <div class="lr-tour" data-step={step.id} data-found={hole ? '' : undefined} onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
        {hole && <div class="lr-hole" style={{ left: `${hole.x}px`, top: `${hole.y}px`, width: `${hole.w}px`, height: `${hole.h}px` }} />}
        <div ref={card} class="lr-card" role="dialog" aria-modal="true" aria-labelledby="lr-card-title" style={{ width: `${CARD_W}px`, visibility: hole ? undefined : 'hidden' }}>
          <h3 id="lr-card-title">{step.title}</h3>
          <p>{step.text}</p>
          {step.lines && (
            <ul class="lr-lines">
              {step.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          <ol class="lr-dots" aria-label={`Step ${i + 1} of ${TOUR_STEPS.length}`}>
            {TOUR_STEPS.map((s, n) => (
              <li key={s.id} aria-current={n === i ? 'step' : undefined} />
            ))}
          </ol>
          <div class="lr-btns">
            <button class="btn ghost small lr-skip" onClick={finish}>
              Skip tour
            </button>
            <span class="grow" />
            {step.action && (
              <button class="btn small lr-try" onClick={tryIt}>
                {step.action.label}
              </button>
            )}
            <button class="btn small lr-back" disabled={i === 0} onClick={() => go(-1)}>
              Back
            </button>
            <button class="btn primary small lr-next" onClick={() => go(1)}>
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
