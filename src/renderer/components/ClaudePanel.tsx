import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { runClaude } from '../actions';
import { checkClaudeAuth, claudeAuth, currentClaude, fmtDuration, setSide, toast } from '../state';
import type { ClaudeSession } from '../../core/claude/watcher';
import { InstallCommand } from './ClaudeInstall';
import { IconAgent, IconTerminal, IconX } from './icons';

const LABEL = { working: 'Working', idle: 'Idle', 'needs-you': 'Needs you', ended: 'No session' } as const;

/** Claude Code is not installed: Jaffer runs on a Claude subscription, through Claude Code. */
function SetupBanner(): VNode {
  useEffect(() => {
    const t = setInterval(() => void checkClaudeAuth(), 3000); // goes away by itself once Claude Code is installed
    return () => clearInterval(t);
  }, []);
  return (
    <div class="banner">
      <strong>Claude Code is not installed.</strong> Jaffer runs on your Claude subscription, through Claude Code. Run this in any terminal (Terminal.app works), then come back: Jaffer notices by itself.
      <div class="row">
        <InstallCommand />
      </div>
    </div>
  );
}

/** Claude Code is installed but its login is gone (expired, signed out): say so and offer the sign-in, right here. */
function SignedOutBanner(): VNode | null {
  const a = claudeAuth.value;
  const [busy, setBusy] = useState(false);
  const running = a?.loginRunning ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void checkClaudeAuth(), 1000); // only while a sign-in is open in the browser
    return () => clearInterval(t);
  }, [running]);
  if (!a || !a.installed || a.loggedIn) return null;
  const signIn = async () => {
    setBusy(true);
    try {
      await window.jaffer.call('setup.claude.login', {});
      await checkClaudeAuth();
    } catch (e) {
      toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="banner panel-signin" role="alert">
      <strong>Claude is signed out.</strong> Sign in to keep using Claude Code.
      {a.loginError && <div class="panel-signin-err">{a.loginError}</div>}
      <div class="row">
        <button class="btn primary small" disabled={busy || running} onClick={() => void signIn()}>
          {running ? 'Waiting for your browser…' : 'Sign in with Claude'}
        </button>
      </div>
    </div>
  );
}

function Live({ s }: { s: ClaudeSession }): VNode {
  const rows = [...s.activity].reverse(); // newest first
  return (
    <>
      {s.state === 'needs-you' && (
        <div class="live-needs" role="alert">
          <b>Claude needs you</b>
          {s.notice || 'It is waiting for your permission in the terminal.'}
        </div>
      )}
      {(s.state === 'working' || s.state === 'needs-you') && (
        <div>
          <div class="live-label">Now</div>
          <div class="live-now">
            {s.tool ? (
              <>
                <b>{s.tool.name}</b>
                {s.tool.summary && <code title={s.tool.summary}>{s.tool.summary}</code>}
              </>
            ) : (
              <span class="faint">Thinking…</span>
            )}
          </div>
        </div>
      )}
      {s.prompt && (
        <div>
          <div class="live-label">You asked</div>
          <div class="live-prompt">{s.prompt}</div>
        </div>
      )}
      {rows.length > 0 && (
        <div>
          <div class="live-label">Activity</div>
          <div class="live-activity">
            {rows.map((a) => (
              <div class="live-row" key={a.id} data-status={a.status}>
                <span class="live-mark">{a.status === 'running' ? '…' : a.status === 'done' ? '✓' : '✕'}</span>
                <span class="live-name">{a.name}</span>
                <span class="live-sum" title={a.summary}>
                  {a.summary}
                </span>
                {a.durMs != null && <span class="live-dur">{fmtDuration(a.durMs)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {s.subagents.length > 0 && (
        <div>
          <div class="live-label">Subagents</div>
          <div class="live-subagents">
            {s.subagents.map((a) => (
              <div class="live-row" key={a.id} data-status={a.status === 'running' ? 'running' : 'done'}>
                <span class="live-mark">{a.status === 'running' ? '…' : '✓'}</span>
                <span class="live-name">{a.type}</span>
                <span class="live-sum">{a.status === 'running' ? 'running' : 'done'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {s.lastReply && (
        <div>
          <div class="live-label">Last reply</div>
          <div class="live-reply">{s.lastReply}</div>
        </div>
      )}
    </>
  );
}

/** A live, read-only view of the Claude running in Jaffer's terminal. You talk to that Claude in the terminal, not here. */
export function ClaudePanel(): VNode {
  const s = currentClaude();
  const a = claudeAuth.value;
  return (
    <div class="agent">
      <div class="panel-head">
        <div class="title">
          <span class="title-ico">
            <IconAgent size={13} />
          </span>
          Claude
          <span class="live-pill" data-state={s?.state ?? 'none'}>
            {s ? LABEL[s.state] : 'No session'}
          </span>
        </div>
        <div class="grow" />
        <button class="icon-btn" title="Open the full Claude Code in your terminal (⇧⌘C)" onClick={() => void runClaude()}>
          <IconTerminal size={15} />
        </button>
        <button class="icon-btn" title="Close (⌘J)" onClick={() => setSide(null)}>
          <IconX size={15} />
        </button>
      </div>
      <div class="panel-sub">Live view of the Claude running in your terminal. You talk to it there.</div>
      {a && !a.installed && <SetupBanner />}
      <SignedOutBanner />
      <div class="live-body">
        {s ? (
          <Live s={s} />
        ) : (
          <div class="live-empty">
            <b>Claude Code isn't running</b>
            <span>
              Run <code>claude</code> in the terminal (⇧⌘C) and this panel shows what it is doing, and tells you when it needs you.
            </span>
            <button class="btn primary" onClick={() => void runClaude()}>
              Run claude in the terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
