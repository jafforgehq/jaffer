import type { VNode } from 'preact';
import { agentEngine, agentUsage, cfg, daemonUp, dismissToast, fmtDuration, info, agentReady, memPulse, memStats, overlay, railOpen, safeCommand, side, tildePath, toasts, toggleRail, toggleSide, turn } from '../state';
import { IconAgent, IconBolt, IconBrain, IconBranch, IconCheck, IconInfo, IconSidebar, IconX } from './icons';

function shortPath(p: string): string {
  if (!p) return '';
  const s = tildePath(p);
  const parts = s.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : s;
}

export function TitleBar(): VNode {
  const i = info.value;
  const busy = !!turn.value;
  const running = i.busy ?? null;
  return (
    <div class="titlebar">
      <div class="tb-left">
        {!railOpen.value && (
          <button class="icon-btn" title="Show sidebar (⌘B)" onClick={toggleRail}>
            <IconSidebar size={16} />
          </button>
        )}
      </div>
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
              <span class="running">
                <span class="spinner" /> {safeCommand(running).slice(0, 28)}
              </span>
            </>
          )}
        </span>
      </div>
      <div class="tb-right">
        <div class="seg">
          <button class={`seg-btn ${side.value === 'agent' ? 'on' : ''}`} title="Claude (⌘J)" onClick={() => toggleSide('agent')}>
            <IconAgent size={14} /> Claude
            {busy && <span class="busy-dot" />}
          </button>
          <button class={`seg-btn seg-mem ${side.value === 'memory' ? 'on' : ''}`} title="Memory (⇧⌘M)" onClick={() => toggleSide('memory')}>
            <IconBrain size={14} /> Memory
            {memPulse.value > 0 && <span class="pulse" key={memPulse.value} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StatusBar(): VNode {
  const st = memStats.value;
  const i = info.value;
  const last = i.lastCommand;
  const cost = agentUsage.value?.costUsd ?? 0;
  const claude = !!i.busy && /\bclaude\b/.test(i.busy);
  return (
    <div class="statusbar">
      <span class="sb-item">
        <span class={`live ${daemonUp.value ? '' : 'off'}`} style={{ width: '6px', height: '6px' }} />
        one session
      </span>
      {last && (
        <span class={`sb-item cmd ${last.exit === 0 ? 'ok' : 'bad'}`} title={last.cmd}>
          {last.exit === 0 ? <IconCheck size={11} /> : <IconX size={11} />}
          {last.exit === 0 ? '' : `${last.exit} `}
          {safeCommand(last.cmd).slice(0, 48)}
        </span>
      )}
      <div class="grow" />
      {claude && (
        <span class="sb-item accent">
          <IconBolt size={11} /> Claude Code is running
        </span>
      )}
      {!agentReady.value && (
        <button class="sb-item sb-btn warn" onClick={() => (overlay.value = 'settings')} title="Claude Code needs to be installed and signed in: see Settings">
          <IconInfo size={11} /> set up Claude
        </button>
      )}
      {cost > 0 && agentEngine.value !== 'claude-code' && <span class="sb-item">${cost.toFixed(2)}</span>}
      <button class="sb-item sb-btn" onClick={() => toggleSide('memory')} title="Open memory">
        <span class="mem-dot" key={memPulse.value} /> {st ? `${st.active} memories · ${st.skills} skills` : 'memory'}
      </button>
      <span class="sb-item">{agentEngine.value === 'claude-code' ? cfg.value?.agent.cliModel || 'Claude login' : cfg.value?.agent.model}</span>
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

void fmtDuration;
