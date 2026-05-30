import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './shared/types';
import type {
  AuthStatus,
  ChatConnection,
  ChatMessage,
  ChatSendEnqueuePayload,
  ChatSendStatus,
  ConnectionState,
  NativeVoiceWire,
  SendTextResult,
  Settings,
  TtsLogEvent,
  TtsNativeEnqueuePayload,
  TtsNativeSettingsPayload,
  TtsSpeakBrowserPayload,
  UpdateInfo,
} from './shared/types';

type Unsub = () => void;

const api = {
  authStart: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.AUTH_START),
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.AUTH_STATUS),
  authLogout: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  /**
   * v0.1.52: ask main to show the native Sign Out confirmation dialog.
   * Resolves to `true` if the user clicked "Sign out", `false` otherwise.
   * The renderer must ONLY call `authLogout()` after this resolves true.
   *
   * See `IPC.AUTH_CONFIRM_LOGOUT` for why we route this through main.
   */
  authConfirmLogout: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.AUTH_CONFIRM_LOGOUT),
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
   * Send a chat reply inline via Restream's internal
   * `POST /api/client/reply` endpoint. The reply gets broadcast back as
   * a `reply_created` WS frame which surfaces in the feed as a
   * `self: true` ChatMessage — no optimistic rendering needed.
   *
   * The first call (cold start) MAY auto-spawn an invisible helper window
   * to provision chat-session cookies in the `persist:restream-oauth`
   * partition; subsequent sends are pure fetch + cookies.
   *
   * v0.1.34: endpoint corrected from `/api/v2/client/reply` (404 ghost
   * route) to `/api/client/reply` (the real path the live chat.restream.io
   * webchat posts to). See `src/main/chat-send.ts` for the body-shape
   * union (showId | eventId | instant) and reverse-engineering notes.
   */
  sendChatText: (text: string): Promise<SendTextResult> =>
    ipcRenderer.invoke(IPC.CHAT_SEND_TEXT, text),
  /**
   * v0.1.43 — fire-and-forget enqueue for the non-blocking inline chat
   * input. The renderer mints `clientId` (UUID) BEFORE calling this so it
   * can render the optimistic placeholder immediately, then ships
   * `{ clientId, text }` down to the main-process queue. The main queue
   * serialises sends + broadcasts `ChatSendStatus` events back via
   * `onChatSendStatus`. The renderer NEVER awaits this — the input
   * clears synchronously the moment Enter is pressed so the user can
   * spam-send without blocking.
   */
  enqueueChatSend: (payload: ChatSendEnqueuePayload): void => {
    try {
      ipcRenderer.send(IPC.CHAT_SEND_ENQUEUE, payload);
    } catch {
      /* never let an IPC failure break the renderer's input loop */
    }
  },
  /**
   * v0.1.68 (voice 4013) — fire-and-forget structured log relay so the
   * renderer can write a `chat-send.jsonl` row when its stuck-send guard
   * fires. Renderer has no fs in preload; main owns the writer. The
   * payload is a `ChatSendLogRecord`-shaped object (see chat-send.ts).
   * Errors are swallowed — logging must NEVER break the renderer loop.
   */
  emitChatSendLogEvent: (record: Record<string, unknown>): void => {
    try {
      ipcRenderer.send(IPC.CHAT_SEND_LOG_EVENT, record);
    } catch {
      /* never let an IPC failure break the renderer's send loop */
    }
  },
  /**
   * v0.1.43 — subscribe to lifecycle status events for queued sends.
   * Renderer keys updates by `clientId` to flip the per-message
   * "sending…" / sent / failed (⚠) state in the chat feed.
   */
  onChatSendStatus: (cb: (status: ChatSendStatus) => void): Unsub => {
    const h = (_: unknown, status: ChatSendStatus) => cb(status);
    ipcRenderer.on(IPC.CHAT_SEND_STATUS, h);
    return () => ipcRenderer.removeListener(IPC.CHAT_SEND_STATUS, h);
  },
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
  /**
   * Subscribe to push-broadcasts of Settings changes coming from the
   * in-process HTTP MCP server (v0.1.36+). The renderer re-applies the
   * pushed Settings to its TTS / notification / filter state so MCP
   * mutations (e.g. `set_voice` called by Claude Code) reflect in the
   * UI immediately, no restart needed.
   */
  onSettingsPush: (cb: (s: Settings) => void): Unsub => {
    const h = (_: unknown, s: Settings) => cb(s);
    ipcRenderer.on(IPC.SETTINGS_PUSH, h);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_PUSH, h);
  },
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
   * `shell.openExternal`. Non-http(s) URLs are refused in main. Used for
   * general external links (the help-menu About link, future settings
   * deep-links, etc.). The UpdateBanner no longer routes through this —
   * see `startUpdateDownload`. v0.1.32.
   */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  /**
   * Kick Squirrel's in-app download from the renderer. Bound to the
   * `UpdateBanner` "Download" button in the `available` state. Main-
   * process handler fires `autoUpdater.checkForUpdates()` which drives
   * the banner through `downloading` → `ready-to-install` via the
   * existing Squirrel progress forwarders. On failure (unsigned build,
   * dev mode, Linux, transient error) the handler pops a native info
   * dialog and returns a failure payload — the renderer doesn't need
   * to render anything itself, the dialog IS the user-facing message. v0.1.32.
   */
  startUpdateDownload: (): Promise<
    | { ok: true; reason: 'started'; mode: 'squirrel' }
    | { ok: true; reason: 'opened-release-page'; mode: 'browser'; fallbackReason: string }
    | {
        ok: false;
        reason: 'not-packaged' | 'unsupported-platform' | 'feed-unavailable' | 'error';
        error?: string;
        releaseUrl: string;
      }
  > => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD_START),
  /**
   * Trigger Squirrel's `autoUpdater.quitAndInstall()` from the renderer.
   * Bound to the `UpdateBanner` "Restart" button in the `ready-to-install`
   * state. Main-process handler guards on whether an update has actually
   * been downloaded; resolves with `{ ok: false, reason }` otherwise so
   * the renderer can surface a graceful error rather than crashing. v0.1.25.
   */
  quitAndInstall: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_QUIT_AND_INSTALL),
  /**
   * Fire-and-forget TTS lifecycle event. Persisted to
   * `~/Library/Logs/<productName>/tts-events.jsonl` by the main-process
   * handler. v0.1.41 — diagnostic hook for the intermittent
   * subsequent-message-skip Chromium speechSynthesis bug. Renderer never
   * awaits the result and a failed IPC must not break TTS playback.
   */
  ttsLog: (event: TtsLogEvent['event'], data?: TtsLogEvent['data']): void => {
    try {
      ipcRenderer.send(IPC.TTS_LOG, { event, data });
    } catch {
      /* never let logging crash playback */
    }
  },
  /**
   * v0.1.42 native-`say` engine bindings. The renderer uses these instead
   * of `window.speechSynthesis` when `settings.tts.engine === 'native'`.
   *
   * - `enqueue` / `cancel` / `updateSettings` are fire-and-forget — the
   *   main-process queue accepts the message and the renderer never
   *   awaits an ack. This matches the v0.1.41 browser-engine ergonomics
   *   (renderer-side queue mutations are also sync).
   * - `getVoices` is async — returns the parsed `say -v "?"` list as
   *   `NativeVoiceWire[]`. Cached in main, so subsequent calls during
   *   the same session resolve immediately.
   */
  ttsNative: {
    enqueue: (payload: TtsNativeEnqueuePayload): void => {
      try {
        ipcRenderer.send(IPC.TTS_NATIVE_ENQUEUE, payload);
      } catch {
        /* never crash the renderer over a logging/queue IPC */
      }
    },
    cancel: (): void => {
      try {
        ipcRenderer.send(IPC.TTS_NATIVE_CANCEL);
      } catch {
        /* defensive */
      }
    },
    updateSettings: (payload: TtsNativeSettingsPayload): void => {
      try {
        ipcRenderer.send(IPC.TTS_NATIVE_UPDATE_SETTINGS, payload);
      } catch {
        /* defensive */
      }
    },
    getVoices: (): Promise<NativeVoiceWire[]> =>
      ipcRenderer.invoke(IPC.TTS_NATIVE_GET_VOICES),
  },
  /**
   * v0.1.76 (Ethan voice 4414) — subscribe to MAIN → renderer browser-speak
   * commands. The main-process TtsDispatcher decides whether/what to speak and
   * which backend to use; when it picks the BROWSER backend (window
   * visible/covered) it pushes `IPC.TTS_SPEAK_BROWSER` with a full settings
   * snapshot. The renderer's thin executor (App.tsx) speaks that ONE utterance
   * via Web Speech, honouring volume/voice/rate/PITCH from the payload. The
   * renderer no longer decides anything — it just executes.
   */
  onSpeakBrowser: (cb: (payload: TtsSpeakBrowserPayload) => void): Unsub => {
    const h = (_: unknown, payload: TtsSpeakBrowserPayload) => cb(payload);
    ipcRenderer.on(IPC.TTS_SPEAK_BROWSER, h);
    return () => ipcRenderer.removeListener(IPC.TTS_SPEAK_BROWSER, h);
  },
};

contextBridge.exposeInMainWorld('rcpp', api);

export type RcppApi = typeof api;
