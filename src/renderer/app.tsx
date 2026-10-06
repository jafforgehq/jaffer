import { useEffect, useRef } from 'preact/hooks';
import type { VNode } from 'preact';
import { effect } from '@preact/signals';
import { activePane, cfg, overlay, ready, railOpen, setSide, setSideWidth, side, sideWidth, toggleRail, toggleSide, appVersion } from './state';
import { onMenu } from './actions';
import { PaneTree } from './components/PaneTree';
import { AgentPanel } from './components/AgentPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { SessionRail } from './components/SessionRail';
import { DaemonBanner, StatusBar, TitleBar, Toasts } from './components/Chrome';
import { FindBar, Onboarding, Palette, Settings } from './components/Overlays';
import { cssVars, themeById } from './themes';

function applyTheme(): void {
  const c = cfg.value;
  if (!c) return;
  const th = themeById(c.appearance.theme);
  const vars = cssVars(th, c.appearance.opacity);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = th.dark ? 'dark' : 'light';
}

function SideResizer(): VNode {
  const down = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideWidth.value;
    const move = (ev: PointerEvent) => setSideWidth(startW - (ev.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div class="side-resizer" onPointerDown={down} />;
}

export function App(): VNode | null {
  useEffect(() => effect(applyTheme), []);
  const off = useRef<(() => void) | null>(null);

  useEffect(() => {
    off.current = window.jaffer.onMenu(onMenu);
    // ⌘P and friends also work from the keyboard directly, and in the browser dev bridge (no native menu).
    const key = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'p' && !e.shiftKey) (e.preventDefault(), (overlay.value = overlay.value === 'palette' ? null : 'palette'));
      else if (k === 'j') (e.preventDefault(), toggleSide('agent'));
      else if (k === 'b' && !e.shiftKey) (e.preventDefault(), toggleRail());
      else if (k === 'm' && e.shiftKey) (e.preventDefault(), toggleSide('memory'));
      else if (k === ',') (e.preventDefault(), (overlay.value = 'settings'));
      else if (k === 'f' && !e.shiftKey) (e.preventDefault(), (overlay.value = 'find'));
    };
    window.addEventListener('keydown', key);
    return () => {
      off.current?.();
      window.removeEventListener('keydown', key);
    };
  }, []);

  if (!ready.value || !cfg.value) return <div class="boot">Starting your session…</div>;
  const s = side.value;
  void activePane.value;
  void appVersion.value;
  return (
    <div class={`app ${railOpen.value ? 'rail-open' : ''}`}>
      {railOpen.value && <SessionRail />}
      <div class="stage">
        <TitleBar />
        <DaemonBanner />
        <div class="workspace">
          <div class="terminal-area">
            <PaneTree />
            {overlay.value === 'find' && <FindBar />}
          </div>
          {s && (
            <aside class="side" style={{ width: `${sideWidth.value}px` }}>
              <SideResizer />
              {s === 'agent' ? <AgentPanel /> : <MemoryPanel />}
            </aside>
          )}
        </div>
        <StatusBar />
      </div>
      <Toasts />
      {overlay.value === 'palette' && <Palette />}
      {overlay.value === 'settings' && <Settings />}
      {overlay.value === 'onboarding' && <Onboarding />}
    </div>
  );
}

void setSide;
