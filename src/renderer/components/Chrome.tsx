import type { VNode } from 'preact';
import { activePane, cfg, daemonUp, info, keyReady, memPulse, memStats, side, toggleSide, toasts, dismissToast, turn, agentUsage, overlay, panes } from '../state';
import { IconAgent, IconBrain, IconGear, IconSplit, IconX } from './icons';
import { splitPane } from './PaneTree';

function shortPath(p: string): string {
  if (!p) return '';
  const home = (window as unknown as { __home?: string }).__home;
  let s = p;
  if (home && s.startsWith(home)) s = '~' + s.slice(home.length);
  const parts = s.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : s;
}

export function TitleBar(): VNode {
  const i = info.value;
  const busy = !!turn.value;
  return (
    <div class="titlebar">
      <div class="tb-left" />
      <div class="tb-center">
        <span class="session-pill" title={i.cwd}>
          <span class={`live ${daemonUp.value ? '' : 'off'}`} />
          <span class="cwd">{shortPath(i.cwd) || 'Jaffer'}</span>
          {i.branch && <span class="branch">{i.branch}</span>}
          {i.busy && <span class="running">{i.busy.slice(0, 28)}</span>}
        </span>
      </div>
      <div class="tb-right">
        <button class="icon-btn" title="Split right (⌘D)" onClick={() => void splitPane('row')}>
          <IconSplit size={16} />
        </button>
        <button class={`icon-btn ${side.value === 'memory' ? 'on' : ''}`} title="Memory (⇧⌘M)" onClick={() => toggleSide('memory')}>
          <IconBrain size={16} />
          {memPulse.value > 0 && <span class="pulse" key={memPulse.value} />}
        </button>
        <button class={`icon-btn ${side.value === 'agent' ? 'on' : ''}`} title="Agent (⌘J)" onClick={() => toggleSide('agent')}>
          <IconAgent size={16} />
          {busy && <span class="busy-dot" />}
        </button>
        <button class="icon-btn" title="Settings (⌘,)" onClick={() => (overlay.value = 'settings')}>
          <IconGear size={16} />
        </button>
      </div>
    </div>
  );
}

export function StatusBar(): VNode {
  const st = memStats.value;
  const i = info.value;
  const last = i.lastCommand;
  const cost = agentUsage.value?.costUsd ?? 0;
  return (
    <div class="statusbar">
      <span class="sb-item">
        {panes.value.length > 1 ? `${panes.value.length} panes · ` : ''}
        one session
      </span>
      {last && (
        <span class={`sb-item ${last.exit === 0 ? '' : 'bad'}`} title={last.cmd}>
          {last.exit === 0 ? '✓' : `✗ ${last.exit}`} {last.cmd.slice(0, 40)}
        </span>
      )}
      <div class="grow" />
      {!keyReady.value && <span class="sb-item warn">no API key</span>}
      {cost > 0 && <span class="sb-item">${cost.toFixed(2)}</span>}
      <button class="sb-item sb-btn" onClick={() => toggleSide('memory')} title="Open memory">
        <span class="mem-dot" key={memPulse.value} /> {st ? `${st.active} memories · ${st.skills} skills` : 'memory'}
      </button>
      <span class="sb-item">{cfg.value?.agent.model}</span>
    </div>
  );
}

export function Toasts(): VNode {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.kind === 'learn' && <IconBrain size={14} />}
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
          <button class="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
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

void activePane;
