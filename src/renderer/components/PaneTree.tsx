import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { VNode } from 'preact';
import { activePane, addPane, focusPane, claudeFor, claudeIn, closeAsk, paneLayout, paneInfo, paneKey, paneName, panes, removePane, safeCommand, tildePath, toast, zoomPane } from '../state';
import { MAX_PANES, paneGrid } from '../../shared/pane-grid';
import { isClaudeCommand } from '../../shared/process-badge';
import { TerminalView, terminals } from './TerminalView';
import { Pet } from './Pet';

/**
 * The split view (1.4.0): up to four terminals, each its own shell, opened only by the person (⌘D) and in the order they were opened; a
 * grid of equal parts (no drag). Each has a small chip (its Claude's state, its folder, ✕). Nothing of the layout is kept: a new start
 * has one terminal.
 */

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);


/** ⌘D: one more terminal in the focused one's folder (the daemon reads it from the terminal named; the panel's *Split here* names its own row), and it takes the keyboard. */
export async function splitTerminal(from: string = activePane.value): Promise<void> {
  if (panes.value.length >= MAX_PANES) return void toast({ kind: 'info', text: 'At most four terminals.' });
  try {
    const p = await call<{ id: string }>('pane.split', { pane: from });
    addPane(p.id);
    focusPane(p.id);
  } catch (e) {
    toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
  }
}

/** ⌘1..⌘4: the nth terminal (nothing when there are fewer). */
export function focusTerminal(n: number): void {
  const id = panes.value[n - 1];
  if (id) focusPane(id);
}

/** ⌘] / ⌘[: the next or the previous terminal, round. */
export function cycleTerminal(dir: 1 | -1): void {
  const list = panes.value;
  const i = list.indexOf(activePane.value);
  focusPane(list[(i + dir + list.length) % list.length] ?? activePane.value);
}

/** What closing this terminal would stop, as the question says it (the command through `safeCommand`); null when nothing runs. */
export function whatRuns(id: string): string | null {
  const busy = paneInfo.value[id]?.busy;
  if (claudeIn(id) || (busy && isClaudeCommand(busy))) return 'Claude is running here';
  if (!busy) return null;
  const shown = safeCommand(busy).replace(/\s+/g, ' ').trim().slice(0, 60);
  return busy === 'command' || shown === '(hidden)' ? 'A command is running.' : `A command is running: ${shown}`;
}

/** The chip's ✕ and ⇧⌘W: asks first when something runs there, else ends the terminal at once. */
export function closeTerminal(id = activePane.value): void {
  if (!whatRuns(id)) return void endTerminal(id);
  focusPane(id);
  closeAsk.value = id;
}

/** The terminals whose close or restart is on its way. */
const ending = new Set<string>();

/** With several terminals this one closes; the last one restarts (a fresh shell in the same folder, a blank screen). */
export async function endTerminal(id: string): Promise<void> {
  closeAsk.value = null;
  if (ending.has(id)) return; // (a double click, or ⇧⌘W twice: one request)
  ending.add(id);
  try {
    if (panes.value.length > 1) {
      await call('pane.close', { pane: id });
      removePane(id); // (its `closed` event does the same; whichever comes first)
    } else {
      await call('session.restart', { pane: id });
      toast({ kind: 'info', text: 'Shell restarted in the same folder.' });
    }
  } catch (e) {
    toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
  } finally {
    ending.delete(id);
  }
}

function Chip({ id, alone, zoomed }: { id: string; alone: boolean; zoomed: boolean }): VNode {
  const c = claudeIn(id);
  const cwd = paneInfo.value[id]?.cwd ?? '';
  const label = alone ? 'Restart terminal' : 'Close terminal';
  return (
    <div class="pn-chip" data-zoomed={zoomed ? '' : undefined}>
      {c && <span class="pn-dot" data-state={c.state} title={c.state === 'needs-you' ? 'Claude needs you' : c.state === 'working' ? 'Claude is working' : 'Claude is waiting'} />}
      <span class="pn-name" title={tildePath(cwd)}>
        {paneName(id)}
      </span>
      <button class="pn-x" aria-label={label} title={label} onClick={() => closeTerminal(id)}>
        ×
      </button>
    </div>
  );
}

/** The question under the chip: Cancel has the keyboard (Return and Esc keep the terminal); only a click on End terminal ends it. */
function Confirm({ id }: { id: string }): VNode {
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => cancelBtn.current?.focus(), []); // (at once: a key pressed as it appears must not reach the terminal)
  const cancel = () => {
    closeAsk.value = null;
    terminals.get(id)?.focus();
  };
  return (
    <div class="pn-confirm" role="alertdialog" aria-label="End this terminal?" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), cancel())}>
      <div class="pn-confirm-text">{whatRuns(id) ?? 'Nothing runs here now.'}</div>
      <div class="pn-confirm-btns">
        <button class="btn small danger" onClick={() => void endTerminal(id)}>
          End terminal
        </button>
        <button class="btn small" ref={cancelBtn} onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PaneTree(): VNode {
  const list = panes.value.slice(0, MAX_PANES);
  const g = paneGrid(list.length);
  const multi = list.length > 1;
  const zoom = multi && zoomPane.value && list.includes(zoomPane.value) ? zoomPane.value : null; // (⇧⌘↩: one terminal over the whole area, the others hidden but alive)
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ro = new ResizeObserver(() => paneLayout.value++);
    for (const el of box.current?.children ?? []) ro.observe(el);
    return () => ro.disconnect();
  }, [list.join()]);
  return (
    <div ref={box} class="panes" data-tour="panes" data-count={list.length} style={{ gridTemplateColumns: `repeat(${g.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${g.rows}, minmax(0, 1fr))` }}>
      {list.map((id, i) => {
        const c = g.cells[i]!;
        const live = claudeFor(id)?.state; // (the outline: only 'working' and 'needs-you' draw one)
        const cell = zoom === id ? { gridColumn: '1 / -1', gridRow: '1 / -1' } : { gridColumn: `${c.col}`, gridRow: `${c.row} / span ${c.rows}` };
        return (
          <div key={paneKey(id)} class="pane" data-pane={id} data-claude={live === 'working' || live === 'needs-you' ? live : undefined} data-focused={multi && activePane.value === id ? '' : undefined} data-hidden={zoom && zoom !== id ? '' : undefined} style={cell} onMouseDown={() => focusPane(id)}>
            <TerminalView pane={id} />
            <Chip id={id} alone={!multi} zoomed={zoom === id} />
            {closeAsk.value === id && <Confirm id={id} />}
            <Pet pane={id} />
          </div>
        );
      })}
    </div>
  );
}
