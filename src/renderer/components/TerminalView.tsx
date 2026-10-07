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
import { activePane, cfg, overlay, ptyBus, windowFocused, daemonUp } from '../state';
import { themeById, xtermTheme } from '../themes';

/** Registry so menus, the palette and the find bar can reach a pane's terminal. */
export interface TermHandle {
  term: Terminal;
  search: SearchAddon;
  focus(): void;
  clear(): void;
  paste(text: string): void;
  type(text: string): void;
}
export const terminals = new Map<string, TermHandle>();

const call = <T = any,>(m: string, p?: unknown) => window.jaffer.call<T>(m, p);

function shellQuote(p: string): string {
  return /^[A-Za-z0-9_./~@%+=:,-]+$/.test(p) ? p : p.replace(/([^A-Za-z0-9_./~@%+=:,-])/g, '\\$1');
}

export function TerminalView({ pane }: { pane: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const c = cfg.value!;
    const a = c.appearance;
    const theme = themeById(a.theme);
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
      theme: xtermTheme(theme, a.opacity),
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
    try {
      term.loadAddon(new ImageAddon());
    } catch {
      /* images are optional */
    }
    term.open(el);

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
      } else if (event === 'pty.reset') {
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
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 20 && el.clientHeight > 20) {
        try {
          fit.fit();
        } catch {
          /* detached */
        }
      }
    });
    ro.observe(el);

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
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') return true;
        return false; // let menu accelerators (copy, paste, split…) win
      }
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
    };
    terminals.set(pane, handle);

    // Live-apply appearance changes.
    const stop = effect(() => {
      const ap = cfg.value?.appearance;
      if (!ap) return;
      const th = themeById(ap.theme);
      term.options.theme = xtermTheme(th, ap.opacity);
      term.options.fontFamily = ap.fontFamily;
      term.options.fontSize = ap.fontSize;
      term.options.lineHeight = ap.lineHeight;
      term.options.cursorStyle = ap.cursorStyle;
      term.options.cursorBlink = ap.cursorBlink;
      term.options.macOptionIsMeta = ap.optionAsMeta;
      term.options.scrollback = ap.scrollback;
      requestAnimationFrame(() => {
        try {
          fit.fit();
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
      off();
      ro.disconnect();
      el.removeEventListener('drop', onDrop);
      el.removeEventListener('dragover', onDragOver);
      terminals.delete(pane);
      void call('session.detach', {}).catch(() => undefined);
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
