import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ImageAddon } from '@xterm/addon-image';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { osc52Provider } from '../../shared/window-policy';
import '@xterm/xterm/css/xterm.css';
import { activePane, activeTheme, cfg, firstLine, homeDir, layoutHold, lineCount, overlay, paneInfo, pasteAsk, port, ptyBus, toast, windowFocused, daemonUp } from '../state';
import { findPaths, type FoundPath } from '../../shared/find-paths';
import { findPorts } from '../../shared/find-ports';
import { redactText } from '../../shared/redact';
import { isClaudeCommand } from '../../shared/process-badge';
import { windowOpacity, xtermTheme } from '../themes';
import { attachBlocks, type BlocksHandle } from './Blocks';

/** Registry so menus, the palette and the find bar can reach a pane's terminal. */
export interface TermHandle {
  term: Terminal;
  search: SearchAddon;
  focus(): void;
  clear(): void;
  paste(text: string): void;
  type(text: string): void;
  /** Command blocks: prompts to jump between, a selection to copy as Markdown. */
  blocks: BlocksHandle;
}
export const terminals = new Map<string, TermHandle>();

/** Search highlights; their colours also mark the matches on the overview ruler. */
export const FIND_OPTS = { decorations: { matchBackground: '#ffcc0055', matchOverviewRuler: '#ffcc00', activeMatchBackground: '#ff8a4c88', activeMatchColorOverviewRuler: '#ff8a4c' } };

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

/** `base` joined with a relative path, `.` and `..` resolved (no file system: the app checks that the result exists). */
function joinPath(base: string, rel: string): string {
  const parts: string[] = [];
  for (const p of `${base}/${rel}`.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return '/' + parts.join('/');
}

/** Feature 11: a printed path, absolute (relative ones against that terminal's folder, `~` against home). */
function resolvePath(p: string, pane: string): string | null {
  if (p.startsWith('/')) return joinPath('/', p);
  const home = homeDir();
  if (p.startsWith('~/')) return home ? joinPath(home, p.slice(2)) : null;
  const cwd = paneInfo.value[pane]?.cwd;
  return cwd ? joinPath(cwd, p) : null;
}

function openFound(f: FoundPath, pane: string): void {
  const abs = resolvePath(f.path, pane);
  if (!abs) return;
  void window.jaffer.openPath({ path: abs, line: f.line, col: f.col }).then(
    (r) => r.opened || toast({ kind: 'info', text: r.editorFailed ? 'Could not open the editor link' : 'No file there.' }, 3000),
    () => undefined,
  );
}

function shellQuote(p: string): string {
  return /^[A-Za-z0-9_./~@%+=:,-]+$/.test(p) ? p : p.replace(/([^A-Za-z0-9_./~@%+=:,-])/g, '\\$1');
}

export function TerminalView({ pane }: { pane: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const c = cfg.value!;
    const a = c.appearance;
    const theme = activeTheme();
    const term = new Terminal({
      fontFamily: a.fontFamily,
      fontSize: a.fontSize,
      lineHeight: a.lineHeight,
      cursorStyle: a.cursorStyle,
      cursorBlink: a.cursorBlink,
      scrollback: a.scrollback,
      macOptionIsMeta: a.optionAsMeta,
      allowTransparency: true,
      allowProposedApi: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      overviewRuler: { width: 10 }, // search matches are marked there
      theme: xtermTheme(theme, windowOpacity(a)),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey) void window.jaffer.openExternal(uri);
      }),
    );
    // OSC 52: a program (ssh, a script) may put text on the clipboard but never read back what you copied
    term.loadAddon(new ClipboardAddon(undefined, osc52Provider((text) => navigator.clipboard.writeText(text))));
    // Pictures programs print (sixel, iTerm's inline images): Settings → Terminal → Inline images, live
    let images: ImageAddon | null = null;
    const syncImages = () => {
      const want = cfg.value?.terminal?.images !== false;
      if (want && !images) {
        try {
          images = new ImageAddon();
          term.loadAddon(images);
        } catch {
          images = null; /* images are optional */
        }
      } else if (!want && images) {
        images.dispose();
        images = null;
      }
    };
    syncImages();
    term.open(el);

    // ⌘-click on a printed file path (one buffer line at a time; the finder reads a bounded head): an editor or Finder, never run
    term.registerLinkProvider({
      provideLinks(y, done) {
        const line = term.buffer.active.getLine(y - 1);
        const text = line?.translateToString(true) ?? '';
        const found = findPaths(text);
        if (!line || !found.length) return done(undefined);
        const cellOf: number[] = []; // the cell of each character of `text` (a wide character takes two cells)
        for (let x = 0, cell = line.getCell(0); x < line.length; x++) {
          cell = line.getCell(x, cell);
          if (!cell || cell.getWidth() === 0) continue;
          for (let i = 0; i < (cell.getChars() || ' ').length; i++) cellOf.push(x);
        }
        done(
          found.map((f) => ({
            range: { start: { x: (cellOf[f.start] ?? f.start) + 1, y }, end: { x: (cellOf[f.end - 1] ?? f.end - 1) + 1, y } },
            text: text.slice(f.start, f.end),
            activate: (ev: MouseEvent) => ev.metaKey && openFound(f, pane),
          })),
        );
      },
    });

    // Pasting several lines asks first (Settings → Terminal); a dropped file is not a paste and is unchanged
    const onPaste = (e: ClipboardEvent) => {
      if (cfg.value?.terminal?.pasteGuard === false) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const lines = lineCount(text);
      if (lines < 2) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pasteAsk.value = { text, lines, first: redactText(firstLine(text)).slice(0, 80) };
    };
    el.addEventListener('paste', onPaste, true);

    // Feature 25: a faint line at a column
    const ruler = document.createElement('div');
    ruler.className = 'col-ruler';
    el.appendChild(ruler);
    const placeRuler = () => {
      const at = cfg.value?.terminal?.ruler ?? 0;
      const screen = el.querySelector('.xterm-screen');
      ruler.hidden = ![80, 100, 120].includes(at) || !screen || at > term.cols;
      if (ruler.hidden || !screen) return;
      const s = screen.getBoundingClientRect();
      ruler.style.left = `${s.left - el.getBoundingClientRect().left + (s.width / term.cols) * at}px`;
    };
    term.onResize(() => requestAnimationFrame(placeRuler));

    let webgl: WebglAddon | null = null;
    const forced = new URLSearchParams(location.search).get('renderer');
    try {
      if ((forced ?? c.appearance.renderer) === 'dom') throw new Error('dom renderer requested');
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      /* falls back to the DOM renderer */
    }

    const blocks = attachBlocks(term, pane);

    let attached = false;
    let snapshotSeq = -1;
    let lastSeq = -1;
    let disposed = false;
    const pending: { seq: number; data: string }[] = [];

    const write = (data: string) => term.write(data);

    const attach = async () => {
      attached = false;
      pending.length = 0;
      fit.fit();
      try {
        const r = await call('session.attach', { pane, cols: term.cols, rows: term.rows });
        if (disposed) return;
        blocks.reset(); // the snapshot carries no marks: blocks start again from here
        term.reset();
        term.write(r.snapshot.data);
        snapshotSeq = lastSeq = r.snapshot.seq;
        attached = true;
        for (const p of pending.splice(0)) if (p.seq > snapshotSeq) apply(p.seq, p.data);
        if (activePane.value === pane && !overlay.value) term.focus();
      } catch (e) {
        term.write(`\r\n\x1b[31mCould not attach to the session: ${e instanceof Error ? e.message : e}\x1b[0m\r\n`);
      }
    };

    const apply = (seq: number, data: string) => {
      if (seq !== lastSeq + 1 && lastSeq >= 0) {
        // A gap means we missed output; resync from a fresh snapshot rather than show a corrupted screen.
        void attach();
        return;
      }
      lastSeq = seq;
      write(data);
    };

    const off = ptyBus.on(({ event, data }) => {
      if (event === 'daemon.up') {
        void attach();
        return;
      }
      if (data?.pane !== pane) return;
      if (event === 'pty.data') {
        if (!attached) pending.push({ seq: data.seq, data: data.data });
        else if (data.seq > snapshotSeq) apply(data.seq, data.data);
        // Feature 37: a local server the focused terminal's running command prints (not inside a full-screen program, and not Claude Code's own screen,
        // which it draws in the normal buffer); the finder reads a bounded head
        const busy = paneInfo.value[pane]?.busy;
        if (busy && pane === activePane.value && !isClaudeCommand(busy) && cfg.value?.terminal?.portLinks !== false && term.buffer.active.type !== 'alternate') {
          const found = findPorts(data.data);
          if (found.length) port.value = found.at(-1)!;
        }
      } else if (event === 'pty.reset') {
        blocks.reset();
        term.reset();
        term.write(data.snapshot.data);
        snapshotSeq = lastSeq = data.snapshot.seq;
      } else if (event === 'pty.bell') {
        el.classList.add('bell');
        setTimeout(() => el.classList.remove('bell'), 160);
      }
    });

    term.onData((d) => void call('pty.write', { pane, data: d }).catch(() => undefined));
    term.onBinary((d) => void call('pty.write', { pane, data: d }).catch(() => undefined));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void call('pty.resize', { pane, cols, rows }).catch(() => undefined), 50);
    });
    const refit = () => {
      if (el.clientWidth > 20 && el.clientHeight > 20 && !layoutHold.value) {
        try {
          fit.fit();
          placeRuler();
        } catch {
          /* detached */
        }
      }
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    // while the side panel's edge is dragged the terminal keeps its size; let go, it fits once (one pty.resize, not one per pixel)
    const stopHold = effect(() => void (!layoutHold.value && requestAnimationFrame(refit)));

    // macOS editing conventions and Claude Code's multi-line input.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const send = (s: string) => {
          void call('pty.write', { pane, data: s }).catch(() => undefined);
          return false;
        };
        if (ev.key === 'Backspace') return send('\x15'); // delete to line start
        if (ev.key === 'ArrowLeft') return send('\x01');
        if (ev.key === 'ArrowRight') return send('\x05');
        return false; // let menu accelerators (copy, paste, ⌘↑/⌘↓ between prompts…) win
      }
      if (ev.metaKey && ev.altKey && !ev.ctrlKey) return false; // ⌥⌘C (copy as Markdown) is the menu's
      if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        void call('pty.write', { pane, data: '\x1b\r' }).catch(() => undefined); // newline in Claude Code, shell prompts and editors alike
        return false;
      }
      return true;
    });

    // Drag files/folders onto the terminal to paste their (escaped) paths.
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      const paths = files.map((f) => window.jaffer.pathForFile(f)).filter(Boolean);
      if (paths.length) {
        term.paste(paths.map(shellQuote).join(' ') + ' ');
        term.focus();
      }
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('mousedown', () => (activePane.value = pane));

    const handle: TermHandle = {
      term,
      search,
      focus: () => term.focus(),
      clear: () => {
        void call('pty.write', { pane, data: '\x0c' }).catch(() => undefined);
        term.clear();
      },
      paste: (t) => term.paste(t),
      type: (t) => void call('pty.write', { pane, data: t }).catch(() => undefined),
      blocks,
    };
    terminals.set(pane, handle);

    // Live-apply appearance changes.
    const stop = effect(() => {
      const ap = cfg.value?.appearance;
      if (!ap) return;
      term.options.theme = xtermTheme(activeTheme(), windowOpacity(ap));
      term.options.fontFamily = ap.fontFamily;
      term.options.fontSize = ap.fontSize;
      term.options.lineHeight = ap.lineHeight;
      term.options.cursorStyle = ap.cursorStyle;
      term.options.cursorBlink = ap.cursorBlink;
      term.options.macOptionIsMeta = ap.optionAsMeta;
      term.options.scrollback = ap.scrollback;
      syncImages();
      requestAnimationFrame(() => {
        try {
          fit.fit();
          placeRuler();
        } catch {
          /* not visible */
        }
      });
    });
    const stopFocus = effect(() => {
      if (activePane.value === pane && !overlay.value && windowFocused.value && daemonUp.value) term.focus();
    });

    void document.fonts.ready.then(() => !disposed && void attach());

    return () => {
      disposed = true;
      stop();
      stopFocus();
      stopHold();
      off();
      ro.disconnect();
      el.removeEventListener('drop', onDrop);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('paste', onPaste, true);
      if (terminals.get(pane) === handle) terminals.delete(pane); // (an id opened again after a close has a new view already)
      blocks.dispose();
      void call('session.detach', { pane }).catch(() => undefined); // (this terminal only: the others stay attached)
      try {
        webgl?.dispose();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [pane]);

  return <div class="term" ref={host} data-pane={pane} />;
}
