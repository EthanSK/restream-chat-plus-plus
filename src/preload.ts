import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './shared/types';
import type {
  AuthStatus,
  ChatConnection,
  ChatMessage,
  ConnectionState,
  SendTextResult,
  Settings,
  UpdateInfo,
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
  /**
   * Send a chat reply inline via Restream's internal
   * `POST /api/v2/client/reply` endpoint. The reply gets broadcast back as
   * a `reply_created` WS frame which surfaces in the feed as a
   * `self: true` ChatMessage — no optimistic rendering needed.
   *
   * The first call (cold start) MAY auto-spawn an invisible Compose window
   * to provision chat-session cookies in the `persist:restream-oauth`
   * partition; subsequent sends are pure fetch + cookies.
   */
  sendChatText: (text: string): Promise<SendTextResult> =>
    ipcRenderer.invoke(IPC.CHAT_SEND_TEXT, text),
  /**
   * Ask the main process to pop a native context menu anchored at the
   * current cursor position. The only item today is "Clear chat" — on
   * click, main sends `CHAT_CLEAR` back to the renderer which empties its
   * message buffer. Native popup is preferred over a CSS overlay so the
   * context menu matches macOS dark-blur conventions + system keyboard nav.
   * v0.1.18.
   */
  showChatContextMenu: (): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_SHOW_CONTEXT_MENU),
  /**
   * Subscribe to "clear chat" broadcasts from main — fired by either the
   * chat context-menu "Clear chat" item or the application menu's
   * "Clear chat" (Cmd+K). Renderer handler empties its in-memory buffer;
   * Restream-side state is untouched. v0.1.18.
   */
  onChatClear: (cb: () => void): Unsub => {
    const h = () => cb();
    ipcRenderer.on(IPC.CHAT_CLEAR, h);
    return () => ipcRenderer.removeListener(IPC.CHAT_CLEAR, h);
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
  /**
   * Subscribe to GH-Releases-API update-check broadcasts. The main process
   * fires this on every poll completion AND on every explicit "Check Now"
   * — payload describes whether an update is available, the build is up to
   * date, checks are disabled, or the check errored. Renderer drives the
   * `UpdateBanner` from this signal.
   */
  onUpdateStatus: (cb: (info: UpdateInfo) => void): Unsub => {
    const h = (_: unknown, info: UpdateInfo) => cb(info);
    ipcRenderer.on(IPC.UPDATE_STATUS, h);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, h);
  },
  /**
   * Pull-fetch the last broadcast UpdateInfo on mount. Returns `undefined`
   * if no check has completed yet. Pairs with `onUpdateStatus` to avoid
   * missing the banner when the renderer mounts AFTER the 3s startup check.
   */
  getUpdateStatus: (): Promise<UpdateInfo | undefined> =>
    ipcRenderer.invoke(IPC.UPDATE_STATUS_GET),
  /**
   * Force an immediate GH-Releases check, bypassing the `update.autoCheck`
   * setting. Used by the "Check for Updates Now…" menu item and any future
   * explicit-check button in Settings. Resolves with the resulting
   * `UpdateInfo`.
   */
  checkForUpdatesNow: (): Promise<UpdateInfo> =>
    ipcRenderer.invoke(IPC.UPDATE_CHECK_NOW),
  /**
   * Open the given http(s) URL in the user's default browser via
   * `shell.openExternal`. Non-http(s) URLs are refused in main. Used by
   * the UpdateBanner's Download button to navigate to the release page.
   */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  /**
   * Trigger Squirrel's `autoUpdater.quitAndInstall()` from the renderer.
   * Bound to the `UpdateBanner` "Restart" button in the `ready-to-install`
   * state. Main-process handler guards on whether an update has actually
   * been downloaded; resolves with `{ ok: false, reason }` otherwise so
   * the renderer can surface a graceful error rather than crashing. v0.1.25.
   */
  quitAndInstall: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_QUIT_AND_INSTALL),
};

contextBridge.exposeInMainWorld('rcpp', api);

export type RcppApi = typeof api;
