import type { VNode } from 'preact';
import { createPortal } from 'preact/compat';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { glossaryEntry } from '../../shared/glossary';
import { openGlossary, overlay } from '../state';
import { IconInfo } from './icons';

/** The popover's width at most, and its gap to the button. */
const POP_W = 260;
const GAP = 6;

/**
 * (1.4.0) A small ⓘ beside a word of the window: a click (or Enter / Space) opens a popover with the glossary entry's short text and
 * "More in the glossary". The popover is drawn at the page's root (no panel clips it, no text is added to the line it explains), follows
 * its button, and closes on Esc (the keyboard goes back to the button), a click outside, or when the keyboard leaves it. Closed, it listens to nothing.
 * `tour` marks it for the tour's last step.
 */
export function InfoButton({ id, tour }: { id: string; tour?: string }): VNode | null {
  const e = glossaryEntry(id);
  const [at, setAt] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const open = at !== null;
  const close = (back = false) => {
    setAt(null);
    if (back) btn.current?.focus();
  };
  /** Below the button, or above it when there is no room below; inside the window. */
  const place = () => {
    const r = btn.current!.getBoundingClientRect();
    const up = r.bottom + 140 > window.innerHeight && r.top > 140;
    return { x: Math.max(8, Math.min(r.left + r.width / 2 - POP_W / 2, window.innerWidth - POP_W - 8)), y: up ? window.innerHeight - r.top + GAP : r.bottom + GAP, up };
  };
  const toggle = () => (open ? close() : setAt(place()));
  // open: the keyboard moves into it (so Tab reaches its link), a click outside closes it, and it follows its button
  useLayoutEffect(() => {
    if (!open) return;
    (pop.current?.querySelector<HTMLElement>('button') ?? pop.current)?.focus();
    const down = (ev: MouseEvent) => !btn.current?.contains(ev.target as Node) && !pop.current?.contains(ev.target as Node) && close();
    const follow = () => btn.current?.isConnected && setAt(place());
    // (only a scroll that moves the button: the terminal scrolls its own output all the time)
    const scroll = (ev: Event) => btn.current && (ev.target as Node).contains?.(btn.current) && follow();
    document.addEventListener('mousedown', down, true);
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  if (!e) return null;
  // the keyboard left both the button and the popover (not a move between them)
  const blur = (ev: FocusEvent) => {
    const to = ev.relatedTarget as Node | null;
    if (!to || (!btn.current?.contains(to) && !pop.current?.contains(to))) close();
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !open) return;
    ev.preventDefault();
    ev.stopPropagation(); // (the panel's own Esc, back to the terminal, is not this one)
    close(true);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        class="lr-info"
        data-id={id}
        data-tour={tour}
        aria-label={`What is ${e.title}?`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(ev) => (ev.stopPropagation(), toggle())}
        onKeyDown={key}
        onFocusOut={blur}
      >
        <IconInfo size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            class="lr-pop"
            role="dialog"
            aria-label={e.title}
            data-id={id}
            tabIndex={-1}
            style={{ left: `${at.x}px`, ...(at.up ? { bottom: `${at.y}px` } : { top: `${at.y}px` }) }}
            onKeyDown={key}
            onFocusOut={blur}
          >
            <b>{e.title}</b>
            <p>{e.short}</p>
            {overlay.value !== 'onboarding' && (
              <button type="button" class="lr-more-link" onClick={() => (close(), openGlossary(id))}>
                More in the glossary
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
