import type { VNode } from 'preact';
import { currentClaude, daemonUp, dismissToast, info, memPulse, safeCommand, side, tildePath, toasts, toggleSide } from '../state';
import { processBadge } from '../../shared/process-badge';
import { IconBrain, IconBranch, IconInfo, IconX } from './icons';

function shortPath(p: string): string {
  if (!p) return '';
  const s = tildePath(p);
  const parts = s.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : s;
}

export function TitleBar(): VNode {
  const i = info.value;
  const running = i.busy ?? null;
  const badge = processBadge(running, currentClaude()?.state);
  return (
    <div class="titlebar">
      <div class="tb-left" />
      <div class="tb-center">
        <span class="session-pill" title={i.cwd}>
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

