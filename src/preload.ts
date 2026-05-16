import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './shared/types';
import type {
  AuthStatus,
  ChatConnection,
  ChatMessage,
  ConnectionState,
  Settings,
} from './shared/types';

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
  /**
   * Force-reconnect the chat WebSocket. Triggered by the toolbar refresh
   * button. Main process refreshes the OAuth token first if expired, then
   * tears down + reopens the socket. Returns ok=true on success, or
   * ok=false + reason on failure (reason='not-authenticated' or 'error').
   */
  reconnect: (): Promise<
    { ok: true } | { ok: false; reason: 'not-authenticated' | 'error'; error?: string }
  > => ipcRenderer.invoke(IPC.CONN_RECONNECT),
  onChatMessage: (cb: (m: ChatMessage) => void): Unsub => {
    const h = (_: unknown, m: ChatMessage) => cb(m);
    ipcRenderer.on(IPC.CHAT_MESSAGE, h);
    return () => ipcRenderer.removeListener(IPC.CHAT_MESSAGE, h);
  },
  /**
   * Pull-fetch the latest snapshot of Restream `connection_info` entries
   * (one per platform/channel currently linked + a status). The renderer
   * calls this on mount so it doesn't have to wait for the next push.
   */
  getConnections: (): Promise<ChatConnection[]> =>
    ipcRenderer.invoke(IPC.CONNECTIONS_GET),
  /**
   * Subscribe to live updates of the connections list. Fires whenever a
   * `connection_info` or `connection_closed` frame changes the in-memory
   * map. Renderer uses this to drive the channels panel.
   */
  onConnections: (cb: (cs: ChatConnection[]) => void): Unsub => {
    const h = (_: unknown, cs: ChatConnection[]) => cb(cs);
    ipcRenderer.on(IPC.CONNECTIONS, h);
    return () => ipcRenderer.removeListener(IPC.CONNECTIONS, h);
  },
  /**
   * Pop the official Restream webchat in a separate BrowserWindow so the
   * user can compose + send a chat reply. Restream's public WS Chat API is
   * read-only (see Chat docs); the webchat uses an internal API to send
   * and the reply comes back as a `reply_created` WS frame which our
   * normaliser surfaces as a `self: true` ChatMessage in the feed.
   */
  openCompose: (): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: 'not-authenticated' | 'webchat-fetch-failed' | 'no-webchat-url' | 'error';
        status?: number;
        error?: string;
      }
  > => ipcRenderer.invoke(IPC.CHAT_OPEN_COMPOSE),
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
