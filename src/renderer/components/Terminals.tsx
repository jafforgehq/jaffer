import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { activePane, cfg, claudeFor, focusPane, paneInfo, paneLabels, paneName, panes, reorderPane, safeCommand, setPaneLabel, shiftPane, tildePath, toggleZoom, zoomPane } from '../state';
import { MAX_PANES } from '../../shared/pane-grid';
import { idleToClose } from '../../shared/pane-tools';
import { nowCardModel } from '../panel';
import { closeTerminal, endTerminal, splitTerminal, whatRuns } from './PaneTree';
import { terminals } from './TerminalView';
import { IconPlus, IconSplit, IconX, IconZoom } from './icons';

/** What a row says under the name: Claude's cost and context (with `claude.showCost`, as the Now card has them), else what runs there, else "idle". */
function secondLine(id: string): string {
  const c = cfg.value?.claude;
  const s = claudeFor(id);
  if (s && c?.showCost !== false) {
    const m = nowCardModel(s, { now: Date.now(), cfg: c });
    const figures = [m.cost?.text, m.context?.text].filter(Boolean).join(' · ');
    if (figures) return figures;
  }
  const busy = paneInfo.value[id]?.busy;
  if (!busy) return 'idle';
  const shown = safeCommand(busy).replace(/\s+/g, ' ').trim().slice(0, 60);
  return busy === 'command' || shown === '(hidden)' ? 'running a command' : shown;
}

/** The question under the header: Cancel has the keyboard (Return and Esc keep every terminal); only a click on End closes them. */
function IdleAsk({ n, onEnd, onCancel }: { n: number; onEnd: () => void; onCancel: () => void }): VNode {
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => cancelBtn.current?.focus(), []);
  return (
    <div class="tm-ask" role="alertdialog" aria-label="End idle terminals?" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onCancel())}>
      <div class="tm-ask-text">{`End ${n} idle terminal${n === 1 ? '' : 's'}?`}</div>
      <div class="tm-ask-btns">
        <button class="btn small danger" onClick={onEnd}>
          End
        </button>
        <button class="btn small" ref={cancelBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * (1.5.0) The side panel's Terminals section: one row per terminal (Claude's state, its name, what it says, split here, zoom, close). A click on
 * the name focuses it; double-click or F2 renames it (memory only); drag a row, or ⌥↑ / ⌥↓, to reorder. Nothing here types into a shell.
 */
export function Terminals(): VNode {
  const list = panes.value;
  const focused = activePane.value;
  const alone = list.length < 2;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLElement>(null);
  /** The row whose name takes the keyboard back once the rows are drawn again (after a rename or a move). */
  const keep = useRef<string | null>(null);
  const idle = idleToClose(list, focused, (id) => !!whatRuns(id));
  const question = asking && idle.length > 0;
  useEffect(() => void (idle.length || setAsking(false)), [idle.length]);
  useLayoutEffect(() => {
    if (editing) return void (input.current?.focus(), input.current?.select());
    const id = keep.current;
    keep.current = null;
    if (id) box.current?.querySelector<HTMLElement>(`.tm-row[data-pane="${CSS.escape(id)}"] .tm-name`)?.focus();
  }, [editing, list.join()]);

  const startEdit = (id: string) => (setDraft(paneLabels.value[id] ?? ''), setEditing(id));
  const finish = (id: string, save: boolean) => {
    if (save) setPaneLabel(id, draft);
    keep.current = id;
    setEditing(null);
  };
  const shift = (id: string, dir: -1 | 1) => {
    const before = panes.value.join();
    shiftPane(id, dir);
    keep.current = panes.value.join() === before ? null : id;
  };
  const zoom = (id: string) => {
    const was = zoomPane.value === id;
    focusPane(id);
    if (was || !zoomPane.value) toggleZoom(); // (a zoom on another terminal follows the focus to this one)
  };
  const endIdle = async () => {
    setAsking(false);
    for (const id of idleToClose(panes.value, activePane.value, (p) => !!whatRuns(p))) if (panes.value.includes(id)) await endTerminal(id);
    terminals.get(activePane.value)?.focus();
  };

  return (
    <section class="tm-card" ref={box} data-tour="terminals" aria-label="Terminals">
      <div class="tm-head">
        <span class="tm-title">
          Terminals <span class="tm-count">{list.length}</span>
        </span>
        <span class="tm-head-acts">
          {!alone && idle.length > 0 && (
            <button class="tm-idle" aria-expanded={question} onClick={() => setAsking(!asking)}>
              Close idle…
            </button>
          )}
          <button class="icon-btn sm tm-new" aria-label="New terminal" title={list.length >= MAX_PANES ? 'At most four terminals' : 'New terminal (⌘D)'} disabled={list.length >= MAX_PANES} onClick={() => void splitTerminal()}>
            <IconPlus size={13} />
          </button>
        </span>
      </div>
      {question && <IdleAsk n={idle.length} onEnd={() => void endIdle()} onCancel={() => (setAsking(false), terminals.get(activePane.value)?.focus())} />}
      <ul class="tm-list" role="list">
        {list.map((id) => {
          const s = claudeFor(id);
          const name = paneName(id);
          const drop = over === id && drag && drag !== id ? (list.indexOf(drag) > list.indexOf(id) ? 'before' : 'after') : undefined;
          return (
            <li
              key={id}
              class="tm-row"
              data-pane={id}
              data-focused={focused === id ? '' : undefined}
              data-state={s?.state ?? 'none'}
              data-dragging={drag === id ? '' : undefined}
              data-drop={drop}
              draggable={editing !== id}
              onDragStart={(e) => {
                e.dataTransfer?.setData('text/plain', id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                setDrag(id);
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                setOver(id);
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver((o) => (o === id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) reorderPane(drag, id);
                setDrag(null);
                setOver(null);
              }}
              onDragEnd={() => (setDrag(null), setOver(null))}
            >
              <span class="tm-dot" aria-hidden="true" />
              {editing === id ? (
                <input
                  ref={input}
                  class="tm-rename"
                  value={draft}
                  placeholder="Name this terminal"
                  aria-label="Name this terminal (Enter saves, Esc cancels, empty removes the name)"
                  spellcheck={false}
                  onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== 'Escape') return;
                    e.preventDefault();
                    e.stopPropagation();
                    finish(id, e.key === 'Enter');
                  }}
                  onBlur={() => editing === id && setEditing(null)}
                />
              ) : (
                <button
                  class="tm-name"
                  title={`${tildePath(paneInfo.value[id]?.cwd ?? '')} (double-click or F2 to rename, ⌥↑ ⌥↓ to move)`}
                  aria-label={`Terminal ${list.indexOf(id) + 1}: ${name}`}
                  onClick={() => focusPane(id)}
                  onDblClick={() => startEdit(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'F2') (e.preventDefault(), startEdit(id));
                    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) (e.preventDefault(), shift(id, e.key === 'ArrowUp' ? -1 : 1));
                  }}
                >
                  {name}
                </button>
              )}
              <span class="tm-meta">{secondLine(id)}</span>
              <span class="tm-acts">
                <button class="icon-btn sm tm-split" aria-label="Split here" title="A new terminal in this folder" disabled={list.length >= MAX_PANES} onClick={() => void splitTerminal(id)}>
                  <IconSplit size={12} />
                </button>
                <button class="icon-btn sm tm-zoom" aria-label="Zoom" title={alone ? 'Only one terminal' : 'Zoom this terminal (⇧⌘↩)'} aria-pressed={!alone && zoomPane.value === id} disabled={alone} onClick={() => zoom(id)}>
                  <IconZoom size={12} />
                </button>
                <button class="icon-btn sm tm-close" aria-label={alone ? 'Restart' : 'Close'} title={alone ? 'Restart this terminal' : 'Close this terminal'} onClick={() => closeTerminal(id)}>
                  <IconX size={12} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
