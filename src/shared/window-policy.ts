/** What the window may navigate to and what a program in the terminal may ask of the clipboard. Pure, so it is tested. */

/** Is this the app's own page? Only that: any other file:// page, such as one dropped on the window, would get the daemon bridge. */
export function isAppUrl(url: string | undefined, indexUrl: string): boolean {
  if (!url) return false;
  try {
    const a = new URL(url);
    const b = new URL(indexUrl);
    return a.protocol === 'file:' && b.protocol === 'file:' && decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname);
  } catch {
    return false;
  }
}

export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);

export interface Osc52Provider {
  readText(selection: string): Promise<string>;
  writeText(selection: string, text: string): Promise<void>;
}

/**
 * A program in the terminal may put text on the clipboard (OSC 52, handy over ssh) but may never read it back: whatever you last
 * copied (a password, a token) would go to the remote machine or to whatever `cat` printed the request.
 */
export function osc52Provider(write: (text: string) => Promise<void>): Osc52Provider {
  return {
    readText: async () => '',
    writeText: async (selection, text) => {
      if (selection === 'c') await write(text);
    },
  };
}

/** The window's vibrancy for the config: macOS blurs what is behind it, unless Settings → Appearance → Blur is off. */
export function vibrancyFor(cfg: { appearance?: { blur?: boolean } }): 'under-window' | null {
  return cfg.appearance?.blur === false ? null : 'under-window';
}

type AppearanceCfg = { appearance?: { blur?: boolean; systemStats?: boolean }; [other: string]: unknown };
/** Which of the settings the main process applies itself changed from `prev` to `next` (a value not known yet is its default). */
export function appearanceChanged(prev: AppearanceCfg, next: AppearanceCfg): { blur: boolean; systemStats: boolean } {
  return { blur: vibrancyFor(prev) !== vibrancyFor(next), systemStats: (prev.appearance?.systemStats === true) !== (next.appearance?.systemStats === true) };
}
