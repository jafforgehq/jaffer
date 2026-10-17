import type { VNode } from 'preact';
import { effect, signal } from '@preact/signals';
import { cfg } from '../state';
import { copyToTerminal } from '../resume';
import type { ExplainReason, ExplainResult } from '../../core/claude/explain';
import { Notes } from './WhatsNew';

/**
 * Explain (1.4.0): only with Settings → Privacy and permissions' `permissions.explain` on, the Now card's *Explain the last answer* asks the
 * daemon (`claude.explain`) for a helper Claude's plain explanation of the latest answer, and this card shows it above Now until Dismiss.
 * The answer is text (rendered by `mini-md` into elements, never HTML), in the window's memory only. *Ask Claude to explain* needs no
 * permission: it only copies a prompt for the person to paste.
 */
type Card = { busy: true } | { text: string } | { error: string };
export const explainCard = signal<Card | null>(null);
/** The ask whose answer counts: Cancel, Dismiss and a newer ask move it on, so a late answer is dropped. */
let seq = 0;

export const ASK_PROMPT = 'Explain what you just did in this session in plain words, for someone new to this: what, why, and what I might do next.';

const WHY: Record<ExplainReason, string> = {
  off: 'Explain is off in Settings → Privacy and permissions.',
  unavailable: 'Explain needs a Claude Code that can answer without tools and without saving the run. Update Claude Code to use it.',
  'no-reply': 'There is no answer to explain yet.',
  timeout: 'Claude took too long to explain. Try again later.',
  error: 'Claude could not explain it this time. Check that you are signed in, then try again.',
  busy: 'Wait a few seconds before asking again.',
};

export async function explainLast(session: string): Promise<void> {
  if (cfg.value?.permissions?.explain !== true) return;
  const mine = ++seq;
  explainCard.value = { busy: true };
  let r: ExplainResult | undefined;
  try {
    r = await window.jaffer.call<ExplainResult>('claude.explain', { session });
  } catch {
    r = undefined;
  }
  if (mine !== seq) return;
  const reason: ExplainReason = r && !r.ok && Object.hasOwn(WHY, r.reason) ? r.reason : 'error'; // (a fixed line per reason, never other text)
  explainCard.value = r?.ok === true && typeof r.text === 'string' ? { text: r.text } : { error: WHY[reason] };
}

export function dismissExplain(): void {
  seq++;
  explainCard.value = null;
}

export const askToExplain = () => copyToTerminal(ASK_PROMPT, 'Copied. Paste it in the terminal.');

/**
 * Can the installed Claude Code run the helper (no tools, no saved session)? Asked (`claude.explain.supported`, the daemon's `claude --help`
 * check) each time the switch goes on, and at the window's start with it on. false: no Explain button, and the Privacy hint says why;
 * null: not known (the probe failed): the button shows and a click tells the truth.
 */
export const explainSupported = signal<boolean | null | undefined>(undefined);
async function probe(): Promise<void> {
  try {
    const r = await window.jaffer.call<{ supported?: unknown }>('claude.explain.supported', {});
    explainSupported.value = typeof r?.supported === 'boolean' ? r.supported : null;
  } catch {
    explainSupported.value = null;
  }
}

// the switch on: ask whether the helper can run; off: the card goes, and an answer still on its way is dropped
let wasOn = false;
effect(() => {
  const on = cfg.value?.permissions?.explain === true;
  if (on && !wasOn) void probe();
  wasOn = on;
  if (!on && explainCard.peek()) dismissExplain();
});

export function Explain(): VNode | null {
  const c = explainCard.value;
  if (!c || cfg.value?.permissions?.explain !== true) return null;
  const busy = 'busy' in c;
  return (
    <section class="ex-card" aria-label="Explanation" aria-busy={busy ? 'true' : undefined}>
      <div class="ex-head">
        <span class="ex-title">Explanation</span>
        {!busy && (
          <button class="btn ghost small ex-dismiss" onClick={dismissExplain}>
            Dismiss
          </button>
        )}
      </div>
      {busy ? (
        <div class="ex-busy">
          <span>Asking Claude…</span>
          <button class="btn small ex-cancel" onClick={dismissExplain}>
            Cancel
          </button>
        </div>
      ) : 'error' in c ? (
        <div class="ex-error">{c.error}</div>
      ) : (
        <div class="ex-scroll">
          <Notes md={c.text} cls="ex-body" />
        </div>
      )}
      <div class="ex-note">
        Uses your Claude subscription.{'text' in c && ' Explained by a separate Claude run; check important details.'}
      </div>
    </section>
  );
}
