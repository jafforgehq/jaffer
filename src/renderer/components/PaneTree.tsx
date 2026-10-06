import type { VNode } from 'preact';
import { TerminalView } from './TerminalView';

/** The one terminal of the one session. There are no splits and no second sessions. */
export function PaneTree(): VNode {
  return (
    <div class="panes">
      <div class="pane active">
        <TerminalView pane="main" />
      </div>
    </div>
  );
}
