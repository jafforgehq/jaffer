import type { VNode } from 'preact';
import { activePane, baseName, claudeAuth, clock, commandLog, currentClaude, daemonUp, fmtUptime, fmtDuration, homeDir, info, memItems, overlay, safeCommand, setSide, side, tildePath, toggleRail, toggleSide } from '../state';
import { processBadge } from '../../shared/process-badge';
import { terminals } from './TerminalView';
import { IconAgent, IconBolt, IconCheck, IconCommandKey, IconFolder, IconGear, IconBranch, IconPlus, IconSidebar, IconTerminal, IconX } from './icons';

/** The one session at a glance: where it is, what is running, what just ran, and what Jaffer knows about this place. */
export function SessionRail(): VNode {
  const i = info.value;
  const now = clock.value;
  const home = homeDir();
  const atHome = !i.project && (!i.cwd || i.cwd === home);
  const name = atHome ? 'Home' : baseName(i.project || i.cwd);
  const busy = i.busy ?? null;
  const claude = !!busy && /\bclaude\b/.test(busy);
  const badge = processBadge(busy, currentClaude()?.state);
  const cmds = commandLog.value.slice(-5).reverse();
  const live = currentClaude();
  const waiting = live?.state === 'needs-you';
  const working = live?.state === 'working';
  const agentLine = claudeAuth.value?.installed === false ? 'not set up yet' : waiting ? 'waiting for you' : working ? `working · ${live!.tool?.name ?? 'thinking'}` : live ? 'idle' : 'not running';

  const projectScope = i.project ? `project:${i.project}` : null;
  const peek = memItems.value
    .filter((m) => (projectScope && m.scope === projectScope) || (m.scope === 'global' && m.pinned))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.confidence - a.confidence)
    .slice(0, 3);

  return (
    <aside class="rail">
      <div class="rail-top">
        <button class="icon-btn" title="Hide sidebar (⌘B)" onClick={toggleRail}>
          <IconSidebar size={16} />
        </button>
      </div>
      <div class="rail-scroll">
        <section class="session-card" title={i.cwd}>
          <div class="sc-status">
            <span class={`live ${daemonUp.value ? '' : 'off'}`} />
            <b>{daemonUp.value ? 'Session live' : 'Reconnecting'}</b>
            {i.startedAt && <span>· up {fmtUptime(i.startedAt, now)}</span>}
          </div>
          <div class="sc-name">{name}</div>
          <div class="sc-path">
            <bdi>{tildePath(i.cwd) || '…'}</bdi>
          </div>
          <div class="sc-tags">
            {i.branch && (
              <span class="tag branch">
                <IconBranch size={11} /> {i.branch}
              </span>
            )}
            {busy && (
              <span class={`tag ${claude ? 'claude' : 'busy'}`} title={busy}>
                <span class={badge.spin ? 'spinner' : 'run-dot'} /> {claude ? 'Claude Code' : safeCommand(busy).slice(0, 22)}
              </span>
            )}
            {!busy && i.lastCommand && (
              <span class={`tag ${i.lastCommand.exit === 0 ? 'ok' : 'bad'}`}>{i.lastCommand.exit === 0 ? 'last command passed' : `exit ${i.lastCommand.exit}`}</span>
            )}
          </div>
        </section>

        <section>
          <button class={`row-item ${side.value === 'agent' ? 'on' : ''}`} onClick={() => (side.value === 'agent' ? setSide(null) : setSide('agent'))} title="Open the Claude panel (⌘J)">
            <span class="row-ico ico-agent" data-live={working ? 'working' : undefined}>
              <IconAgent size={12} />
            </span>
            <span class="row-text">
              <span class="row-title">Claude</span>
              <span class={`row-sub ui ${waiting ? 'attn' : ''}`}>{agentLine}</span>
            </span>
            {waiting ? <span class="row-dot attn" /> : working ? <span class="spinner" /> : null}
          </button>
        </section>

        <section>
          <div class="rail-h">
            <span>Recent</span>
            <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>{commandLog.value.length ? `${commandLog.value.length} in this session` : ''}</span>
          </div>
          {cmds.length === 0 ? (
            <div class="peek-empty">Commands you run show up here.</div>
          ) : (
            <div class="cmd-list">
              {cmds.map((c, k) => {
                const bad = c.exit !== null && c.exit !== 0;
                return (
                  <button key={`${c.at}-${k}`} class={`cmd-row ${bad ? 'bad' : ''}`} title={`${safeCommand(c.cmd)}\n${tildePath(c.cwd)}\nClick to put it back on the prompt`} onClick={() => terminals.get(activePane.value)?.type(c.cmd)}>
                    <span class="cmd-mark">{bad ? <IconX size={12} /> : <IconCheck size={12} />}</span>
                    <span class="cmd-text">{safeCommand(c.cmd)}</span>
                    {c.by === 'agent' && (
                      <span class="cmd-by" title="Run by the agent">
                        <IconBolt size={11} />
                      </span>
                    )}
                    <span class="cmd-dur">{fmtDuration(c.durMs)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div class="rail-h">
            <span>Known here</span>
            <button onClick={() => toggleSide('memory')}>Open</button>
          </div>
          <div class="mem-peek">
            {peek.length === 0 && <div class="peek-empty">{atHome ? 'Open a project and Jaffer starts learning it.' : 'Nothing learned about this project yet.'}</div>}
            {peek.map((m) => (
              <div key={m.id} class={`peek ${m.pinned ? 'pinned' : ''}`} title={m.text}>
                <i />
                <span>{m.text}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div class="rail-foot">
        <button class="kbd-btn" onClick={() => (overlay.value = 'palette')} title="Command palette (⌘P)">
          <IconCommandKey size={13} /> Search or ask…
          <kbd>⌘P</kbd>
        </button>
        <button class="icon-btn" title="Settings (⌘,)" onClick={() => (overlay.value = 'settings')}>
          <IconGear size={16} />
        </button>
      </div>
    </aside>
  );
}

void IconFolder;
void IconPlus;
