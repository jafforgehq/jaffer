import { useLayoutEffect, useRef } from 'preact/hooks';
import type { VNode } from 'preact';
import { effect, signal } from '@preact/signals';
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { BlockModel, blockOutputText, fenceText, saveName, type Block, type MarkKind } from '../blocks';
import { cfg, safeCommand, toast } from '../state';
import { isSensitiveCommand } from '../../shared/redact';
import { took } from '../../shared/notify-policy';

/**
 * Command blocks in the terminal (spec features 7, 8, 22, 24, 26, 27): the renderer reads the shell marks on its own xterm parser
 * (the handlers return false, so xterm still ignores the marks), keeps a marker per prompt, output start and end, and draws a mark
 * in the gutter beside every command's prompt. Blocks exist for output received since the window attached: a snapshot carries no
 * marks, so after `term.reset()` they start again. Nothing here is written anywhere; the command is shown only through `safeCommand`.
 */

export interface BlocksHandle {
  /** Before `term.reset()`: every marker, decoration and block goes. */
  reset(): void;
  dispose(): void;
  /** The blocks with their lines as they are now. */
  list(): Block[];
  /** ⌘↑ / ⌘↓: the prompt above or below the top of the view. */
  jump(dir: -1 | 1): void;
  /** ⌥⌘C: the selection as Markdown, with its block's command when it lies inside one block's output. */
  copyMarkdown(): void;
}

interface Tracked {
  prompt: IMarker;
  start?: IMarker;
  end?: IMarker;
  gutter?: IDecoration;
}

interface Sticky {
  id: number;
  label: string;
  state: string;
  go(): void;
}
interface MenuItem {
  label: string;
  run(): void;
}

const sticky = signal<Sticky | null>(null);
const ctxMenu = signal<{ x: number; y: number; block: number; items: MenuItem[]; done(): void } | null>(null);
let live: BlocksHandle | null = null;

/** The blocks of the terminal (for later features: paths relative to a block's folder, recent output). */
export function currentBlocks(): Block[] {
  return live?.list() ?? [];
}

function state(b: Block): 'ok' | 'fail' | 'run' {
  if (b.endedAt === undefined || b.exit === null || b.exit === undefined) return 'run';
  return b.exit === 0 ? 'ok' : 'fail';
}

const hms = (t: number) => {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

/** Feature 24: when it started and how long it took; never the command. */
function times(b: Block): string {
  if (b.startedAt === undefined) return '';
  const start = `Started ${hms(b.startedAt)}`;
  if (b.endedAt === undefined) return `${start} · running`;
  const ms = Math.max(0, b.endedAt - b.startedAt);
  const exit = b.exit === null ? ' · exit unknown' : b.exit === 0 ? '' : ` · exit ${b.exit}`;
  return `${start} · took ${ms < 1000 ? `${ms} ms` : took(ms)}${exit}`;
}

/** The command as the window may show it; a sensitive one is not named. */
const shownCommand = (b: Block): string | undefined => (b.cmd && !isSensitiveCommand(b.cmd) ? safeCommand(b.cmd) : undefined);

function copy(text: string, said: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast({ kind: 'info', text: said }, 2500),
    () => toast({ kind: 'error', text: 'Could not copy to the clipboard.' }),
  );
}

export function attachBlocks(term: Terminal): BlocksHandle {
  const tracked = new Map<number, Tracked>();
  const labels = new Map<number, string>();
  const free = (id: number) => {
    const t = tracked.get(id);
    tracked.delete(id);
    labels.delete(id);
    if (ctxMenu.value?.block === id) ctxMenu.value = null; // its menu goes with it
    if (!t) return;
    t.gutter?.dispose();
    t.prompt.dispose();
    t.start?.dispose();
    t.end?.dispose();
  };
  const model = new BlockModel((b) => free(b.id));
  let on = false;
  let handlers: IDisposable[] = [];
  let hl: IDecoration | undefined;
  let raf = 0;

  /** Lines move when the scrollback is trimmed: the markers know where they are now. */
  const sync = () => {
    for (const b of model.blocks()) {
      const t = tracked.get(b.id);
      if (!t) continue;
      b.promptLine = t.prompt.line;
      if (t.start) b.outputStart = t.start.line;
      if (t.end) b.outputEnd = t.end.line;
    }
  };

  const unlight = () => {
    hl?.dispose();
    hl = undefined;
  };
  const light = (b: Block) => {
    unlight();
    const t = tracked.get(b.id);
    if (!t?.start) return;
    sync();
    const buf = term.buffer.active;
    const bottom = Math.min(b.outputEnd ?? buf.length - 1, buf.viewportY + term.rows - 1);
    const height = bottom - t.start.line + 1;
    if (height < 1) return;
    hl = term.registerDecoration({ marker: t.start, x: 0, width: term.cols, height, layer: 'bottom' });
    hl?.onRender((el) => el.classList.add('block-hl'));
  };

  const output = (b: Block) => (sync(), blockOutputText(term.buffer.active, b));

  const menuFor = (b: Block): MenuItem[] => {
    const items: MenuItem[] = [];
    if (b.cmd && !isSensitiveCommand(b.cmd)) items.push({ label: 'Copy command', run: () => copy(b.cmd!, 'Copied') }); // the raw text, to the person's own clipboard
    items.push(
      { label: 'Copy output', run: () => copy(output(b), 'Copied') },
      {
        label: 'Save output…',
        run: () =>
          void window.jaffer.saveText(output(b), saveName(b)).then(
            (r) => r.saved && toast({ kind: 'info', text: 'Saved' }, 2500),
            (e) => toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) }),
          ),
      },
      { label: 'Copy as Markdown', run: () => copy(fenceText(output(b), shownCommand(b)), 'Copied as Markdown') },
    );
    return items;
  };

  const style = (el: HTMLElement, b: Block) => {
    el.dataset.state = state(b);
    el.title = times(b);
  };
  const addGutter = (b: Block, t: Tracked) => {
    const d = term.registerDecoration({ marker: t.prompt, x: 0, width: 1, layer: 'top' });
    if (!d) return;
    t.gutter = d;
    d.onRender((el) => {
      if (!el.classList.contains('gutter-mark')) {
        el.classList.add('gutter-mark');
        el.dataset.block = String(b.id);
        el.addEventListener('mouseenter', () => light(b));
        el.addEventListener('mouseleave', unlight);
        el.addEventListener('mousedown', (e) => (e.stopPropagation(), e.preventDefault())); // not the start of a text selection
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          sync();
          const end = b.outputEnd ?? term.buffer.active.length - 1;
          if (b.outputStart !== undefined && end >= b.outputStart) term.selectLines(b.outputStart, end);
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          ctxMenu.value = { x: e.clientX, y: e.clientY, block: b.id, items: menuFor(b), done: () => term.focus() };
        });
      }
      style(el, b);
    });
  };

  /** A prompt's marker: when its line leaves the scrollback the block goes, except the prompt still waiting for a command (Ctrl-L or ⌘K
   * erased its line, and xterm drops the markers of an erased line): that one keeps its block and anchors again when its command starts. */
  const anchor = (b: Block, prompt: IMarker) => {
    tracked.set(b.id, { prompt });
    prompt.onDispose(() => {
      if (tracked.get(b.id)?.prompt !== prompt) return;
      if (b.outputStart === undefined && model.blocks().at(-1) === b) {
        tracked.delete(b.id);
        return;
      }
      free(b.id);
      model.remove(b.id);
      queueSticky();
    });
  };

  const queueSticky = () => {
    if (!raf) raf = requestAnimationFrame(updateSticky);
  };
  function updateSticky(): void {
    raf = 0;
    const buf = term.buffer.active;
    let next: Sticky | null = null;
    if (on && buf.type === 'normal' && buf.viewportY < buf.baseY) {
      sync();
      const top = buf.viewportY;
      const b = model.blockAt(top);
      if (b && b.outputStart !== undefined && top >= b.outputStart && b.promptLine < top) {
        let label = labels.get(b.id);
        if (label === undefined) labels.set(b.id, (label = safeCommand(b.cmd ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)));
        next = { id: b.id, label, state: state(b), go: () => term.scrollToLine(Math.max(0, b.promptLine)) };
      }
    }
    const cur = sticky.value;
    if (next?.id !== cur?.id || next?.state !== cur?.state || next?.label !== cur?.label) sticky.value = next;
  }

  const mark = (kind: MarkKind, payload: string): boolean => {
    const buf = term.buffer.active;
    if (buf.type !== 'normal') return false; // a full-screen program is one block: nothing inside the alternate screen
    const offset = kind === 'D' && buf.cursorX === 0 ? -1 : 0; // D: the output's last line is the one above the cursor, unless it did not end with a newline
    const last = model.blocks().at(-1);
    const lost = kind === 'A' && last && last.outputStart !== undefined && last.endedAt === undefined ? last : undefined;
    const b = model.onMark(kind, payload, buf.baseY + buf.cursorY + offset, Date.now());
    if (!b) return false;
    if (kind === 'A') {
      if (lost) {
        const t = tracked.get(lost.id);
        if (t) t.end = term.registerMarker(-1);
        t?.gutter?.element && style(t.gutter.element, lost);
      }
      const prompt = term.registerMarker(0);
      if (!prompt) {
        model.remove(b.id);
        return false;
      }
      anchor(b, prompt);
    } else if (kind === 'C') {
      if (!tracked.has(b.id)) {
        const prompt = term.registerMarker(-1); // its prompt was erased while it waited: the line above the output stands in
        if (!prompt) return false;
        anchor(b, prompt);
      }
      const t = tracked.get(b.id)!;
      t.start = term.registerMarker(0);
      addGutter(b, t);
    } else if (kind === 'D') {
      const t = tracked.get(b.id);
      if (!t) return false;
      t.end = term.registerMarker(offset);
      if (t.gutter?.element) style(t.gutter.element, b);
    }
    return false;
  };

  const clear = () => {
    unlight();
    for (const id of [...tracked.keys()]) free(id);
    model.reset();
    sticky.value = null;
    ctxMenu.value = null;
  };

  const enable = () => {
    on = true;
    handlers = [
      term.parser.registerOscHandler(133, (data) => {
        const semi = data.indexOf(';');
        const kind = semi < 0 ? data : data.slice(0, semi);
        return kind === 'A' || kind === 'C' || kind === 'D' ? mark(kind, semi < 0 ? '' : data.slice(semi + 1)) : false;
      }),
      term.parser.registerOscHandler(633, (data) => (data.startsWith('E;') ? mark('E', data.slice(2)) : false)),
      // ESC c (a full reset, as `reset` or `printf '\ec'` send) clears the screen and the scrollback but leaves xterm's markers: drop the blocks first
      term.parser.registerEscHandler({ final: 'c' }, () => (clear(), false)),
    ];
  };
  const disable = () => {
    on = false;
    for (const h of handlers) h.dispose();
    handlers = [];
    clear();
  };

  const subs = [term.onScroll(queueSticky), term.onWriteParsed(queueSticky), term.buffer.onBufferChange(queueSticky)];
  const stop = effect(() => {
    const want = cfg.value?.terminal?.blocks !== false;
    if (want && !on) enable();
    else if (!want && on) disable();
  });

  const handle: BlocksHandle = {
    reset: clear,
    dispose: () => {
      stop();
      disable();
      for (const s of subs) s.dispose();
      cancelAnimationFrame(raf);
      if (live === handle) live = null;
    },
    list: () => (sync(), model.blocks().map((b) => ({ ...b }))),
    jump: (dir) => {
      if (!on || term.buffer.active.type !== 'normal') return;
      sync();
      const top = term.buffer.active.viewportY;
      const lines = model.blocks().filter((b) => tracked.has(b.id)).map((b) => b.promptLine).filter((l) => l >= 0);
      const target = dir < 0 ? lines.filter((l) => l < top).at(-1) : lines.find((l) => l > top);
      if (target !== undefined) term.scrollToLine(target);
      else if (dir > 0) term.scrollToBottom();
    },
    copyMarkdown: () => {
      const text = term.getSelection();
      if (!text) {
        toast({ kind: 'info', text: 'Select something first' }, 2500);
        return;
      }
      let cmd: string | undefined;
      const pos = term.getSelectionPosition();
      if (on && pos) {
        sync();
        const endY = pos.end.x === 0 && pos.end.y > pos.start.y ? pos.end.y - 1 : pos.end.y; // a selection that ends at a line's start ends on the line above
        const b = model.blockAt(pos.start.y);
        if (b && b.outputStart !== undefined && pos.start.y >= b.outputStart && endY <= (b.outputEnd ?? Infinity)) cmd = shownCommand(b);
      }
      copy(fenceText(text, cmd), 'Copied as Markdown');
    },
  };
  live = handle;
  return handle;
}

/** Feature 26: scrolled up into a command's output, its command (through `safeCommand`) and its exit mark stay on top; a click goes to its prompt. */
export function StickyHeader(): VNode | null {
  const s = sticky.value;
  if (!s) return null;
  return (
    <button class="sticky-cmd" data-state={s.state} title="Go to its prompt" onClick={() => s.go()}>
      <span class="sticky-mark" />
      <span class="sticky-text">{s.label}</span>
    </button>
  );
}

function Menu({ x, y, items, done }: { x: number; y: number; items: MenuItem[]; done(): void }): VNode {
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    ctxMenu.value = null;
    done();
  };
  // (a layout effect: a click right after the menu opened must already find these listeners)
  useLayoutEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close());
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', away, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', away, true);
    };
  }, []);
  return (
    <div class="ctx-menu" role="menu" ref={ref} style={{ left: `${Math.min(x, window.innerWidth - 200)}px`, top: `${Math.min(y, window.innerHeight - 40 * items.length)}px` }}>
      {items.map((i) => (
        <button key={i.label} role="menuitem" onClick={() => (close(), i.run())}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

/** Feature 8: the gutter mark's menu (a small menu of the window's own, not a native one). Esc or a click elsewhere closes it. */
export function BlockMenu(): VNode | null {
  const m = ctxMenu.value;
  return m ? <Menu key={`${m.x},${m.y}`} {...m} /> : null;
}
