import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ChatConnection,
  ChatMessage,
  ConnectionState,
  Platform,
} from '../shared/types';
import type { ChatContext } from './chat-send';
import { normalizeRestreamEventDetailed } from './normalize';

/**
 * Resolve Electron's `app` lazily so this module can also be imported from
 * unit tests where the `electron` module isn't available. Returns undefined
 * outside of an Electron main-process context.
 */
function tryGetElectronApp(): { getPath?: (name: string) => string } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron')?.app;
  } catch {
    return undefined;
  }
}

const RESTREAM_WS_URL = 'wss://chat.api.restream.io/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const RAW_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB before rotating

export interface ChatClientEvents {
  message: (m: ChatMessage) => void;
  state: (s: ConnectionState) => void;
  raw: (raw: unknown) => void;
  /**
   * Emitted whenever the map of Restream `connection_info` entries
   * changes (new connect, status flip, close). Receivers get the full
   * deduped list sorted by platform — see ChatConnection in shared/types.
   * Used by the channels panel in the renderer to show N connected
   * channels + per-platform expansion.
   */
  connections: (cs: ChatConnection[]) => void;
}

/**
 * Restream Chat WebSocket subscriber.
 *
 * - Connects to wss://chat.api.restream.io/ws?accessToken=<bearer>
 * - Heartbeats with a periodic ping
 * - Reconnects with exponential backoff on close/error
 * - Normalises events through normalizeRestreamEvent and emits ChatMessage
 */
export class ChatClient extends EventEmitter {
  private ws?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private attempt = 0;
  private accessToken?: string;
  private stopped = false;
  private state: ConnectionState = { status: 'idle', attempt: 0 };
  private rawLogPath?: string;
  private rawLogResolved = false;
  /**
   * Map of Restream connection_info entries keyed by connectionIdentifier.
   * Replaces on every fresh connection_info, deleted on connection_closed
   * matching the stored connectionUuid (per Restream's docs).
   *
   * Reset on every fresh WS connect so a reconnect doesn't accumulate
   * stale entries from a previous session.
   */
  private connections = new Map<string, ChatConnection>();

  /**
   * The current Restream chat context — the `{showId, eventId, instant}`
   * triple-tagged union the chat backend uses to scope a `POST /client/reply`
   * to the right show/event/instant stream. Exactly one field is
   * authoritative on any given WS session.
   *
   * v0.1.34: replaced the legacy `showId?: string` field. The previous
   * code treated `/v2/user/events/in-progress[0].id` as a showId, but
   * Restream's public docs make clear that `id` is an **event** id; the
   * chat backend expects `eventId` in the body when scoping by that. The
   * live chat.restream.io webchat reads all three identifiers from URL
   * params and sends whichever is set, in priority `showId > eventId >
   * instant`. We mirror that contract here.
   *
   * We sniff `eventId` and `showId` from incoming WS frames — every
   * `event` and `reply_created` frame carries one or both. Frames don't
   * carry `instant` directly; that comes from the REST hydration path
   * (a `/v2/user/events/in-progress` entry whose `id === "rtmp/instant"`
   * or whose scheduling fields are null).
   *
   * Reset on every fresh WS connect so a reconnect doesn't smuggle a
   * stale context across an account switch.
   */
  private chatContext: ChatContext = {};

  setToken(token: string) {
    this.accessToken = token;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.ws?.removeAllListeners();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = undefined;
    this.setState({ status: 'disconnected', attempt: 0 });
  }

  /**
   * Force-tear-down the current WebSocket (if any) and immediately attempt a
   * fresh connection using the stored access token. Bypasses the exponential
   * backoff timer — this is the user-driven "Reconnect" flow surfaced via
   * the toolbar refresh button. Safe to call from any state.
   *
   * The token-refresh path is intentionally NOT handled here: the caller
   * (main.ts IPC handler) is responsible for refreshing OAuth first if the
   * stored token is expired, then calling reconnect(). This keeps the WS
   * client free of credential-store / OAuth coupling.
   */
  reconnect() {
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
      } catch {
        // ignore
      }
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = undefined;
    }
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Snapshot the current connection_info map as a sorted array. Used by
   * the pull-fetch IPC handler so the renderer can sync on mount without
   * waiting for the next connection_info push.
   */
  getConnections(): ChatConnection[] {
    return sortConnections(Array.from(this.connections.values()));
  }

  /**
   * Snapshot the latest chat context sniffed from incoming WS frames
   * (`{showId, eventId, instant}`). Empty `{}` if no frame has been seen
   * yet (e.g. WS just connected, no events / replies received). The inline
   * send path threads this into the `POST /client/reply` body — see the
   * field-level comment on `this.chatContext` above for the why.
   *
   * v0.1.34: replaces `getShowId(): string | undefined`. Returns a shallow
   * copy so callers can't mutate internal state.
   */
  getChatContext(): ChatContext {
    return { ...this.chatContext };
  }

  /**
   * Drop the cached chat context without tearing down the WS. Used by the
   * inline-send retry path when a POST 404s — the context we held was
   * stale-but-present (Restream returned the format-valid value across an
   * `event_ended` boundary, or the user re-streamed and the event id
   * rolled over). The next sniff on an incoming frame will re-populate
   * it; until then `getChatContext()` returns `{}` so the send path falls
   * back to a REST hydration.
   *
   * v0.1.34: replaces `invalidateShowId()`.
   */
  invalidateChatContext(): void {
    this.chatContext = {};
  }

  /**
   * Public accessor so the main process can resolve / expose the raw-frame
   * log path (e.g. for a "Reveal Logs in Finder" menu item) without having
   * to duplicate the platform-specific path-resolution logic. Returns
   * undefined if the path couldn't be resolved (no Electron app, no fs).
   */
  getRawLogPath(): string | undefined {
    return this.resolveRawLogPath();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private connect() {
    if (!this.accessToken) {
      this.setState({ status: 'error', attempt: this.attempt, lastError: 'no token' });
      return;
    }
    // Clear stale connections — Restream replays all current connection_info
    // entries on every fresh subscribe, so anything left in the map is by
    // definition out of date and would mislead the channels panel.
    if (this.connections.size > 0) {
      this.connections.clear();
      this.emit('connections', this.getConnections());
    }
    // Drop any cached chat context — a reconnect may be onto a different
    // account / event / show. We'll re-sniff it from the first event /
    // reply frame we see. v0.1.34.
    this.chatContext = {};
    this.setState({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      attempt: this.attempt,
    });
    const url = `${RESTREAM_WS_URL}?accessToken=${encodeURIComponent(this.accessToken)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.setState({ status: 'connected', attempt: 0 });
      this.startHeartbeat();
    });

    ws.on('message', (data) => {
      const text = data.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        this.appendRawLog({ kind: 'parse-error', text, err: String(err) });
        return;
      }
      this.appendRawLog({ kind: 'frame', frame: parsed });
      this.emit('raw', parsed);

      // v0.1.34: sniff the full chat context (`showId`, `eventId`,
      // `instant`) from any frame that carries one (`event`,
      // `reply_created`, etc). Restream's `POST /client/reply` accepts
      // exactly one of these as the scope identifier — see chat-send.ts
      // for the priority order. Cache the latest non-empty values;
      // subsequent frames with the same values are idempotent. We don't
      // gate on action type because the chat context is the same across
      // all frames in a given WS session.
      try {
        const payload = (parsed as any)?.payload;
        if (payload && typeof payload === 'object') {
          const sid = payload.showId;
          if (typeof sid === 'string' && sid && sid !== this.chatContext.showId) {
            this.chatContext.showId = sid;
          }
          const eid = payload.eventId;
          if (typeof eid === 'string' && eid && eid !== this.chatContext.eventId) {
            this.chatContext.eventId = eid;
          }
          // Restream's payloads occasionally include a boolean `instant`
          // flag (true on RTMP/instant streams). We mirror it so the
          // chat-send body can carry `instant: true` for streams that
          // have no scheduled-event id.
          if (payload.instant === true && !this.chatContext.instant) {
            this.chatContext.instant = true;
          }
        }
      } catch {
        // never break delivery on a sniff failure
      }

      // Server-level connection-info / connection-closed surfaces are useful
      // signal (e.g. Twitch channel disconnected, YouTube broadcast ended).
      // Log them as their own kind so Ethan can see *why* a stream went quiet
      // without grepping for frame.payload.status === 'error'. These do NOT
      // affect our overall ChatClient status — the WS itself is still healthy.
      //
      // We also feed connection_info / connection_closed into the in-memory
      // connections map so the renderer's channels panel stays in sync.
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, any>;
        if (p.action === 'connection_info') {
          if (p.payload?.status === 'error') {
            this.appendRawLog({
              kind: 'connection-info-error',
              eventSourceId: p.payload?.eventSourceId,
              reason: p.payload?.reason,
              connectionIdentifier: p.payload?.connectionIdentifier,
            });
          }
          this.applyConnectionInfo(p.payload);
        } else if (p.action === 'connection_closed') {
          this.appendRawLog({
            kind: 'connection-closed',
            connectionUuid: p.payload?.connectionUuid,
            reason: p.payload?.reason,
          });
          this.applyConnectionClosed(p.payload);
        }
      }

      const result = normalizeRestreamEventDetailed(parsed);
      if (result.message) {
        this.emit('message', result.message);
      } else if (result.drop) {
        // Surface silent drops so we can see why a real event isn't reaching
        // the UI. Heartbeats and connection_info will fall through as
        // 'not-event-action' — those are expected. 'no-text' on an event
        // action is the interesting one (= shape mismatch we should fix).
        if (result.drop.reason !== 'not-event-action') {
          this.appendRawLog({
            kind: 'drop',
            reason: result.drop.reason,
            eventTypeId: result.drop.eventTypeId,
            frame: parsed,
          });
        }
      }
    });

    ws.on('pong', () => {
      // healthy
    });

    ws.on('close', (code, reason) => {
      this.handleDisconnect(`close ${code} ${reason?.toString() ?? ''}`);
    });

    ws.on('error', (err) => {
      this.handleDisconnect(err.message || 'ws error');
    });
  }

  private handleDisconnect(reason: string) {
    this.clearTimers();
    if (this.stopped) return;
    this.attempt += 1;
    const backoff = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * Math.pow(2, Math.min(10, this.attempt - 1)),
    );
    this.setState({ status: 'reconnecting', attempt: this.attempt, lastError: reason });
    this.reconnectTimer = setTimeout(() => this.connect(), backoff);
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // ignore — next reconnect will handle
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearTimers() {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.emit('state', s);
  }

  // ------------------------------------------------------------------
  // raw-frame logging
  // ------------------------------------------------------------------

  /**
   * Append a single record (one JSON object per line — JSONL) to the raw
   * frame log. Path resolves to:
   *   macOS:   ~/Library/Logs/Restream Chat Plus Plus/raw-frames.jsonl
   *   linux:   ~/.config/Restream Chat Plus Plus/logs/raw-frames.jsonl
   *   win:     %APPDATA%/Restream Chat Plus Plus/logs/raw-frames.jsonl
   *
   * The file rotates once it exceeds 5 MiB (renamed to .1, current file
   * truncated). Failures are swallowed — logging must never break delivery.
   */
  private appendRawLog(record: Record<string, unknown>): void {
    try {
      const p = this.resolveRawLogPath();
      if (!p) return;
      const line =
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
      // Rotate if over the cap.
      try {
        const st = fs.statSync(p);
        if (st.size > RAW_LOG_MAX_BYTES) {
          fs.renameSync(p, p + '.1');
        }
      } catch {
        // file may not exist yet — fine
      }
      fs.appendFileSync(p, line, 'utf8');
    } catch {
      // never break delivery on a logging failure
    }
  }

  /**
   * Fold a `connection_info` payload into the in-memory connections map.
   * Restream documents that we should keep the LAST received payload per
   * `connectionIdentifier` — so plain `Map.set` is correct here (no merge).
   * Emits a `connections` event whenever the resulting list differs from
   * what we previously had, so the renderer doesn't redraw on duplicate
   * frames (Restream sometimes repeats them).
   */
  private applyConnectionInfo(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, any>;
    const connectionIdentifier = p.connectionIdentifier;
    if (typeof connectionIdentifier !== 'string') return;
    const next: ChatConnection = {
      connectionIdentifier,
      connectionUuid: String(p.connectionUuid ?? ''),
      eventSourceId: Number(p.eventSourceId ?? 0),
      platform: platformFromEventSourceId(p.eventSourceId, connectionIdentifier),
      status: p.status === 'connected' || p.status === 'error' || p.status === 'connecting'
        ? p.status
        : 'connecting',
      reason: p.reason ?? null,
      channelName: extractChannelName(p.target),
      avatarUrl: extractAvatar(p.target),
      url: extractUrl(p.target),
      updatedAt: Date.now(),
    };
    const prev = this.connections.get(connectionIdentifier);
    if (prev && connectionsEqual(prev, next)) return; // skip noisy duplicates
    this.connections.set(connectionIdentifier, next);
    this.emit('connections', this.getConnections());
  }

  /**
   * Remove the entry whose `connectionUuid` matches the closed-frame's
   * uuid. Per Restream docs (https://developers.restream.io/chat/connections)
   * we use connectionUuid here, NOT connectionIdentifier — the latter can
   * have been overwritten by a fresher replacement connection.
   */
  private applyConnectionClosed(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, any>;
    const uuid = p.connectionUuid;
    if (typeof uuid !== 'string') return;
    let changed = false;
    for (const [key, entry] of this.connections) {
      if (entry.connectionUuid === uuid) {
        this.connections.delete(key);
        changed = true;
        break;
      }
    }
    if (changed) this.emit('connections', this.getConnections());
  }

  private resolveRawLogPath(): string | undefined {
    if (this.rawLogResolved) return this.rawLogPath;
    this.rawLogResolved = true;
    try {
      let dir: string;
      // `app` may be undefined in unit tests; guard accordingly.
      const electronApp = tryGetElectronApp();
      if (electronApp && typeof electronApp.getPath === 'function') {
        // electron's 'logs' path is platform-appropriate already.
        dir = electronApp.getPath('logs');
      } else if (process.platform === 'darwin') {
        dir = path.join(os.homedir(), 'Library', 'Logs', 'Restream Chat Plus Plus');
      } else if (process.platform === 'win32') {
        dir = path.join(
          process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
          'Restream Chat Plus Plus',
          'logs',
        );
      } else {
        dir = path.join(os.homedir(), '.config', 'Restream Chat Plus Plus', 'logs');
      }
      fs.mkdirSync(dir, { recursive: true });
      this.rawLogPath = path.join(dir, 'raw-frames.jsonl');
      return this.rawLogPath;
    } catch {
      this.rawLogPath = undefined;
      return undefined;
    }
  }
}

// Re-export Backoff math for unit tests.
export const __test_backoff_for = (attempt: number): number =>
  Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(10, attempt - 1)));

// ---------------------------------------------------------------------------
// Connection helpers (free-standing so they're trivially unit-testable and
// not bound to the EventEmitter class instance).
// ---------------------------------------------------------------------------

const PLATFORM_ORDER: Platform[] = [
  'twitch',
  'youtube',
  'kick',
  'facebook',
  'trovo',
  'rumble',
  'tiktok',
  'x',
  'unknown',
];

/**
 * Map Restream eventSourceId → Platform, falling back to parsing the
 * platform slug out of the connectionIdentifier
 * ("<userId>-<platform>-<channelId>") so that DLive / Discord etc — for
 * which we don't have a Platform yet — still surface useful badge data.
 */
function platformFromEventSourceId(
  eventSourceId: unknown,
  connectionIdentifier: string,
): Platform {
  switch (eventSourceId) {
    case 2:
      return 'twitch';
    case 13:
      return 'youtube';
    case 20:
      return 'facebook';
    case 26:
      return 'kick';
    case 27:
      return 'trovo';
    case 28:
      return 'x';
    case 29:
      return 'rumble';
    default:
      break;
  }
  // Fallback: scrape the platform from connectionIdentifier's middle segment.
  const parts = connectionIdentifier.split('-');
  if (parts.length >= 2) {
    const slug = parts[1].toLowerCase();
    if (slug === 'twitch') return 'twitch';
    if (slug === 'youtube') return 'youtube';
    if (slug === 'facebook') return 'facebook';
    if (slug === 'kick') return 'kick';
    if (slug === 'trovo') return 'trovo';
    if (slug === 'rumble') return 'rumble';
    if (slug === 'tiktok') return 'tiktok';
    if (slug === 'twitter' || slug === 'x') return 'x';
  }
  return 'unknown';
}

function extractChannelName(target: unknown): string | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const t = target as Record<string, any>;
  // Order matters: Discord's `target.channel.name` is the discord channel
  // (the actual "where chat appears" entity) and should win over
  // `target.owner.name` (the user who linked it). For Twitch / YouTube /
  // Kick / Trovo the channel-relevant identity lives on `owner.displayName`.
  return (
    t.channel?.name ??
    t.page?.name ??
    t.owner?.displayName ??
    t.owner?.name ??
    t.owner?.username ??
    t.user?.name ??
    t.organization?.name ??
    t.event?.title ??
    undefined
  );
}

function extractAvatar(target: unknown): string | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const t = target as Record<string, any>;
  return (
    t.owner?.avatar ??
    t.user?.avatar ??
    t.page?.picture ??
    t.server?.icon ??
    t.organization?.avatarUrl ??
    undefined
  );
}

function extractUrl(target: unknown): string | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const t = target as Record<string, any>;
  return (
    t.owner?.url ??
    t.channel?.url ??
    t.event?.url ??
    t.liveVideo?.url ??
    t.post?.url ??
    undefined
  );
}

function connectionsEqual(a: ChatConnection, b: ChatConnection): boolean {
  return (
    a.connectionUuid === b.connectionUuid &&
    a.status === b.status &&
    a.reason === b.reason &&
    a.channelName === b.channelName &&
    a.platform === b.platform &&
    a.url === b.url &&
    a.avatarUrl === b.avatarUrl
  );
}

function sortConnections(list: ChatConnection[]): ChatConnection[] {
  return list.slice().sort((a, b) => {
    const ai = PLATFORM_ORDER.indexOf(a.platform);
    const bi = PLATFORM_ORDER.indexOf(b.platform);
    if (ai !== bi) return ai - bi;
    const an = a.channelName ?? '';
    const bn = b.channelName ?? '';
    return an.localeCompare(bn);
  });
}

// Re-export for unit tests.
export const __test_helpers = {
  platformFromEventSourceId,
  extractChannelName,
  sortConnections,
};
