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
   */
  self?: boolean;
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
   * Open Restream's official webchat compose window in a separate
   * BrowserWindow. Restream's Chat API is RECEIVE-ONLY for third-party
   * clients (https://developers.restream.io/chat/getting-started: "This
   * API works one way — from the server to the client. The server will
   * ignore any incoming messages.") so to actually send a message we
   * delegate to Restream's first-party webchat URL, which uses the
   * private API internally. The reply we send through that window comes
   * BACK to us as a normal `reply_created` WS frame, which we now render
   * as a `self: true` ChatMessage in the feed.
   */
  CHAT_OPEN_COMPOSE: 'chat:open-compose',
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
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  NOTIFY: 'notify',
  REVEAL_LOGS: 'logs:reveal',
} as const;

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
 *  - `send-failed`           — POST /client/reply returned non-2xx.
 *  - `error`                 — unexpected (network / JS) failure.
 */
export interface SendTextResult {
  ok: boolean;
  reason?:
    | 'not-authenticated'
    | 'no-session-cookies'
    | 'no-active-connections'
    | 'send-failed'
    | 'error';
  status?: number;
  error?: string;
}
