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
  /**
   * v0.1.43 — only set on locally-minted OPTIMISTIC placeholders for
   * outgoing messages the user just hit Enter on. The renderer pushes
   * the placeholder into the feed synchronously (so the user sees their
   * text instantly) and the main-process queue broadcasts a
   * `ChatSendStatus` back over `CHAT_SEND_STATUS`.
   *
   *   - `'sending'` — POST hasn't completed yet; renders a faint
   *                   "sending…" hint next to the timestamp.
   *   - `'failed'`  — POST returned non-2xx (or auth/cookies missing).
   *                   Renders a small ⚠ icon next to the message body
   *                   whose `title` (tooltip) is `pendingError`.
   *
   * When the matching WS `reply_created` echo arrives (matched by
   * `id === clientReplyUuid`), the optimistic placeholder is REPLACED
   * with the echo — which has `self: true` and no `pendingSend` flag.
   * Failed placeholders are NEVER auto-removed: the user sees the ⚠
   * persistently until they take action (clear chat, dismiss).
   *
   * Undefined for all incoming messages and for echoed self messages.
   */
  pendingSend?: 'sending' | 'failed';
  /**
   * Human-readable error string surfaced as the ⚠ icon's tooltip when
   * `pendingSend === 'failed'`. v0.1.43.
   */
  pendingError?: string;
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

/**
 * TTS engine implementation, v0.1.42.
 *
 * - `native` — macOS `say(1)` subprocess driven from the main process.
 *   Reliable, no Chromium bugs, but currently macOS-only. The renderer
 *   IPCs into `IPC.TTS_NATIVE_*` channels; the queue lives in the
 *   main-process `NativeTtsEngine` (`src/main/tts-native.ts`).
 * - `browser` — Chromium `window.speechSynthesis`. The historical engine
 *   that v0.1.40 / v0.1.41 hardened with watchdogs. Retained behind the
 *   toggle so a future Linux / Windows build can keep working without
 *   needing the OS-specific `say` binary.
 *
 * Default is `native` on macOS (which is currently the only target
 * RC++ ships for). The renderer's `TTSEngine` factory picks the
 * implementation off this setting at construct + update time, so flipping
 * the dropdown takes effect for the next enqueued message without an
 * app restart.
 */
export type TtsEngineKind = 'native' | 'browser';

export interface Settings {
  tts: {
    enabled: boolean;
    /**
     * Which speech-synthesis backend to use. See `TtsEngineKind` for
     * the per-value semantics. Defaults to `'native'` on macOS so users
     * who haven't touched the toggle get the reliable path automatically.
     */
    engine: TtsEngineKind;
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
    /**
     * v0.1.77 (Ethan voice 4438, 2026-05-30) — ONE-CLICK MUTE for spoken chat.
     *
     * A DEDICATED kill-switch for the app SPEAKING chat aloud (TTS), separate
     * from `enabled` (the detailed "TTS feature on/off" toggle in Settings) and
     * separate from every voice/rate/volume/filter knob. The point is a header
     * button Ethan can tap to instantly silence speech WITHOUT clobbering his
     * carefully-tuned config — flipping `muted` back to false restores
     * everything exactly as it was (because nothing else was touched).
     *
     * WHY a new field instead of toggling `enabled`:
     *   - `enabled` is the deliberate feature switch; if we reused it, unmuting
     *     could resurrect a TTS feature the user had genuinely turned off, and
     *     muting would lose the distinction between "I configured TTS off" and
     *     "I temporarily silenced it". `muted` layers cleanly ON TOP of
     *     `enabled`: speech happens only when `enabled && !muted`.
     *
     * THE MUTE GATE (source of truth = MAIN process):
     *   The renderer header button just flips this boolean and persists it.
     *   The authoritative "do we speak?" decision lives in the main-process
     *   TtsDispatcher (src/main/tts-dispatch.ts), which checks `muted` and skips
     *   BOTH the browser-voice dispatch AND the native `say` path when true — so
     *   muting genuinely silences ALL speech regardless of window state. A muted
     *   message still RENDERS in the chat feed as normal; only the speech is
     *   suppressed.
     *
     * Persisted via electron-store (survives restart). Defaults to false — a
     * fresh install is NOT muted (TTS-disabled-by-default is handled by
     * `enabled`, not this flag).
     */
    muted: boolean;
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
   * v0.1.72 (voice 4352, 2026-05-28) — added `ignoreUsernameRegex` as a
   * SECOND matching axis. The content regex matches against
   * `ChatMessage.text`; the username regex matches against
   * `ChatMessage.username` (the author's display name). The two axes
   * COMPOSE within a side-effect — a message is filtered if EITHER axis
   * matches. A rule that wants "content X AND username Y must both be
   * true" would need a different shape; the v0.1.72 surface keeps the
   * axes independent because that maps cleanly to the existing OR
   * semantics ("if any pattern matches → ignore"). Username patterns
   * also use the case-insensitive `i` flag uniformly.
   *
   * Defaults to empty arrays for the username lists — out of the box no
   * usernames are filtered. The `ignoreRegex` content lists default to
   * `['^viewer$']` per v0.1.48 — see the loadSettings docstring.
   */
  filters: {
    tts: {
      ignoreRegex: string[];
      ignoreUsernameRegex: string[];
    };
    notifications: {
      ignoreRegex: string[];
      ignoreUsernameRegex: string[];
    };
  };
  /**
   * v0.1.72 (voice 4352, 2026-05-28) — hidden-user list. Messages whose
   * `username` exactly matches any string in this list are filtered out
   * of the visible feed entirely (NOT just regex-ignored for side
   * effects — they don't render at all). Populated by the hover →
   * "Hide user" button on each chat row, removed via the Unhide button
   * in the Settings drawer's Hidden Users section.
   *
   * Exact-match (case-INSENSITIVE) rather than regex because the hide
   * action is one-click from a specific row — the user is naming a
   * specific person, not authoring a pattern. Case-insensitive because
   * usernames on Twitch/YouTube/etc. display in mixed case but the
   * underlying identity is the same.
   *
   * Empty by default. Persists in electron-store alongside the rest of
   * Settings. Historical messages already in the in-memory feed buffer
   * get re-filtered on every render so clicking Hide hides their past
   * messages too (not just future ones).
   */
  hiddenUsers: string[];
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
    // v0.1.44: flipped back to the browser (Web Speech) engine after the
    // v0.1.40 strong-ref + v0.1.41 cancel-before-speak + 8s keep-alive +
    // 500ms onstart watchdog + onerror retry + disk-log layers landed.
    // The macOS `say` engine (added in v0.1.42) is reliable but ignores
    // the in-app volume slider — `say` has no `--volume` flag and only
    // tracks the system output level. Browser engine is now reliable AND
    // honours the slider, so it's the right default again. Native stays
    // available as an opt-in toggle in Settings.
    engine: 'browser',
    readSenderName: false,
    voiceURI: undefined,
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    maxPerMinute: 20,
    // v0.1.77 — not muted out of the box. The header 🔊/🔇 button flips this;
    // the main-process dispatcher gates speech on `enabled && !muted`.
    muted: false,
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
    // v0.1.48: seed both lists with `^viewer$` (anchored, case-insensitive
    // via the uniform `i` flag in compileIgnorePatterns) so the generic
    // anonymous-YouTube/Facebook "Viewer" placeholder username's messages
    // — where the message *text* itself is literally "Viewer" — never
    // wake TTS or notifications. Users can still remove it from the
    // Settings drawer if they actually want those messages read. The
    // pre-v0.1.48 default was empty; the existing settings of a user who
    // already has the v0.1.26 filters section persisted to disk are
    // upgraded via the one-time migration in `main.ts`.
    //
    // v0.1.72 — the new `ignoreUsernameRegex` axis defaults empty. Users
    // opt in via the Settings drawer textarea (one regex per line) or via
    // the hover → "Hide user" affordance (which writes the EXACT
    // username into `hiddenUsers`, NOT into this regex list — see below).
    tts: { ignoreRegex: ['^viewer$'], ignoreUsernameRegex: [] },
    notifications: { ignoreRegex: ['^viewer$'], ignoreUsernameRegex: [] },
  },
  // v0.1.72 — fresh installs start with no hidden users. The list grows
  // as the user clicks Hide on individual rows.
  hiddenUsers: [],
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
  /**
   * v0.1.52: confirmation dialog for the destructive Sign Out flow.
   *
   * Pre-v0.1.52 the renderer called `window.confirm()` directly. In an
   * Electron `BrowserWindow` (especially with `sandbox: false` +
   * `contextIsolation: true`, which is our config), `window.confirm` is
   * unreliable: depending on the Electron version + webPreferences combo
   * it either returns `false` synchronously without showing UI, or shows
   * a blocking modal that the main process intercepts and discards.
   *
   * Effect of the v0.1.x regression: the user clicked "Sign out", saw no
   * dialog, and the button just sat there because `shouldProceedWithSignOut`
   * received `false` and short-circuited before ever calling `authLogout`.
   *
   * The fix routes the confirm prompt through `dialog.showMessageBox`
   * (proper native modal) via this IPC channel. Renderer awaits the
   * boolean and only then fires AUTH_LOGOUT. Tested in main process where
   * `dialog` is fully wired and reliable.
   */
  AUTH_CONFIRM_LOGOUT: 'auth:confirm-logout',
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
   * Send a chat reply text directly via Restream's internal
   * `POST /api/client/reply` endpoint. The renderer's inline chat-input
   * bar invokes this.
   *
   * Main process pulls the chat-session cookies from the
   * `persist:restream-oauth` Electron partition (provisioned when the user
   * signed in), grabs the `accessXsrfToken` cookie as the `x-axsrf-token`
   * header, and POSTs the body. The successful send is echoed back as a
   * `reply_created` WS frame which our normaliser already surfaces as a
   * `self: true` ChatMessage.
   *
   * v0.1.34: endpoint corrected from `/api/v2/client/reply` (404 ghost
   * route) to `/api/client/reply` (the real path the live chat.restream.io
   * webchat posts to today). See `src/main/chat-send.ts` for the
   * showId | eventId | instant body-shape union.
   */
  CHAT_SEND_TEXT: 'chat:send-text',
  /**
   * v0.1.43: fire-and-forget enqueue channel for the non-blocking inline
   * chat input. The renderer pushes `{ clientId, text }` and IMMEDIATELY
   * resumes accepting input — the main-process queue serialises the actual
   * POSTs and broadcasts lifecycle updates back over `CHAT_SEND_STATUS`.
   *
   * Coexists with the legacy invoke-based `CHAT_SEND_TEXT` (left in place
   * so any external callers / MCP tooling that still awaits the result
   * keep working — the v0.1.42 invoke handler is unchanged).
   */
  CHAT_SEND_ENQUEUE: 'chat:send-enqueue',
  /**
   * v0.1.43: main → renderer push of `ChatSendStatus` lifecycle events
   * for queued sends. Fires `pending` when the queue accepts the enqueue,
   * `sent` when the POST succeeds (HTTP 2xx), `failed` when the POST or
   * the queue's internal validation fails. Renderer uses these to drive
   * the optimistic placeholder + ⚠ error icon next to the message in
   * the chat feed.
   */
  CHAT_SEND_STATUS: 'chat:send-status',
  /**
   * v0.1.68 (voice 4013) — renderer → main fire-and-forget channel for
   * pushing structured `chat-send.jsonl` rows that originate in the
   * renderer process. Today it carries `optimistic-timeout` rows when
   * the stuck-send guard fires (the only renderer-side diagnostic that
   * needs to land in the unified disk log). The renderer cannot write
   * the jsonl directly (no fs access via preload); main's
   * `appendChatSendLog` is the single writer.
   *
   * Payload shape: see `ChatSendLogRecord` in `chat-send.ts`. Main is
   * strict — non-object payloads or missing `phase` keys are dropped
   * silently to keep an exploit-from-renderer worst case bounded.
   */
  CHAT_SEND_LOG_EVENT: 'chat:send-log-event',
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
  /**
   * Push channel — main → renderer — fires when the in-process HTTP MCP
   * server mutates Settings (v0.1.36+). Payload is the fully-merged
   * Settings object that just landed. The renderer subscribes so MCP
   * changes (e.g. `set_voice` from Claude Code) reflect in the live
   * Settings drawer + TTS pipeline immediately, no restart required.
   */
  SETTINGS_PUSH: 'settings:push',
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
  /**
   * Renderer → main, fire-and-forget. One TTS lifecycle event keyed by
   * message_id, appended to `~/Library/Logs/<productName>/tts-events.jsonl`
   * (or platform equivalent via `app.getPath('logs')`).
   *
   * Used by the v0.1.41 engine-wake layer to diagnose intermittent
   * subsequent-message skips: every `speak_called`, `onstart`, `onend`,
   * `onerror`, `watchdog_fired`, `keepalive_fired`, `cancel_called` event
   * is persisted to disk so when the bug recurs we can correlate from a
   * single log instead of asking Ethan to keep DevTools open.
   */
  TTS_LOG: 'tts:log',
  /**
   * v0.1.42 native-`say` engine IPC channels. The renderer pushes text
   * onto `TTS_NATIVE_ENQUEUE`; the main process holds the queue + spawns
   * `say` subprocesses. `TTS_NATIVE_CANCEL` SIGTERMs the in-flight child
   * and drops the queue. `TTS_NATIVE_UPDATE_SETTINGS` propagates a fresh
   * `NativeTtsSettings` slice (voice / rate / volume) for the next
   * utterance. `TTS_NATIVE_GET_VOICES` async-returns the parsed
   * `say -v "?"` list as `NativeVoice[]`.
   *
   * These channels are fire-and-forget on the enqueue / cancel /
   * update-settings paths — playback never blocks on an IPC round-trip.
   * Only `getVoices` is async (renderer awaits the response for the
   * Settings dropdown).
   */
  TTS_NATIVE_ENQUEUE: 'tts-native:enqueue',
  TTS_NATIVE_CANCEL: 'tts-native:cancel',
  TTS_NATIVE_UPDATE_SETTINGS: 'tts-native:update-settings',
  TTS_NATIVE_GET_VOICES: 'tts-native:get-voices',
  /**
   * v0.1.76 (Ethan voice 4414, 2026-05-30) — MAIN → renderer push. Asks the
   * renderer to speak ONE utterance via the browser Web-Speech engine.
   *
   * This is the inversion that moves TTS dispatch into the background: the
   * main process now OWNS the decision (filters, rate-limit, same-id guard,
   * visibility-based backend choice — see src/main/tts-dispatch.ts). When the
   * window is visible/covered, main picks the BROWSER backend and pushes this
   * channel with a full snapshot of the utterance's TTS settings
   * (`TtsSpeakBrowserPayload` — voice/rate/pitch/volume). The renderer is now
   * a THIN executor: it just speaks what it's told, honouring every setting in
   * the payload. It no longer decides anything.
   *
   * Fire-and-forget. If the window is genuinely hidden main NEVER uses this
   * channel — it speaks via native `say` directly (renderer-independent), which
   * is the never-miss guarantee.
   */
  TTS_SPEAK_BROWSER: 'tts:speak-browser',
} as const;

/**
 * Wire shape for a single voice entry returned by `IPC.TTS_NATIVE_GET_VOICES`.
 * Mirrors `NativeVoice` in `src/main/tts-native.ts` (intentionally kept
 * structurally identical so the main-process value passes through unchanged).
 *
 * `lang` is in macOS `say` form (`en_GB`, `fr_FR`) — the underscore
 * separator differs from the Web Speech API's `en-GB`/`fr-FR`. Renderers
 * that mix native + browser voices in the same UI should normalise the
 * separator for display.
 */
export interface NativeVoiceWire {
  /** Display name; may include parenthesised qualifier ("Eddy (English (UK))"). */
  name: string;
  /** Locale identifier, `say -v "?"` shape. */
  lang: string;
  /** Demo phrase shipped by macOS. May be empty. */
  sample: string;
}

/**
 * Wire payload for `IPC.TTS_NATIVE_ENQUEUE`. Mirrors the
 * `NativeEnqueueOpts` shape on the main-process side, except we explicitly
 * carry `text` because IPC payloads are flat.
 */
export interface TtsNativeEnqueuePayload {
  text: string;
  voice?: string;
  rate?: number;
  volume?: number;
  messageId?: string;
}

/**
 * Wire payload for `IPC.TTS_NATIVE_UPDATE_SETTINGS`. Only the fields the
 * native engine consumes — kept narrow so we don't have to ship the
 * whole Settings tree across IPC on every voice/rate/volume tweak.
 */
export interface TtsNativeSettingsPayload {
  voiceURI?: string;
  rate: number;
  volume: number;
}

/**
 * v0.1.76 — wire payload for `IPC.TTS_SPEAK_BROWSER` (MAIN → renderer). One
 * utterance the renderer should speak via Web Speech, carrying a full snapshot
 * of the TTS settings the utterance needs. The decision (whether to speak at
 * all, which backend) was already made in main — the renderer just executes.
 * Carrying the settings in the payload is what keeps volume/voice/rate/PITCH
 * all working in the visible-window case without the renderer re-reading state.
 */
export interface TtsSpeakBrowserPayload {
  /** Already-composed text (sender-name prefix already applied if enabled). */
  text: string;
  voiceURI?: string;
  rate: number;
  pitch: number;
  volume: number;
  /** For log correlation with the main-process decision row. */
  messageId: string;
}

/**
 * Payload shape for `IPC.TTS_LOG`. `event` is a stable lowercase identifier;
 * `data` is an arbitrary JSON-serialisable bag (utterance id, retry count,
 * watchdog reason, etc.). `ts` is filled by the main-process handler so we
 * don't trust renderer clock drift.
 */
export interface TtsLogEvent {
  event:
    | 'speak_called'
    | 'onstart'
    | 'onend'
    | 'onerror'
    | 'watchdog_fired'
    | 'onstart_watchdog_retry'
    | 'keepalive_fired'
    | 'cancel_called'
    // v0.1.42 native-engine events. Emitted from `NativeTtsEngine` in
    // the main process; persisted to the same JSONL file so native +
    // browser events appear in one timeline ordered by wall clock.
    | 'native_speak_start'
    | 'native_speak_end'
    | 'native_speak_error'
    | 'native_speak_killed'
    | 'native_queue_size'
    // v0.1.73 (Ethan voice 4364, 2026-05-28) — explicit decision-gate
    // logging. EVERY message that flows through the App.tsx side-effect
    // useEffect now emits one of these rows BEFORE the engine is called
    // (or BEFORE the skip is taken). The `data` payload always carries
    // `{ messageId, username, platform, decision, reason }` plus path-
    // specific extras (regex source line for content-regex / username-
    // regex hits, etc). The two paths are logged INDEPENDENTLY so a
    // message that's TTS-skipped but notification-allowed shows two
    // rows with different `decision` fields — that's the contract.
    //
    // Why this matters: before v0.1.73 the only TTS log row was the
    // engine-level `speak_called`. If a message was filtered out
    // upstream (regex, hidden user, self-ignore, disabled, etc) there
    // was NO row indicating "we saw this message and decided not to
    // speak it" — so a user reporting "this didn't get read aloud"
    // couldn't be answered by grepping the log. Voice 4364 explicitly
    // called this out: "Is there something indicating it was read
    // aloud? If not, we need to add that to the logs, but, like,
    // that's fucked."
    | 'tts_decision'
    | 'notification_decision'
    // v0.1.74 (Ethan voice 4407, 2026-05-30) — background-TTS fix. Emitted
    // by the renderer browser `TTSEngine` when it detects the page is
    // hidden/occluded (so `window.speechSynthesis` is suspended) and
    // therefore routes the utterance through the native main-process `say`
    // bridge instead. Lets a forensic grep confirm "this message was voiced
    // via the background fallback path, not Web Speech" — which is exactly
    // the case the user couldn't previously diagnose.
    | 'background_native_fallback';
  data?: Record<string, unknown>;
}

/**
 * v0.1.73 — decision-gate reason taxonomy. Stable lowercase identifiers so
 * `tts-events.jsonl` rows can be grouped by reason for forensic analysis.
 *
 * `read` / `notify` is the single success-path reason emitted alongside
 * `decision: 'read'` (TTS) or `decision: 'notify'` (notifications). All
 * other reasons fire with `decision: 'skip'`.
 *
 * Keep this union in lock-step with the literals emitted from
 * `decideSideEffects` in src/renderer/side-effect-decision.ts.
 */
export type TtsDecisionReason =
  // SUCCESS — emit alongside `decision: 'read'` (TTS path) only.
  | 'read'
  // SKIP reasons (in roughly the order they're checked):
  // - 'pending-send': optimistic placeholder, not the WS-confirmed echo
  // - 'same-id-reprocess': useEffect re-fire for an already-spoken id
  // - 'self': v0.1.72 self-ignore — local user's own outgoing message
  // - 'platform-disabled': settings.filter.platforms[m.platform] === false
  // - 'hidden-user': username in settings.hiddenUsers
  // - 'engine-disabled': settings.tts.enabled === false
  // - 'muted': v0.1.77 settings.tts.muted === true (header 🔇 one-click mute)
  // - 'content-regex': matched a ttsIgnoreRegex / content axis
  // - 'username-regex': matched a ttsIgnoreUsernameRegex / username axis
  | 'pending-send'
  | 'same-id-reprocess'
  | 'self'
  | 'platform-disabled'
  | 'hidden-user'
  | 'engine-disabled'
  // v0.1.77 (Ethan voice 4438) — one-click mute. Distinct from
  // 'engine-disabled' so the forensic log can tell "TTS feature is off" apart
  // from "user tapped the header mute button". Only the TTS path has this
  // reason; the notification path is unaffected (mute is about SPEECH only).
  | 'muted'
  | 'content-regex'
  | 'username-regex';

/**
 * v0.1.73 — same shape as TtsDecisionReason but for the native-notification
 * side-effect path. The two paths have distinct enabled-flags + distinct
 * regex axes, so we keep the type unions separate even though the literals
 * overlap. `rate-limited` is unique to the notification path (the renderer
 * RateLimiter caps `maxPerMinute`).
 */
export type NotificationDecisionReason =
  | 'notify'
  | 'pending-send'
  | 'same-id-reprocess'
  | 'self'
  | 'platform-disabled'
  | 'hidden-user'
  | 'engine-disabled'
  | 'content-regex'
  | 'username-regex'
  | 'rate-limited';

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
  /**
   * v0.1.61 — extra Squirrel `download-progress` fields. Populated when
   * `kind === 'downloading'` if Squirrel.Mac emits them (older builds may
   * only emit `percent`, so all of these stay optional). Surfaced in the
   * banner as bytes-downloaded / bytes-total / KB/s so the user sees
   * concrete activity (Voice 3760, 2026-05-23: "I get a snap about
   * downloading update but then nothing happens. I need some feedback
   * saying it's actually downloading still").
   */
  downloadBytesTransferred?: number;
  downloadBytesTotal?: number;
  downloadBytesPerSecond?: number;
  /**
   * v0.1.61 — epoch ms when the renderer first saw `downloadInFlight` go
   * true (set in `triggerSquirrelDownload`). Lets the banner show
   * elapsed time and detect "Squirrel hasn't reported any progress in N
   * seconds → likely a silent failure" cases. Carried across every
   * downloading-state broadcast so the banner doesn't need to track it.
   */
  downloadStartedAt?: number;
  /**
   * v0.1.61 — populated when `kind === 'error'`. Together with `error`
   * the banner offers a 'Open GitHub Releases' button so the user can
   * always finish a failed update manually.
   */
  errorReleaseUrl?: string;
  /**
   * v0.1.61 — coarse error category so the banner can pick the right
   * user-facing wording without sniffing the raw `error` string at the
   * render layer. Populated when `kind === 'error'`.
   *
   *   - 'signature-mismatch' → the staged bundle's code signature did
   *     not satisfy the running app's designated requirement. Most
   *     commonly fires when the running app is ad-hoc / development-
   *     signed and the published release is Developer-ID signed (or
   *     vice versa). Recovery is a manual reinstall.
   *   - 'network'            → DNS, TLS, connection refused, 5xx, etc.
   *   - 'staging'            → ShipIt staging dir errors (disk full,
   *     permissions). Manual reinstall usually fixes.
   *   - 'unknown'            → catch-all.
   */
  errorCategory?: 'signature-mismatch' | 'network' | 'staging' | 'unknown';
  /** Error message — populated when kind === 'error'. */
  error?: string;
  /** Epoch ms of when this check completed. */
  checkedAt: number;
}

/**
 * v0.1.71 (cold-start flicker fix — voice 4198, 2026-05-26).
 *
 * Tracks the renderer's view of "have we resolved the user's auth state yet?"
 *
 * BUG IT FIXES: pre-v0.1.71 the renderer's `auth` state defaulted to
 * `{ authenticated: false }` synchronously at mount, BEFORE the main process
 * had finished its async `oauth.getTokenAsync()` decrypt + the deferred
 * `pushAuthStatus()` (~1-2 sec on cold start). During that window the
 * toolbar rendered the "Sign in to Restream" button. The user could (and
 * did, on 2026-05-26) accidentally click it and kick off a fresh OAuth
 * round-trip they didn't want.
 *
 * Fix: the renderer's UI now keys off this discriminator. While we're in
 * `'checking'`, we render a centered spinner overlay that blocks the
 * Sign In button (and any other auth-keyed UI). The very first
 * AUTH_STATUS we observe — whether from the initial `await rcpp.authStatus()`
 * pull OR the deferred `onAuthStatus` push — transitions us to
 * `'signed_in'` or `'signed_out'` and the spinner disappears.
 *
 * State values:
 *   - `'checking'`           — initial; main process hasn't told us yet.
 *   - `'checking-slow'`      — same as `'checking'` but >5s elapsed. UI
 *                              adds a "Still checking…" subtitle so the
 *                              user doesn't think the app is hung.
 *   - `'signed_in'`          — terminal; first AUTH_STATUS had
 *                              `authenticated: true`.
 *   - `'signed_out'`         — terminal; first AUTH_STATUS had
 *                              `authenticated: false`.
 *   - `'verify_failed'`      — 15s elapsed with NO AUTH_STATUS. UI offers
 *                              a "Couldn't verify sign-in — try again"
 *                              affordance with a retry button that
 *                              re-runs `rcpp.authStatus()`.
 *
 * Pairs with `tokenLikelyValid` / `reconnectingDueToTransient` for the
 * orthogonal mid-session refresh case (v0.1.70). Those handle "we WERE
 * signed in, hit a network blip, recovering"; this handles "we don't
 * know yet, please wait".
 */
export type AuthBootState =
  | 'checking'
  | 'checking-slow'
  | 'signed_in'
  | 'signed_out'
  | 'verify_failed';

export interface AuthStatus {
  authenticated: boolean;
  scope?: string;
  expiresAt?: number;
  /**
   * v0.1.70 (sign-out diagnosis 2026-05-25): `tokenEnc` is still on disk
   * AND the main process is in the transient-refresh-retry loop. The
   * renderer should NOT render the bare "Sign in to Restream" CTA in
   * this state — show a "Reconnecting…" banner with a "Retry now" button
   * instead, so a single network blip never tricks the user into thinking
   * they got signed out (the v0.1.67 → v0.1.70 bug).
   *
   * Pairs with `authenticated: false`: if authenticated is true, this
   * field is irrelevant (the renderer's normal signed-in UI takes over).
   */
  tokenLikelyValid?: boolean;
  /**
   * v0.1.70 (sign-out diagnosis 2026-05-25): explicit signal that we're
   * in a transient-failure self-healing state (refresh threw / 5xx, retry
   * armed). Renderer uses this together with `tokenLikelyValid=true` to
   * render the "Reconnecting — your session may resume automatically.
   * <Retry now>" banner instead of the bare sign-in screen.
   *
   * Separated from `tokenLikelyValid` so the field's intent stays
   * single-purpose: `tokenLikelyValid` = "don't show sign-in CTA",
   * `reconnectingDueToTransient` = "show recovery affordance".
   */
  reconnectingDueToTransient?: boolean;
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

/**
 * v0.1.43 — wire payload for a single `CHAT_SEND_ENQUEUE` IPC. The
 * renderer mints `clientId` (UUID) and uses it as BOTH the optimistic
 * message id in the local feed AND the Restream `clientReplyUuid`. When
 * the WS rebroadcasts the `reply_created` echo, the normaliser surfaces
 * a ChatMessage with the SAME `id` — the renderer deduplicates by
 * matching ids and drops the optimistic placeholder in favour of the
 * echo.
 */
export interface ChatSendEnqueuePayload {
  clientId: string;
  text: string;
}

/**
 * v0.1.43 — lifecycle status for a queued chat send, broadcast over
 * `CHAT_SEND_STATUS`.
 *
 *   - `pending`  — the main-process queue accepted the enqueue. The
 *                  renderer already shows the optimistic placeholder; this
 *                  is a no-op confirmation but useful for tests / future
 *                  debug instrumentation.
 *   - `sent`     — the POST returned 2xx. The renderer can downgrade any
 *                  "sending…" affordance; the WS echo (matched by
 *                  clientReplyUuid → message id) is what actually
 *                  replaces the placeholder in the feed.
 *   - `failed`   — the POST failed (or the queue dropped the send for a
 *                  pre-POST reason — auth, cookies, no connections, etc.).
 *                  Renderer keeps the optimistic message in the feed with
 *                  a small ⚠ icon + tooltip carrying `error`. Subsequent
 *                  sends are NEVER blocked by a single failure.
 */
export interface ChatSendStatus {
  clientId: string;
  status: 'pending' | 'sent' | 'failed';
  /**
   * When status==='failed', the reason code from SendTextResult.
   *
   * v0.1.63 adds renderer-local `timeout`: this does not come from Restream
   * or the main process. It is the second-line safety net when an optimistic
   * placeholder receives neither a WS echo nor an explicit queue failure.
   */
  reason?: SendTextResult['reason'] | 'timeout';
  /** When status==='failed', a human-readable error string. */
  error?: string;
  /** When status==='failed', the HTTP status (if the failure was a non-2xx). */
  httpStatus?: number;
}
