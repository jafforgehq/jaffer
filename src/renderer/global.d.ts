import type { UpdateState } from '../shared/update-policy';
import type { TrashResult } from '../main/trash-conversations';

export interface JafferBridge {
  call<T = any>(method: string, params?: unknown): Promise<T>;
  onEvent(cb: (event: string, data: any) => void): () => void;
  onMenu(cb: (id: string) => void): () => void;
  onFocus(cb: (focused: boolean) => void): () => void;
  /** CPU and memory in use (0..1), every 5 s while Settings → Appearance → System stats is on. */
  onSystemStats(cb: (s: { cpu: number; mem: number }) => void): () => void;
  openExternal(url: string): Promise<void>;
  /** Opens Jaffer's own folder in Finder (never a path the page names). */
  reveal(): Promise<void>;
  appInfo(): Promise<{ version: string; platform: string; dark: boolean; home: string; packaged: boolean; openAtLogin: boolean }>;
  setLoginItem(on: boolean): Promise<void>;
  /** Focus mode (⌥⌘F): the app holds its notifications while it is on, and says in one line what it held when it ends. */
  setFocusMode(on: boolean): Promise<void>;
  /** "Save output…": the app asks where (a save dialog) and writes the text there; nothing is kept. At most 32 MB. */
  saveText(text: string, name: string): Promise<{ saved: boolean }>;
  /** ⌘-click on a printed path: an absolute path that exists opens in the editor of Settings → Terminal, or is revealed in Finder; nothing runs. */
  openPath(p: { path: string; line?: number; col?: number }): Promise<{ opened: boolean; editorFailed?: boolean }>;
  /** Selects an existing file in Finder (never opens it). */
  revealPath(path: string): Promise<{ revealed: boolean }>;
  /** Moves these past conversations to the Trash, after the app's own question (at most 200; a running one is refused). */
  trashConversations(ids: string[]): Promise<TrashResult>;
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
