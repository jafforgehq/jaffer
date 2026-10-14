import { useEffect, useRef } from 'preact/hooks';
import type { VNode } from 'preact';
import { effect } from '@preact/signals';
import { activePane, cfg, currentClaude, openOverlay, overlay, ready, appVersion, turnDone } from './state';
import { onMenu } from './actions';
import { PaneTree } from './components/PaneTree';
import { Pet } from './components/Pet';
import { DaemonBanner, TitleBar, Toasts } from './components/Chrome';
import { ToolStrip } from './components/ToolStrip';
import { FindBar, Onboarding, Palette, PasteBar, Pins, RecentCommands, Settings } from './components/Overlays';
import { BlockMenu, StickyHeader } from './components/Blocks';
import { cssVars, themeById } from './themes';

function applyTheme(): void {
  const c = cfg.value;
  if (!c) return;
  const th = themeById(c.appearance.theme);
  const vars = cssVars(th, c.appearance.opacity);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = th.dark ? 'dark' : 'light'; // native controls (scrollbars, selects, date pickers) follow the theme
  root.dataset.motion = c.appearance.animations === false ? 'off' : 'on';
}

/** The window's edge glows while Claude needs you or works, and flashes once when a turn ends (Settings → Appearance → Window glow; never with Animations off). */
function glow(): string | undefined {
  const a = cfg.value?.appearance;
  if (!a || a.glow === false || a.animations === false) return undefined;
  const s = currentClaude()?.state;
  return s === 'needs-you' ? 'needs' : s === 'working' ? 'work' : turnDone.value ? 'done' : undefined;
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
      if (k === 'p' && !e.shiftKey) (e.preventDefault(), overlay.value === 'palette' ? (overlay.value = null) : openOverlay('palette'));
      else if (k === ',') (e.preventDefault(), openOverlay('settings'));
      else if (k === 'f' && !e.shiftKey) (e.preventDefault(), openOverlay('find'));
    };
    window.addEventListener('keydown', key);
    return () => {
      off.current?.();
      window.removeEventListener('keydown', key);
    };
  }, []);

  if (!ready.value || !cfg.value) return <div class="boot">Starting your session…</div>;
  void activePane.value;
  void appVersion.value;
  return (
    <div class="app">
      <div class="stage" data-glow={glow()}>
        <TitleBar />
        <ToolStrip />
        <DaemonBanner />
        <div class="workspace">
          <div class="terminal-area">
            <Pins />
            <PaneTree />
            <StickyHeader />
            <Pet />
            <PasteBar />
            {overlay.value === 'find' && <FindBar />}
          </div>
        </div>
      </div>
      <BlockMenu />
      <Toasts />
      {overlay.value === 'palette' && <Palette />}
      {overlay.value === 'recent' && <RecentCommands />}
      {overlay.value === 'settings' && <Settings />}
      {overlay.value === 'onboarding' && <Onboarding />}
    </div>
  );
}

