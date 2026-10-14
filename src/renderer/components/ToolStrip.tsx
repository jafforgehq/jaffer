import type { VNode } from 'preact';
import { cfg, currentClaude, tick } from '../state';
import { turnCalls } from '../claude-ui';

/**
 * A 2 px strip under the title bar: the current turn's tool calls, one segment each, as wide as it took (a running one grows), coloured by
 * kind, red when it failed; hovering a segment names the tool and its time. Its 2 px are kept while it is empty, so nothing moves when it fills.
 * The segments sit in a taller row over it (an easier target, taking no room), right-aligned: when they do not fit, the oldest give way.
 */
export function ToolStrip(): VNode | null {
  if (cfg.value?.claude?.toolStrip === false) return null;
  const s = currentClaude();
  // (a background-agent turn without a prompt keeps the last prompt's calls: only this turn's are shown)
  const calls = turnCalls(s?.calls, s?.turnStartedAt);
  const now = s?.state === 'working' ? tick.value : Date.now();
  return (
    <div class="tool-strip">
      <div class="ts-row">
        {calls.map((c, n) => {
          const ms = Math.max(0, (typeof c.endedAt === 'number' ? c.endedAt : now) - c.startedAt);
          return <span key={n} class="ts-seg" data-cat={c.category} data-failed={c.failed ? '' : undefined} title={`${c.name} · ${(ms / 1000).toFixed(1)} s${c.failed ? ' · failed' : ''}`} style={{ flexGrow: ms }} />;
        })}
      </div>
    </div>
  );
}
