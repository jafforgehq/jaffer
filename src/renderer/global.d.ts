import type { UpdateState } from '../shared/update-policy';

export interface JafferBridge {
  call<T = any>(method: string, params?: unknown): Promise<T>;
  onEvent(cb: (event: string, data: any) => void): () => void;
  onMenu(cb: (id: string) => void): () => void;
  onFocus(cb: (focused: boolean) => void): () => void;
  notify(title: string, body: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  reveal(path: string): Promise<void>;
  appInfo(): Promise<{ version: string; platform: string; dark: boolean; home: string; packaged: boolean }>;
  setLoginItem(on: boolean): Promise<void>;
  updates: { state(): Promise<UpdateState>; check(): Promise<UpdateState> };
  /** Start over (the app asks first; true when the person said no and nothing changed). */
  reset(): Promise<{ cancelled: boolean }>;
  pathForFile(f: File): string;
  platform: string;
}

declare global {
  interface Window {
    jaffer: JafferBridge;
  }
}
