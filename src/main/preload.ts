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
  openExternal: (url: string) => ipcRenderer.invoke('jaffer:open-external', url),
  reveal: () => ipcRenderer.invoke('jaffer:reveal'),
  appInfo: () => ipcRenderer.invoke('jaffer:app-info'),
  setLoginItem: (on: boolean) => ipcRenderer.invoke('jaffer:set-login-item', on),
  reset: () => ipcRenderer.invoke('jaffer:reset'),
  restartClaude: () => ipcRenderer.invoke('jaffer:restart-claude'),
  keepRunningOff: () => ipcRenderer.invoke('jaffer:keep-running-off'),
  updates: {
    state: () => ipcRenderer.invoke('jaffer:update-state'),
    check: () => ipcRenderer.invoke('jaffer:update-check'),
  },
  pathForFile: (f: File) => {
    try {
      return webUtils.getPathForFile(f);
    } catch {
      return '';
    }
  },
  platform: process.platform,
});
