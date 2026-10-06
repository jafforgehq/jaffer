import { signal, untracked } from '@preact/signals';
import { useRef } from 'preact/hooks';
import type { VNode } from 'preact';
import { activePane, paneLabel, panes, safeCommand, tildePath } from '../state';
import { TerminalView } from './TerminalView';
import { IconX } from './icons';

export type LayoutNode = { t: 'pane'; id: string } | { t: 'split'; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode };

const KEY = 'jaffer.layout.v1';
export const layout = signal<LayoutNode>(load());

function load(): LayoutNode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as LayoutNode;
  } catch {
    /* fall through */
  }
  return { t: 'pane', id: 'main' };
}

export function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout.value));
  } catch {
    /* ignore */
  }
}

export function leaves(n: LayoutNode): string[] {
  return n.t === 'pane' ? [n.id] : [...leaves(n.a), ...leaves(n.b)];
}

/** Drop leaves for panes that no longer exist, and any duplicate leaf (a pane can only be shown once). */
function prune(n: LayoutNode, alive: Set<string>, seen: Set<string> = new Set()): LayoutNode | null {
  if (n.t === 'pane') {
    if (!alive.has(n.id) || seen.has(n.id)) return null;
    seen.add(n.id);
    return n;
  }
  const a = prune(n.a, alive, seen);
  const b = prune(n.b, alive, seen);
  if (a && b) return { ...n, a, b };
  return a ?? b;
}

/** Reconcile the saved layout with the panes the daemon actually has. */
export function reconcile(): void {
  untracked(() => {
    const alive = new Set(panes.value.map((p) => p.id));
    if (alive.size === 0) return;
    let next = prune(layout.value, alive) ?? { t: 'pane' as const, id: 'main' };
    const present = new Set(leaves(next));
    for (const id of alive) if (!present.has(id)) next = { t: 'split', dir: 'row', ratio: 0.5, a: next, b: { t: 'pane', id } };
    layout.value = next;
    if (!alive.has(activePane.value)) activePane.value = [...alive][0]!;
    save();
  });
}

function replace(n: LayoutNode, id: string, f: (leaf: LayoutNode) => LayoutNode): LayoutNode {
  if (n.t === 'pane') return n.id === id ? f(n) : n;
  return { ...n, a: replace(n.a, id, f), b: replace(n.b, id, f) };
}

export async function splitPane(dir: 'row' | 'col'): Promise<void> {
  const from = activePane.value;
  const r = await window.jaffer.call('pane.split', {});
  const list = await window.jaffer.call('pane.list', {});
  // Place the new pane in the layout *before* publishing the pane list, so reconcile() has nothing left to add.
  layout.value = replace(layout.value, from, (leaf) => ({ t: 'split', dir, ratio: 0.5, a: leaf, b: { t: 'pane', id: r.pane } }));
  activePane.value = r.pane;
  panes.value = list;
  save();
}

export async function closePane(id: string = activePane.value): Promise<void> {
  if (id === 'main') return; // the one session never closes
  await window.jaffer.call('pane.close', { pane: id });
}

function Divider({ dir, onDrag }: { dir: 'row' | 'col'; onDrag: (frac: number) => void }): VNode {
  const ref = useRef<HTMLDivElement>(null);
  const down = (e: PointerEvent) => {
    e.preventDefault();
    const parent = ref.current!.parentElement!;
    const rect = parent.getBoundingClientRect();
    const move = (ev: PointerEvent) => onDrag(dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div ref={ref} class={`divider dir-${dir}`} onPointerDown={down} />;
}

function PaneHead({ id }: { id: string }): VNode {
  const p = panes.value.find((x) => x.id === id);
  return (
    <div class="pane-head" onMouseDown={() => (activePane.value = id)}>
      <span class="ph-dot" />
      <span class="ph-title">{paneLabel(id).toLowerCase()}</span>
      <span class="ph-title faint">{p ? tildePath(p.cwd) : ''}</span>
      {p?.busy && <span class="ph-run">{safeCommand(p.busy).slice(0, 24)}</span>}
      <div class="grow" />
      {id !== 'main' && (
        <button class="icon-btn sm" title="Close pane (⌘W)" onClick={() => void closePane(id)}>
          <IconX size={12} />
        </button>
      )}
    </div>
  );
}

function Node({ n, path }: { n: LayoutNode; path: number[] }): VNode {
  if (n.t === 'pane') {
    return (
      <div class={`pane ${activePane.value === n.id ? 'active' : ''}`} key={n.id} onMouseDown={() => (activePane.value = n.id)}>
        {panes.value.length > 1 && <PaneHead id={n.id} />}
        <TerminalView pane={n.id} />
      </div>
    );
  }
  const setRatio = (frac: number) => {
    const r = Math.min(0.85, Math.max(0.15, frac));
    const upd = (node: LayoutNode, p: number[]): LayoutNode => (p.length === 0 ? (node.t === 'split' ? { ...node, ratio: r } : node) : node.t === 'split' ? (p[0] === 0 ? { ...node, a: upd(node.a, p.slice(1)) } : { ...node, b: upd(node.b, p.slice(1)) }) : node);
    layout.value = upd(layout.value, path);
  };
  return (
    <div class={`split dir-${n.dir}`}>
      <div class="cell" style={{ flex: `${n.ratio} 1 0` }}>
        <Node n={n.a} path={[...path, 0]} />
      </div>
      <Divider dir={n.dir} onDrag={setRatio} />
      <div class="cell" style={{ flex: `${1 - n.ratio} 1 0` }}>
        <Node n={n.b} path={[...path, 1]} />
      </div>
    </div>
  );
}

export function PaneTree(): VNode {
  return (
    <div class={`panes ${panes.value.length > 1 ? 'multi' : ''}`}>
      <Node n={layout.value} path={[]} />
    </div>
  );
}
