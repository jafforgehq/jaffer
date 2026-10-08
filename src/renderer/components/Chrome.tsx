import type { VNode } from 'preact';
import { cfg, currentClaude, resumeOffer, daemonUp, dismissToast, info, memPulse, safeCommand, side, tildePath, toasts, toggleSide } from '../state';
import { processBadge } from '../../shared/process-badge';
import { formatTokens, formatUsd } from '../../shared/claude-cost';
import { dangerZone, DEFAULT_PROTECTED_BRANCHES } from '../../shared/danger-zone';
import type { ClaudeCost } from '../../core/claude/watcher';
import { IconBrain, IconBranch, IconInfo, IconPlay, IconX } from './icons';
import { dismissResume, resumeClaude } from '../actions';

function shortPath(p: string): string {
  if (!p) return '';
  const s = tildePath(p);
  const parts = s.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : s;
}

/** What the answer Claude just gave cost, and the session so far: a quiet figure that lights up for a moment on every answer. */
function CostChip({ cost }: { cost: ClaudeCost }): VNode {
  const l = cost.last;
  const text = l.usd !== undefined ? `≈ ${formatUsd(l.usd)}` : `${formatTokens(l.input + l.output + l.cacheRead + l.cacheWrite)} tokens`;
  const tip = [
    `This answer ${l.usd !== undefined ? `≈ ${formatUsd(l.usd)}` : '(no price known for this model)'}: ${formatTokens(l.input + l.cacheWrite)} new in, ${formatTokens(l.cacheRead)} cached, ${formatTokens(l.output)} out`,
    `This session ${cost.partial ? 'at least ' : ''}≈ ${formatUsd(cost.totalUsd)} over ${cost.answers} answer${cost.answers === 1 ? '' : 's'}`,
    'An estimate from token counts at API list prices. With a Claude subscription you are not billed per token.',
  ].join('\n');
  return (
    <span class="cost-chip" key={cost.at} title={tip} data-cost-chip>
      {text}
    </span>
  );
}

export function TitleBar(): VNode {
  const i = info.value;
  const running = i.busy ?? null;
  const claude = currentClaude();
  const badge = processBadge(running, claude?.state);
  const cost = cfg.value?.claude?.showCost === false ? undefined : claude?.cost;
  // a quiet tint where a slip costs more: a protected branch, or the wrong machine over ssh
  const safety = cfg.value?.safety;
  const danger = safety?.dangerTint === false ? null : dangerZone({ branch: i.branch, running, patterns: safety?.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES });
  const why = danger ? (danger.kind === 'ssh' ? `Connected over ssh to ${danger.what}: commands run there` : `On the protected branch ${danger.what}`) : undefined;
  return (
    <div class="titlebar" data-danger={danger?.kind} data-danger-what={danger?.what}>
      <div class="tb-left" />
      <div class="tb-center">
        <span class="session-pill" title={why ? `${why}\n${i.cwd}` : i.cwd} aria-label={why}>
          <span class={`live ${daemonUp.value ? '' : 'off'}`} />
          <span class="cwd">{shortPath(i.cwd) || 'Jaffer'}</span>
          {i.branch && (
            <>
              <span class="sep" />
              <span class="branch">
                <IconBranch size={12} /> {i.branch}
              </span>
            </>
          )}
          {running && (
            <>
              <span class="sep" />
              <span class="running" data-kind={badge.kind}>
                <span class={badge.spin ? 'spinner' : 'run-dot'} /> {safeCommand(running).slice(0, 28)}
              </span>
            </>
          )}
        </span>
      </div>
      <div class="tb-right">
        {resumeOffer.value && !running && (
          <span class="resume" data-resume={resumeOffer.value.id}>
            <button class="resume-go" onClick={resumeClaude} aria-label="Resume Claude Code" title={`Claude Code was running in ${tildePath(resumeOffer.value.cwd)} when Jaffer stopped.\nResume that conversation (claude --resume).`}>
              <IconPlay size={11} /> <span class="resume-label">Resume Claude</span>
            </button>
            <button class="resume-x" onClick={dismissResume} aria-label="Not now" title="Not now: forget it">
              <IconX size={10} />
            </button>
          </span>
        )}
        {cost && <CostChip cost={cost} />}
        <div class="seg">
          <button class={`seg-btn seg-mem ${side.value === 'memory' ? 'on' : ''}`} title="Memory (⇧⌘M)" onClick={() => toggleSide('memory')}>
            <IconBrain size={14} /> Memory
            {memPulse.value > 0 && <span class="pulse" key={memPulse.value} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts(): VNode {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <span class="toast-ico">{t.kind === 'learn' ? <IconBrain size={13} /> : t.kind === 'error' ? <IconX size={13} /> : <IconInfo size={13} />}</span>
          <span class="toast-text">{t.text}</span>
          {t.action && (
            <button
              class="linkish"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button class="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function DaemonBanner(): VNode | null {
  if (daemonUp.value) return null;
  return <div class="daemon-banner">Reconnecting to your session…</div>;
}

