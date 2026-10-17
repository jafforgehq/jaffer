import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { VNode } from 'preact';
import { effect } from '@preact/signals';
import { activePane, activeTheme, cfg, currentClaude, focusMode, hour, openOverlay, overlay, ready, appVersion, systemDark, togglePanel, turnDone } from './state';
import { onMenu } from './actions';
import { PaneTree } from './components/PaneTree';
import { Pet } from './components/Pet';
import { DaemonBanner, TitleBar, Toasts } from './components/Chrome';
import { ToolStrip } from './components/ToolStrip';
import { SidePanel } from './components/SidePanel';
import { FindBar, Glossary, Onboarding, Palette, PasteBar, Pins, RecentCommands, Settings, ShortcutsSheet } from './components/Overlays';
import { Tour } from './components/Tour';
import { BlockMenu, StickyHeader } from './components/Blocks';
import { cssVars, windowOpacity } from './themes';

let shownTheme = '';
let fadeTimer: ReturnType<typeof setTimeout> | undefined;

function applyTheme(): void {
  const c = cfg.value;
  if (!c) return;
  const th = activeTheme();
  const vars = cssVars(th, windowOpacity(c.appearance));
  const root = document.documentElement;
  // Follow macOS / time of day: the big surfaces fade into the other theme for a second (the terminal's own colours switch at once; CSS
  // stops the fade under Reduce motion, and Animations off does not start it)
  if (shownTheme && shownTheme !== th.id && c.appearance.autoTheme !== 'off' && c.appearance.animations !== false) {
    root.classList.add('theme-fade');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => root.classList.remove('theme-fade'), 1100);
  }
  shownTheme = th.id;
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

/** Writes `data-glow` on the stage from its own signals effect, so a claude.state push does not re-render the whole window. */
function StageGlow(): null {
  useLayoutEffect(() => {
    const stage = document.querySelector<HTMLElement>('.stage');
    return effect(() => {
      const g = glow();
      if (!stage) return;
      if (g) stage.dataset.glow = g;
      else delete stage.dataset.glow;
    });
  }, []);
  return null;
}

export function App(): VNode | null {
  useEffect(() => effect(applyTheme), []);
  // what Follow macOS / time of day reads: macOS's appearance while it follows that, the hour (now, and every five minutes) while it follows the clock
  const auto = cfg.value?.appearance?.autoTheme;
  useEffect(() => {
    if (auto === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const on = () => (systemDark.value = mq.matches);
      on();
      mq.addEventListener('change', on);
      return () => mq.removeEventListener('change', on);
    }
    if (auto === 'time') {
      const on = () => (hour.value = new Date().getHours());
      on();
      const t = setInterval(on, 300_000);
      return () => clearInterval(t);
    }
  }, [auto]);
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
      else if (k === 'b' && !e.shiftKey) (e.preventDefault(), e.repeat || togglePanel('key')); // (⌘B held down: one toggle, not a flapping panel)
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
    <div class="app" data-focus={focusMode.value ? '1' : undefined}>
      <div class="stage">
        <StageGlow />
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
          <SidePanel />
        </div>
      </div>
      <BlockMenu />
      <Toasts />
      {overlay.value === 'palette' && <Palette />}
      {overlay.value === 'recent' && <RecentCommands />}
      {overlay.value === 'keys' && <ShortcutsSheet />}
      {overlay.value === 'settings' && <Settings />}
      {overlay.value === 'onboarding' && <Onboarding />}
      {overlay.value === 'learn' && <Glossary />}
      {overlay.value === 'tour' && <Tour />}
    </div>
  );
}

