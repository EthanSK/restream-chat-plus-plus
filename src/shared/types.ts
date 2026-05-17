// Shared types between main and renderer.

export type Platform =
  | 'twitch'
  | 'youtube'
  | 'facebook'
  | 'kick'
  | 'trovo'
  | 'rumble'
  | 'tiktok'
  | 'x'
  | 'unknown';

export interface ChatMessage {
  id: string;
  platform: Platform;
  username: string;
  text: string;
  ts: number; // epoch ms
  color?: string;
  raw?: unknown;
  /**
   * True when the message was originated by the local user — produced by
   * normalising a `reply_created` frame from Restream's WebSocket.
   *
   * Restream's Chat API is RECEIVE-ONLY for third-party clients: the
   * official Restream Chat webchat (or any other first-party flow) is what
   * actually sends, and the WS broadcasts `reply_created` to every
   * subscriber including us. v0.1.7 silently dropped these, which is why
   * Ethan's own messages showed up in the official app but not here. v0.1.10
   * surfaces them as `self: true` ChatMessages rendered visually distinct
   * (right-aligned, accent-tinted) in the feed.
   *
   * NOTE: v0.1.10 ALSO short-circuited TTS + notifications for self
   * messages. v0.1.26 reverts that — TTS now reads ALL messages by default,
   * including the user's own. The visual distinction remains, but the
   * audible/notification side effects no longer skip on `self`. Users who
   * want to silence specific patterns (their own outgoing markers,
   * commands, bot output, etc.) should use the new
   * `Settings.filters.*.ignoreRegex` lists.
   */
  self?: boolean;
  /**
   * Renderer-side flag set during the App.tsx forward-to-side-effects
   * effect when a regex in `Settings.filters.tts.ignoreRegex` matched
   * `text`. The message is NOT enqueued to the TTS engine; the badge
   * "🔇 regex-ignored (TTS)" renders in `ChatFeed`. v0.1.26.
   */
  ignoredByTts?: boolean;
  /**
   * Counterpart to `ignoredByTts` for `Settings.filters.notifications.ignoreRegex`.
   * When true, the native notification is skipped and the badge
   * "🔕 regex-ignored (notif)" renders. If both flags are set the badge
   * collapses to "🔇🔕 regex-ignored". v0.1.26.
   */
  ignoredByNotifications?: boolean;
}

/**
 * One connected event source as reported by Restream's WS `connection_info`
 * action. We keep the latest payload keyed by `connectionIdentifier` and
 * push the whole list to the renderer whenever it changes, so the channels
 * panel can show "N connected • click to expand → list of platforms".
 *
 * Restream-side reference: https://developers.restream.io/chat/connections
 */
export interface ChatConnection {
  connectionIdentifier: string;
  connectionUuid: string;
  eventSourceId: number;
  platform: Platform;
  /** 'connecting' | 'connected' | 'error' per Restream docs. */
  status: 'connecting' | 'connected' | 'error';
  /** Error code (per docs table) when status='error', else null. */
  reason?: string | null;
  /** Human-readable channel name extracted from the source-specific target. */
  channelName?: string;
  /** Per-source profile picture / icon URL when available. */
  avatarUrl?: string;
  /** Public URL of the channel (when Restream gives us one). */
  url?: string;
  /** ms epoch of when we last saw this connection_info update. */
  updatedAt: number;
}

export type ConnectionStatus =
  | 'idle'
  | 'authenticating'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'disconnected';

export interface ConnectionState {
  status: ConnectionStatus;
  attempt: number;
  lastError?: string;
}

export interface Settings {
  tts: {
    enabled: boolean;
    /**
     * When true, TTS prefixes each message with the sender's display name,
     * e.g. "alice says hello world". When false (default), only the message
     * body is read aloud — Ethan's strong preference is to NOT hear the name
     * by default because chat raids become unbearable otherwise.
     */
    readSenderName: boolean;
    voiceURI?: string;
    rate: number;
    pitch: number;
    volume: number;
    maxPerMinute: number;
  };
  notifications: {
    enabled: boolean;
    soundEnabled: boolean;
    maxPerMinute: number;
  };
  filter: {
    platforms: Record<Platform, boolean>;
  };
  /**
   * Per-side-effect regex ignore lists, v0.1.26.
   *
   * The strings are user-authored JS regex patterns — one per line in the
   * Settings drawer textarea. Empty strings (blank lines) are ignored.
   * Invalid patterns (syntax errors) are silently SKIPPED at compile time:
   * the Settings UI flags them with a red border + tooltip so the user
   * can fix them, but a typo never breaks the rest of the list. Patterns
   * are matched case-insensitively against `ChatMessage.text` only.
   *
   * If any pattern in `tts.ignoreRegex` matches, the incoming message is
   * NOT enqueued to the TTS engine and `ignoredByTts` is set on the
   * persisted message so the feed renders the "🔇 regex-ignored (TTS)"
   * badge. Same flow for `notifications.ignoreRegex`. The two lists are
   * independent — a message can be regex-ignored for TTS but still
   * trigger a notification (or vice versa).
   *
   * Defaults to empty arrays — out of the box, every message is read
   * aloud (when TTS is enabled) per the v0.1.26 product direction.
   */
  filters: {
    tts: {
      ignoreRegex: string[];
    };
    notifications: {
      ignoreRegex: string[];
    };
  };
  /**
   * Update-checker preferences. The GH-Releases-API-backed poller in
   * `src/main/github-update-check.ts` reads `update.autoCheck` at every
   * tick — toggling the setting takes effect on the next interval without
   * needing an app restart. The "Check for Updates Now…" menu item always
   * fires regardless of this flag (it's the explicit user request path).
   *
   * Defaults to `true` — Ethan ships unsigned builds so the only signal he
   * gets that a new version exists is this banner; opt-out only.
   */
  update: {
    autoCheck: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  tts: {
    enabled: false,
    readSenderName: false,
    voiceURI: undefined,
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    maxPerMinute: 20,
  },
  notifications: {
    enabled: false,
    soundEnabled: true,
    maxPerMinute: 30,
  },
  filter: {
    platforms: {
      twitch: true,
      youtube: true,
      facebook: true,
      kick: true,
      trovo: true,
      rumble: true,
      tiktok: true,
      x: true,
      unknown: true,
    },
  },
  filters: {
    // Empty by default — v0.1.26 product direction is "read everything";
    // users opt in to filtering by adding patterns in the Settings drawer.
    tts: { ignoreRegex: [] },
    notifications: { ignoreRegex: [] },
  },
  update: {
    // Opt-out, not opt-in: unsigned builds get no other update signal.
    autoCheck: true,
  },
};

// Per-platform brand colors used for badges + usernames.
export const PLATFORM_COLORS: Record<Platform, string> = {
  twitch: '#9146FF',
  youtube: '#FF0000',
  facebook: '#1877F2',
  kick: '#53FC18',
  trovo: '#19D66B',
  rumble: '#85C742',
  tiktok: '#FE2C55',
  x: '#000000',
  unknown: '#888888',
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  facebook: 'Facebook',
  kick: 'Kick',
  trovo: 'Trovo',
  rumble: 'Rumble',
  tiktok: 'TikTok',
  x: 'X',
  unknown: 'Unknown',
};

// IPC channel names.
export const IPC = {
  AUTH_START: 'auth:start',
  AUTH_STATUS: 'auth:status',
  AUTH_LOGOUT: 'auth:logout',
  CONN_STATE: 'conn:state',
  CONN_STATE_GET: 'conn:state:get',
  CONN_RECONNECT: 'conn:reconnect',
  CHAT_MESSAGE: 'chat:message',
  /**
   * Push channel — main → renderer — fires whenever the in-memory map of
   * Restream `connection_info` entries changes (new connect, status flip,
   * close). Payload is the full deduped ChatConnection[] sorted by platform.
   */
  CONNECTIONS: 'connections:list',
  /** Pull-fetch counterpart so the renderer can sync on mount. */
  CONNECTIONS_GET: 'connections:get',
  /**
   * Open the native React Compose window (v0.1.32+). Spawns a small
   * BrowserWindow that loads the same renderer bundle with `?compose=1`,
   * which renders a compose-only UI (multi-line textarea + send button +
   * always-on-top toggle + an escape-hatch "Open Restream webchat" link).
   * The send button posts via the same `CHAT_SEND_TEXT` IPC the inline
   * input uses, so the reply round-trips through Restream's normal
   * `/client/reply` endpoint and surfaces back as a `self: true`
   * ChatMessage in the feed.
   *
   * Pre-v0.1.32 this opened Restream's official webchat (chat.restream.io)
   * in a 720x720 BrowserWindow — that page's intrinsic min-widths forced
   * the window to be much larger than a compose UI needs. The escape
   * hatch (still useful for emoji-picker / per-platform targeting / cookie
   * refresh) lives behind a button INSIDE the new compose window now —
   * see `CHAT_OPEN_RESTREAM_WEBCHAT`.
   */
  CHAT_OPEN_COMPOSE: 'chat:open-compose',
  /**
   * v0.1.32: escape-hatch IPC fired from inside the native Compose window
   * (and reusable from anywhere) to open Restream's official webchat at
   * https://chat.restream.io in a separate BrowserWindow. This is the path
   * for users who need Restream's full reply UI (emoji picker, per-platform
   * channel targeting) or to refresh expired session cookies. Identical
   * window setup to the pre-v0.1.32 Compose handler.
   */
  CHAT_OPEN_RESTREAM_WEBCHAT: 'chat:open-restream-webchat',
  /**
   * v0.1.32: the Compose renderer (loaded with `?compose=1`) asks the main
   * process for its initial state (the persisted `alwaysOnTop` preference)
   * + whether the parent app is currently connected so it can disable the
   * send button when offline. Resolves immediately.
   */
  COMPOSE_GET_INIT: 'compose:get-init',
  /**
   * v0.1.32: renderer → main toggle for the Compose window's always-on-top
   * behaviour. Main updates the BrowserWindow's `alwaysOnTop` flag AND
   * persists the new value to the store so the next launch restores it.
   */
  COMPOSE_SET_ALWAYS_ON_TOP: 'compose:set-always-on-top',
  /**
   * Send a chat reply text directly via Restream's internal
   * `POST /api/v2/client/reply` endpoint. The renderer's inline chat-input
   * bar invokes this — no Compose window needed for the common case.
   *
   * Main process pulls the chat-session cookies from the
   * `persist:restream-oauth` Electron partition (provisioned when the user
   * signed in / Compose was opened at least once), grabs the
   * `accessXsrfToken` cookie as the `x-axsrf-token` header, and POSTs the
   * body. The successful send is echoed back as a `reply_created` WS frame
   * which our normaliser already surfaces as a `self: true` ChatMessage.
   */
  CHAT_SEND_TEXT: 'chat:send-text',
  /**
   * Renderer → main. Asks the main process to pop a native context menu
   * (Menu.buildFromTemplate + popup) anchored at the cursor. Currently the
   * only item is "Clear chat"; when clicked, main sends back `CHAT_CLEAR`
   * which the renderer consumes by emptying its in-memory message buffer.
   * Native popup is used (rather than a custom CSS menu) so context-menu UX
   * matches macOS conventions — dark blur, full-system keyboard nav, etc.
   * v0.1.18.
   */
  CHAT_SHOW_CONTEXT_MENU: 'chat:show-context-menu',
  /**
   * Main → renderer broadcast: clear the chat-message buffer (renderer state
   * only — this never touches the WebSocket or Restream-side state). Fired
   * by either the chat context-menu "Clear chat" item or the application
   * menu's "Clear chat" item (Cmd+K). v0.1.18.
   */
  CHAT_CLEAR: 'chat:clear',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  NOTIFY: 'notify',
  REVEAL_LOGS: 'logs:reveal',
  /**
   * Push channel — main → renderer — fires whenever the GH-Releases poller
   * (`src/main/github-update-check.ts`) finishes a check. Payload is an
   * `UpdateInfo` describing whether an update is available, the app is up
   * to date, the check is disabled, or the check failed. The renderer's
   * UpdateBanner subscribes to this to decide whether to show its strip.
   */
  UPDATE_STATUS: 'update:status',
  /**
   * Pull-fetch counterpart to UPDATE_STATUS — used by a renderer that
   * mounted AFTER a check already completed so it doesn't miss the banner.
   * Returns the last broadcast `UpdateInfo`, or `undefined` if no check
   * has run yet.
   */
  UPDATE_STATUS_GET: 'update:status:get',
  /**
   * Renderer → main. Force an immediate GH-Releases check, bypassing the
   * `settings.update.autoCheck` gate (this is the path used by the
   * "Check for Updates Now…" menu item). Resolves with the resulting
   * `UpdateInfo`.
   */
  UPDATE_CHECK_NOW: 'update:check-now',
  /**
   * Renderer → main. Open an arbitrary URL in the user's default browser
   * via `shell.openExternal`. Retained for general use (the About link in
   * the help menu, future settings deep-links, etc.). The UpdateBanner's
   * "Download" button no longer uses this — see UPDATE_DOWNLOAD_START.
   */
  OPEN_EXTERNAL: 'shell:open-external',
  /**
   * Renderer → main. Triggered by the "Download" button on the
   * `available` banner state. Kicks Squirrel's in-app download pipeline
   * via `autoUpdater.checkForUpdates()` so the user gets the staged-and-
   * restart flow (progress bar → "Restart to install") instead of being
   * dumped into their default browser on the GitHub release page. v0.1.32.
   *
   * Resolves with a `StartDownloadResult`. The renderer ignores the
   * payload on success because Squirrel's own download-progress events
   * drive the banner state machine from here on. On failure (unsigned
   * build, dev mode, Linux, transient error) the main-process handler
   * pops a native info dialog explaining the situation — we deliberately
   * do NOT fall back to opening the release page in the browser, because
   * the whole point of this banner action is "stay in-app".
   */
  UPDATE_DOWNLOAD_START: 'update:download-start',
  /**
   * Renderer → main. Triggered by the "Restart" button on the
   * `ready-to-install` banner state. Calls `autoUpdater.quitAndInstall()`
   * which closes the app and lets Squirrel swap the bundle. Only valid
   * after a Squirrel `update-downloaded` event has fired — otherwise the
   * autoUpdater throws synchronously. The main-process handler guards on
   * that. v0.1.25.
   */
  UPDATE_QUIT_AND_INSTALL: 'update:quit-and-install',
} as const;

/**
 * Result of an update check, broadcast over IPC.UPDATE_STATUS / returned
 * from IPC.UPDATE_CHECK_NOW. The renderer's UpdateBanner renders distinct
 * visuals per `kind`:
 *
 *   - `checking`         → small spinner + "Checking for updates…" text.
 *                          Fired by the GH poller at the start of every
 *                          check AND by the manual "Check for Updates Now"
 *                          path so the renderer can show progress while
 *                          the network round-trip is in flight. v0.1.25.
 *   - `available`        → "Update available" banner with Download button
 *                          (kicks Squirrel's in-app download pipeline via
 *                          `IPC.UPDATE_DOWNLOAD_START`) + Later (dismiss).
 *                          v0.1.32: no longer opens the release page in
 *                          the browser — the click stays in-app.
 *   - `downloading`      → progress bar with percent. Driven by the
 *                          Squirrel `download-progress` event in
 *                          `src/main/updater.ts` (v0.1.25). Only fires on
 *                          signed builds where Squirrel can actually fetch
 *                          the payload; unsigned builds skip straight from
 *                          `available` to whatever the user does manually.
 *   - `ready-to-install` → "Restart to install" banner with a Restart
 *                          button that calls `autoUpdater.quitAndInstall()`.
 *                          Fired by Squirrel's `update-downloaded` event.
 *   - `up-to-date`       → no banner (the silent happy path).
 *   - `disabled`         → no banner (the auto-check toggle is off).
 *   - `error`            → no banner; the error is logged for the
 *                          "Check Now" menu item's dialog.
 */
export interface UpdateInfo {
  kind:
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready-to-install'
    | 'up-to-date'
    | 'disabled'
    | 'error';
  /** Currently-running app version (from `app.getVersion()`). */
  currentVersion: string;
  /** Latest GH release tag — populated when kind === 'available'/'downloading'/'ready-to-install'. */
  latestVersion?: string;
  /** GH release page URL — populated when kind === 'available'. */
  releaseUrl?: string;
  /**
   * Squirrel download progress, 0-100. Populated when kind === 'downloading'.
   * Squirrel's `download-progress` event exposes `percent`; we forward it
   * verbatim. Undefined while we know the download is in progress but
   * Squirrel hasn't reported its first chunk yet — UI should render an
   * indeterminate state in that case.
   */
  downloadPercent?: number;
  /** Error message — populated when kind === 'error'. */
  error?: string;
  /** Epoch ms of when this check completed. */
  checkedAt: number;
}

export interface AuthStatus {
  authenticated: boolean;
  scope?: string;
  expiresAt?: number;
}

/**
 * Result of an inline `rcpp.sendChatText(text)` call. Used by the renderer
 * to surface inline errors next to the chat-input bar.
 *
 * `reason` codes:
 *  - `not-authenticated`     — OAuth token missing/expired.
 *  - `no-session-cookies`    — `persist:restream-oauth` partition has no
 *                              chat-session cookies yet. The user needs to
 *                              open the Compose window once so Restream
 *                              provisions the `.restream.io` cookies +
 *                              `accessXsrfToken`. We auto-attempt provision
 *                              via an invisible Compose window first; this
 *                              reason is reported only if that fails too.
 *  - `no-active-connections` — channels panel is empty (nothing to reply to).
 *  - `no-show-id`            — Restream's `/client/reply` returned HTTP 404
 *                              AND we had no showId to send. In v0.1.17–
 *                              v0.1.19 this was a pre-flight gate; v0.1.20
 *                              flipped it to a post-attempt failure mode
 *                              so users CAN send before the first WS event
 *                              flows (Restream's backend can sometimes
 *                              resolve the show implicitly from session
 *                              cookies + the user's only active show).
 *                              When this comes back the most likely cause
 *                              is no active stream / no in-progress event.
 *  - `send-failed`           — POST /client/reply returned non-2xx.
 *  - `error`                 — unexpected (network / JS) failure.
 */
export interface SendTextResult {
  ok: boolean;
  reason?:
    | 'not-authenticated'
    | 'no-session-cookies'
    | 'no-active-connections'
    | 'no-show-id'
    | 'send-failed'
    | 'error';
  status?: number;
  error?: string;
}
