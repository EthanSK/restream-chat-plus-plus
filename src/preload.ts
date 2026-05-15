import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './shared/types';
import type { AuthStatus, ChatMessage, ConnectionState, Settings } from './shared/types';

type Unsub = () => void;

const api = {
  authStart: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.AUTH_START),
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.AUTH_STATUS),
  authLogout: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  onAuthStatus: (cb: (s: AuthStatus) => void): Unsub => {
    const h = (_: unknown, s: AuthStatus) => cb(s);
    ipcRenderer.on(IPC.AUTH_STATUS, h);
    return () => ipcRenderer.removeListener(IPC.AUTH_STATUS, h);
  },
  onConnectionState: (cb: (s: ConnectionState) => void): Unsub => {
    const h = (_: unknown, s: ConnectionState) => cb(s);
    ipcRenderer.on(IPC.CONN_STATE, h);
    return () => ipcRenderer.removeListener(IPC.CONN_STATE, h);
  },
  /**
   * Pull-fetch the current connection state. The push channel
   * (onConnectionState) only delivers UPDATES; if the WebSocket already
   * transitioned to 'connecting' / 'connected' BEFORE the renderer mounted
   * its listener, the renderer would otherwise be stuck on its initial
   * 'idle' placeholder. Calling this on mount syncs the renderer to truth.
   */
  connectionState: (): Promise<ConnectionState> =>
    ipcRenderer.invoke(IPC.CONN_STATE_GET),
  onChatMessage: (cb: (m: ChatMessage) => void): Unsub => {
    const h = (_: unknown, m: ChatMessage) => cb(m);
    ipcRenderer.on(IPC.CHAT_MESSAGE, h);
    return () => ipcRenderer.removeListener(IPC.CHAT_MESSAGE, h);
  },
  onMenuOpenSettings: (cb: () => void): Unsub => {
    const h = () => cb();
    ipcRenderer.on('menu:open-settings', h);
    return () => ipcRenderer.removeListener('menu:open-settings', h);
  },
  onMenuRevealLogs: (cb: () => void): Unsub => {
    const h = () => cb();
    ipcRenderer.on('menu:reveal-logs', h);
    return () => ipcRenderer.removeListener('menu:reveal-logs', h);
  },
  revealLogs: (): Promise<boolean> => ipcRenderer.invoke(IPC.REVEAL_LOGS),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (s: Settings): Promise<Settings> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, s),
  notify: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.NOTIFY, { title, body }),
};

contextBridge.exposeInMainWorld('rcpp', api);

export type RcppApi = typeof api;
