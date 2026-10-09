import type { UpdateState } from '../shared/update-policy';

export interface JafferBridge {
  call<T = any>(method: string, params?: unknown): Promise<T>;
  onEvent(cb: (event: string, data: any) => void): () => void;
  onMenu(cb: (id: string) => void): () => void;
  onFocus(cb: (focused: boolean) => void): () => void;
  openExternal(url: string): Promise<void>;
  /** Opens Jaffer's own folder in Finder (never a path the page names). */
  reveal(): Promise<void>;
  appInfo(): Promise<{ version: string; platform: string; dark: boolean; home: string; packaged: boolean; openAtLogin: boolean }>;
  setLoginItem(on: boolean): Promise<void>;
  updates: { state(): Promise<UpdateState>; check(): Promise<UpdateState> };
  /** Start over (the app asks first; true when the person said no and nothing changed). */
  reset(): Promise<{ cancelled: boolean }>;
  /** Restart the shell in the same folder and take the Claude Code conversation up again (the app asks first; `resumable`: one comes back). */
  restartClaude(): Promise<{ cancelled: boolean; resumable?: boolean }>;
  pathForFile(f: File): string;
  platform: string;
}

declare global {
  interface Window {
    jaffer: JafferBridge;
  }
}
