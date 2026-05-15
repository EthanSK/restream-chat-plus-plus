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
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (s: Settings): Promise<Settings> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, s),
  notify: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.NOTIFY, { title, body }),
};

contextBridge.exposeInMainWorld('rcpp', api);

export type RcppApi = typeof api;
