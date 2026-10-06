import { contextBridge, ipcRenderer, webUtils } from 'electron';

/** The only surface the renderer gets: typed RPC to the daemon plus a few native helpers. */
contextBridge.exposeInMainWorld('jaffer', {
  call: (method: string, params?: unknown) => ipcRenderer.invoke('jaffer:call', method, params),
  onEvent: (cb: (event: string, data: unknown) => void) => {
    const h = (_e: unknown, event: string, data: unknown) => cb(event, data);
    ipcRenderer.on('jaffer:event', h);
    return () => ipcRenderer.removeListener('jaffer:event', h);
  },
  onMenu: (cb: (id: string) => void) => {
    const h = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('jaffer:menu', h);
    return () => ipcRenderer.removeListener('jaffer:menu', h);
  },
  onFocus: (cb: (focused: boolean) => void) => {
    const h = (_e: unknown, f: boolean) => cb(f);
    ipcRenderer.on('jaffer:focus', h);
    return () => ipcRenderer.removeListener('jaffer:focus', h);
  },
  notify: (title: string, body: string) => ipcRenderer.invoke('jaffer:notify', title, body),
  openExternal: (url: string) => ipcRenderer.invoke('jaffer:open-external', url),
  reveal: (p: string) => ipcRenderer.invoke('jaffer:reveal', p),
  appInfo: () => ipcRenderer.invoke('jaffer:app-info'),
  setLoginItem: (on: boolean) => ipcRenderer.invoke('jaffer:set-login-item', on),
  pathForFile: (f: File) => {
    try {
      return webUtils.getPathForFile(f);
    } catch {
      return '';
    }
  },
  platform: process.platform,
});
