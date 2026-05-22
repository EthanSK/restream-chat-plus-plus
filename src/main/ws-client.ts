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

/**
 * Auto-reconnect retry cadence.
 *
 * v0.1.45: introduced — every 60s while disconnected, run the same flow
 * as the manual Reconnect button (OAuth refresh → chat.reconnect).
 *
 * v0.1.47: **auto-reconnect is DISABLED by default** (Ethan voice 3630 —
 * the 60s loop and the legacy exponential-backoff path were both
 * generating constant network traffic against api.restream.io that
 * Ethan suspected was clogging his Wi-Fi / ISP). On any disconnect we
 * now flip to `disconnected` and stay there until the user manually
 * clicks Reconnect (which goes through `performFullReconnect()` →
 * `chat.reconnect()` and is unaffected by this change). The interval
 * constant + `setReconnectProvider` / `setAutoAttemptListener` API
 * surface are kept so the v0.1.45 unit tests can still opt-in via
 * `setAutoReconnectEnabled(true)`, but the default for the shipped app
 * is OFF. To restore the old behaviour app-wide, set
 * `client.setAutoReconnectEnabled(true)` from main.ts.
 */
const AUTO_RETRY_INTERVAL_MS = 60_000;

/**
 * v0.1.49: one-shot initial-connect retry delay.
 *
 * If the FIRST WS handshake after `start()` / `reconnect()` closes
 * before reaching `connected`, we retry exactly ONCE after this delay.
 * Picked at 5s to give a transient network/server blip room to clear
 * without making the user wait too long. Subsequent failures fall back
 * to the v0.1.47 default of "sit at `disconnected` until the user
 * clicks Reconnect" — we don't loop. See the field-level comment on
 * `initialRetryUsedThisSession` in `ChatClient` for the rationale.
 */
const INITIAL_CONNECT_RETRY_MS = 5_000;

/**
 * v0.1.51: window during which a CONNECTED-then-CLOSED transition is
 * treated as an "early close" eligible for ONE retry.
 *
 * Ethan voice 3709: v0.1.50 update applied, still stuck on idle. The
 * earlier v0.1.49/v0.1.50 fixes covered the pre-`'open'` path (handshake
 * never completes). But the production failure mode we now see in logs
 * is **the WS opens successfully, frames flow for a second or two, then
 * the server fires `'close'`** — e.g. Restream sends `connection_replaced`
 * when another client (browser tab, `chat.restream.io` webchat, the prior
 * app instance still alive after a Sparkle update swap) connects with
 * the same token; or a server-side auth reject immediately post-handshake.
 *
 * Pre-v0.1.51 behaviour: `'open'` flips `hasEverConnectedThisSession=true`,
 * the subsequent close hits the v0.1.47 short-circuit (`autoReconnectEnabled=false`
 * AND `hasEverConnectedThisSession=true`) and goes straight to
 * `disconnected` — silently, with NO entry in `reconnect-events.jsonl`.
 *
 * v0.1.51 fix: if the close fires within `EARLY_CLOSE_WINDOW_MS` of the
 * `'open'` event, treat it like an initial-connect failure and schedule
 * exactly ONE retry via the unified-reconnect provider — same one-shot
 * budget as the v0.1.49 initial-retry, just gated on an EXTRA flag
 * (`earlyCloseRetryUsedThisSession`) so the two budgets don't collide.
 *
 * Picked at 30s: long enough to cover a `connection_replaced` from a
 * slow second client, short enough that genuine mid-session drops (an
 * hour-long stream that loses Wi-Fi) still go through the normal
 * "stay at disconnected, wait for manual button" path Ethan wants. The
 * 30s window is wall-clock from the `'open'` event, NOT cumulative
 * uptime, so a session that flapped open→close→open→close in <30s
 * each leg only consumes ONE retry total — the budget guard prevents
 * the 5s polling regression v0.1.50 fixed.
 */
const EARLY_CLOSE_WINDOW_MS = 30_000;

/**
 * Result returned by the `reconnectProvider` hook. `ok` indicates whether
 * the WS handshake will be attempted with a fresh token (i.e. OAuth refresh
 * succeeded if needed AND `chat.reconnect()` fired). When `ok: false`, the
 * `reason` is surfaced to the reconnect-events log so Ethan can see WHY the
 * retry didn't fire (no-token / refresh-failed / threw).
 */
export interface ReconnectAttemptOutcome {
  ok: boolean;
  reason?: string;
}

/**
 * Hook injected by main.ts so the WS client can call the SAME full
 * reconnect flow on auto-retry as the manual Reconnect toolbar button.
 * v0.1.45 — see the file-level comment above and main.ts's
 * `performFullReconnect()`.
 *
 * Callers must NOT swallow errors silently — the hook should still
 * resolve, with `{ ok: false, reason: '...' }` on failure, so the WS
 * client can schedule another retry.
 */
export type ReconnectProvider = () => Promise<ReconnectAttemptOutcome>;

/**
 * One auto-reconnect attempt record, fed into the optional attempt
 * listener so callers can persist a JSONL audit trail. We keep the wire
 * format minimal + JSON-safe — main.ts adds `ts` + serialises.
 */
export interface AutoReconnectAttempt {
  attempt: number;
  reason: string;
  outcome: 'ok' | 'failed';
  failureReason?: string;
}

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
   * Hook installed by main.ts so the auto-reconnect path uses the SAME
   * OAuth-refresh + chat.reconnect() flow as the manual Reconnect toolbar
   * button (`performFullReconnect()` in main.ts). v0.1.45 fix — see the
   * file-level comment on AUTO_RETRY_INTERVAL_MS for the bug history.
   *
   * Optional so unit tests + early-boot code paths can run without it.
   * When NOT set the WS client falls back to its legacy behaviour: bare
   * `this.connect()` retry with the cached (possibly stale) access token.
   * That fallback is preserved purely so existing tests still pass — the
   * real app installs the hook on app.ready before `chat.start()` is ever
   * called.
   */
  private reconnectProvider?: ReconnectProvider;
  /**
   * Suppresses overlapping retries when a provider call is already
   * in-flight. Set true at the moment we invoke the provider; cleared
   * once it resolves. The next state-change (connected / disconnected)
   * decides whether to schedule another retry.
   */
  private providerInFlight = false;
  /**
   * v0.1.47: Master switch for the auto-reconnect timer. Default OFF
   * (see file-level comment on `AUTO_RETRY_INTERVAL_MS` — Ethan voice
   * 3630). When false, `handleDisconnect` flips state to `disconnected`
   * and does NOT schedule any retry timer. Manual `reconnect()` (the
   * toolbar button) is unaffected because it bypasses
   * `handleDisconnect`. Tests can set this to true to exercise the
   * v0.1.45 unified-provider behaviour.
   */
  private autoReconnectEnabled = false;
  /**
   * v0.1.49: one-shot recovery on the initial connect path.
   *
   * The bug v0.1.49 fixes (Ethan voice 3692, "Restream Chat++ is stuck on
   * idle. I just signed in. Can you investigate?"): with auto-reconnect
   * fully OFF (v0.1.47 default), if the very first WS handshake after
   * `start()` / `reconnect()` ever closes / errors before reaching the
   * `connected` state — a network blip during boot, an api.restream.io
   * blip during the handshake, a TLS hiccup — the client flips straight
   * to `disconnected` and stays there, leaving the user with no live
   * connection and no automatic recovery. The only escape is the manual
   * Reconnect toolbar button, but the user may not realise they need to
   * click it (the UI just shows "Disconnected" or, on first launch
   * before any state has flipped, the leftover initial `idle` placeholder
   * in the renderer).
   *
   * The fix is a one-shot 5-second retry that fires exactly ONCE per
   * `start()` / `reconnect()` invocation — IF we've never reached
   * `connected` in this session. It runs the unified `performFullReconnect`
   * provider (same OAuth-refresh + WS-handshake path the manual button
   * uses), so it covers the "token expired during the handshake gap"
   * case too. After this one retry succeeds (→ `connected`) the flag
   * resets and any subsequent disconnect goes back to the default
   * "stay disconnected, wait for manual click" path Ethan wants. If
   * the retry ALSO fails to reach `connected`, we stop retrying and
   * surface `disconnected` so the user clicks the manual button — we
   * don't loop, that's what Ethan disabled in v0.1.47.
   *
   * Distinct from `autoReconnectEnabled` because that flag enables the
   * full 60s polling loop the user explicitly disabled in v0.1.47.
   * This is one retry, period.
   */
  private hasEverConnectedThisSession = false;
  private initialRetryUsedThisSession = false;
  /**
   * v0.1.51: wall-clock timestamp (`Date.now()`) of the most recent
   * successful `'open'` event in this session. Used to gate the
   * "early close" one-shot retry — see `EARLY_CLOSE_WINDOW_MS` above.
   * `undefined` means we've never reached `'open'` yet this session.
   */
  private lastOpenAtMs?: number;
  /**
   * v0.1.51: one-shot budget for the post-open "early close" retry.
   * Separate from `initialRetryUsedThisSession` so a session that fails
   * pre-open AND then post-open within 30s of a brief connect still
   * gets at most ONE retry from each budget — total worst case two
   * retries, then disconnected. Reset on `start()` and on manual
   * `reconnect()` (default — `preserveInitialBudget` omitted).
   */
  private earlyCloseRetryUsedThisSession = false;
  /**
   * Callback fired AFTER every auto-reconnect attempt (provider call) so
   * main.ts can write a structured entry to `reconnect-events.jsonl`. We
   * keep the file I/O OUT of this class to preserve the test-time
   * decoupling and avoid touching the Electron `app` API in test code.
   */
  private autoAttemptListener?: (entry: AutoReconnectAttempt) => void;
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
   * v0.1.50: per-socket terminal-event guard.
   *
   * The `ws` library can emit BOTH `'error'` and `'close'` for the same
   * socket on a single failure (DNS failure, TCP RST mid-handshake, TLS
   * abort — these typically fire `'error'` followed immediately by
   * `'close'`). Without a guard, the first event runs `handleDisconnect`
   * which arms the 5s retry timer; the second event re-enters
   * `handleDisconnect` which calls `clearTimers()` FIRST THING, wiping
   * the timer that was just armed AND consuming the one-shot retry
   * budget (`initialRetryUsedThisSession=true`). The retry never fires
   * and the user lands on `disconnected` — the exact case v0.1.49 was
   * meant to fix.
   *
   * Solution: tag each ws instance the first time `handleDisconnect`
   * runs for it. Subsequent terminal events from the same socket are
   * no-ops. Manual reconnect / start / stop replace `this.ws` so the
   * new socket starts fresh. A WeakSet means we don't leak references to
   * closed sockets — they get GC'd as soon as no one holds them.
   */
  private handledSockets = new WeakSet<WebSocket>();

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

  /**
   * Install the unified-reconnect hook. v0.1.45 — auto-retry now calls
   * this provider so it runs the same OAuth-refresh + reconnect flow as
   * the manual button. Idempotent; pass `undefined` to revert to legacy
   * bare-connect retry (used only by unit tests).
   */
  setReconnectProvider(provider: ReconnectProvider | undefined) {
    this.reconnectProvider = provider;
  }

  /**
   * Subscribe to per-attempt outcomes for the JSONL audit log.
   * v0.1.45 — see `~/Library/Logs/Restream Chat++/reconnect-events.jsonl`
   * appender in main.ts.
   */
  setAutoAttemptListener(listener: ((entry: AutoReconnectAttempt) => void) | undefined) {
    this.autoAttemptListener = listener;
  }

  /**
   * v0.1.47: Toggle the auto-reconnect timer. Default OFF (no polling).
   * When true, restores the v0.1.45 behaviour: every 60s while
   * disconnected, run the unified reconnect provider (or fall back to
   * exponential backoff if no provider is installed). Idempotent.
   *
   * Manual `reconnect()` always works regardless of this flag — it's
   * the toolbar "Reconnect" button path and bypasses `handleDisconnect`.
   */
  setAutoReconnectEnabled(enabled: boolean) {
    this.autoReconnectEnabled = enabled;
    if (!enabled) {
      // Cancel any pending retry that was already scheduled.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    }
  }

  start() {
    this.stopped = false;
    // v0.1.49: reset the one-shot initial-retry tracking so a brand-new
    // `start()` always gets its one retry budget, even after a previous
    // session ended in `disconnected`.
    this.hasEverConnectedThisSession = false;
    this.initialRetryUsedThisSession = false;
    // v0.1.51: also reset the post-open early-close budget for the new
    // session — see `EARLY_CLOSE_WINDOW_MS` above for the rationale.
    this.earlyCloseRetryUsedThisSession = false;
    this.lastOpenAtMs = undefined;
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
    // v0.1.49: reset the one-shot initial-retry tracking — the next
    // `start()` (e.g. after a sign-out → sign-in cycle) gets a clean
    // budget. We intentionally do this AFTER setState so the listener
    // sees the disconnected event with the same tracking state it had
    // during the live session.
    this.setState({ status: 'disconnected', attempt: 0 });
    this.hasEverConnectedThisSession = false;
    this.initialRetryUsedThisSession = false;
    // v0.1.51: reset early-close budget on `stop()` so the next `start()`
    // (e.g. sign-out → sign-in) gets a clean slate.
    this.earlyCloseRetryUsedThisSession = false;
    this.lastOpenAtMs = undefined;
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
   *
   * v0.1.50: accepts an optional `{preserveInitialBudget}` flag. The
   * manual Reconnect button (default — flag omitted) resets the one-shot
   * initial-retry budget so the new handshake gets its own retry chance.
   * The provider-triggered retry path (`scheduleInitialConnectRetry` →
   * `performFullReconnect` → here) MUST pass `preserveInitialBudget:
   * true` — otherwise a retry handshake that ALSO fails before reaching
   * `connected` would re-enter `handleDisconnect` with both flags reset
   * and fire ANOTHER 5s retry, producing an infinite 5s polling loop.
   * That regressed the v0.1.47 "no polling" guarantee in production; see
   * Codex review of v0.1.49 + the regression tests in `ws-reconnect.test.ts`.
   */
  reconnect(options?: { preserveInitialBudget?: boolean }) {
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
    // v0.1.49 + v0.1.50: manual Reconnect (default — `preserveInitialBudget`
    // omitted or false) is a fresh user-driven attempt and resets the
    // one-shot tracking so the new handshake gets its own retry budget.
    // The provider-triggered retry path passes `preserveInitialBudget:
    // true` to KEEP `initialRetryUsedThisSession=true` so a second
    // pre-`connected` failure doesn't fire yet another 5s retry.
    if (!options?.preserveInitialBudget) {
      this.hasEverConnectedThisSession = false;
      this.initialRetryUsedThisSession = false;
      // v0.1.51: manual Reconnect button also gets a fresh early-close
      // budget — explicit user "try again" gesture matches the v0.1.50
      // semantics for the other budgets. Provider path passes
      // `preserveInitialBudget: true` and keeps the flag, so a retry
      // handshake that ALSO has an early close goes straight to
      // disconnected instead of looping.
      this.earlyCloseRetryUsedThisSession = false;
      this.lastOpenAtMs = undefined;
    }
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
      // v0.1.49: mark that we've successfully reached `connected` at
      // least once this session. From this point on, any future
      // disconnect goes through the normal v0.1.47 default path (stay
      // at `disconnected` until manual Reconnect). Only the
      // PRE-`connected` initial handshake gets the one-shot retry.
      this.hasEverConnectedThisSession = true;
      // v0.1.51: stamp the open time so `handleDisconnect` can decide
      // whether a subsequent close is "early" (within EARLY_CLOSE_WINDOW_MS)
      // and therefore eligible for the post-open one-shot retry. See the
      // file-level comment on EARLY_CLOSE_WINDOW_MS for the why.
      this.lastOpenAtMs = Date.now();
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
      this.handleDisconnect(`close ${code} ${reason?.toString() ?? ''}`, ws);
    });

    ws.on('error', (err) => {
      this.handleDisconnect(err.message || 'ws error', ws);
    });
  }

  private handleDisconnect(reason: string, source?: WebSocket) {
    // v0.1.50: per-socket terminal-event guard. If `'error'` and `'close'`
    // both fire for the same socket (common for DNS / TCP-RST / TLS-abort
    // pre-handshake failures), only the first one drives the disconnect
    // flow. The second would otherwise call `clearTimers()` first thing,
    // wiping the just-armed 5s retry timer AND consuming the one-shot
    // retry budget (`initialRetryUsedThisSession=true`) — leaving the
    // user on `disconnected` with no recovery, the exact case v0.1.49
    // was meant to fix. See `handledSockets` field comment for details.
    if (source) {
      if (this.handledSockets.has(source)) return;
      this.handledSockets.add(source);
    }
    this.clearTimers();
    if (this.stopped) return;
    this.attempt += 1;

    // v0.1.47: auto-reconnect is DISABLED by default (Ethan voice 3630 —
    // the 60s loop / legacy exponential backoff was generating constant
    // network traffic against api.restream.io that he suspected was
    // clogging his Wi-Fi / ISP). On any disconnect, flip to
    // `disconnected` and stay there. The user clicks the manual
    // Reconnect toolbar button when they want to come back, which goes
    // through `performFullReconnect()` → `chat.reconnect()` and is
    // unaffected by this change.
    //
    // Tests can opt back in to the v0.1.45 polling behaviour via
    // `setAutoReconnectEnabled(true)`.
    if (!this.autoReconnectEnabled) {
      // v0.1.49 — one-shot initial-connect recovery (Ethan voice 3692:
      // "Restream Chat++ is stuck on idle. I just signed in."). If
      // we've NEVER reached `connected` this session AND haven't used
      // our retry yet, schedule exactly ONE retry after a short delay
      // via the unified-reconnect provider (or `connect()` fallback for
      // tests without a provider installed). This handles transient
      // boot-time handshake hiccups — network blip during sign-in, an
      // api.restream.io blip during the very first handshake, a TLS
      // hiccup — without re-enabling the 60s polling loop that v0.1.47
      // disabled. After this one retry, regardless of outcome, we fall
      // through to the v0.1.47 "stay at disconnected" path on any
      // further close events.
      //
      // The retry is fire-and-forget — if it succeeds (WS open event
      // fires), `hasEverConnectedThisSession` flips true and any future
      // disconnect this session goes through the normal "stay
      // disconnected" path. If it fails (another close event), we
      // re-enter handleDisconnect, hit this same block, find
      // `initialRetryUsedThisSession=true`, and short-circuit straight
      // to `disconnected` — no looping.
      if (
        !this.hasEverConnectedThisSession &&
        !this.initialRetryUsedThisSession
      ) {
        this.initialRetryUsedThisSession = true;
        this.setState({
          status: 'reconnecting',
          attempt: this.attempt,
          lastError: reason,
        });
        this.scheduleInitialConnectRetry(reason);
        return;
      }
      // v0.1.51: post-open "early close" one-shot retry — fix for Ethan
      // voice 3709 ("v0.1.50 still stuck on idle"). The v0.1.49/v0.1.50
      // retry covered ONLY the pre-`'open'` path. Production failure is
      // the WS opens, briefly receives frames, then the server fires
      // `'close'` (Restream's `connection_replaced` when a second client
      // grabs the same token; or an immediate auth reject). Pre-v0.1.51
      // that path landed silently on `disconnected` with NO entry in
      // `reconnect-events.jsonl`. We now treat a close that fires within
      // EARLY_CLOSE_WINDOW_MS of the open as eligible for ONE retry via
      // the unified-reconnect provider — same one-shot budget shape as
      // the initial-connect retry. After this one retry (regardless of
      // outcome), or for any close outside the window, we fall through
      // to the v0.1.47 default and stay on `disconnected`.
      const earlyCloseEligible =
        this.lastOpenAtMs !== undefined &&
        Date.now() - this.lastOpenAtMs <= EARLY_CLOSE_WINDOW_MS &&
        !this.earlyCloseRetryUsedThisSession;
      if (earlyCloseEligible) {
        this.earlyCloseRetryUsedThisSession = true;
        this.setState({
          status: 'reconnecting',
          attempt: this.attempt,
          lastError: reason,
        });
        this.scheduleInitialConnectRetry(`early-close:${reason}`);
        return;
      }
      this.setState({ status: 'disconnected', attempt: this.attempt, lastError: reason });
      return;
    }

    this.setState({ status: 'reconnecting', attempt: this.attempt, lastError: reason });

    // v0.1.45: when the unified-reconnect provider is installed (real app
    // path), run the SAME OAuth-refresh + chat.reconnect() flow the
    // manual Reconnect button uses, on a fixed 60s cadence. If the
    // provider isn't installed (unit tests that exercise the WS state
    // machine without spinning up the full main.ts wiring), fall back to
    // the legacy exponential-backoff `this.connect()` retry so existing
    // tests still pass.
    if (this.reconnectProvider) {
      this.scheduleAutoRetry(reason);
      return;
    }

    const backoff = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * Math.pow(2, Math.min(10, this.attempt - 1)),
    );
    this.reconnectTimer = setTimeout(() => this.connect(), backoff);
  }

  /**
   * Schedule the next auto-retry via the unified-reconnect provider.
   * v0.1.45 — see file-level comment on `AUTO_RETRY_INTERVAL_MS`.
   *
   * The provider call is fire-and-forget from this method's perspective —
   * on resolve we either land in 'connected' (the provider's
   * `chat.reconnect()` re-armed the socket; the WS open handler will
   * have flipped state already) or we land back in 'reconnecting' /
   * 'error' (provider returned `ok: false`, OR the new socket also
   * closed). The next disconnect event then re-enters this method.
   *
   * IMPORTANT: we deliberately do NOT chain retries off the
   * `then`-branch of the provider promise. The provider triggers
   * `chat.reconnect()` which fires `connect()` synchronously; that
   * either resolves to 'connected' shortly after or fires another
   * close event that re-runs `handleDisconnect`. Chaining inside the
   * promise would double-schedule.
   */
  private scheduleAutoRetry(reason: string) {
    if (this.stopped) return;
    const attempt = this.attempt;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      if (this.providerInFlight) return;
      this.providerInFlight = true;
      const provider = this.reconnectProvider;
      if (!provider) {
        this.providerInFlight = false;
        // Provider was unset between schedule + tick. Bail.
        return;
      }
      Promise.resolve()
        .then(() => provider())
        .then((outcome) => {
          this.providerInFlight = false;
          try {
            this.autoAttemptListener?.({
              attempt,
              reason,
              outcome: outcome.ok ? 'ok' : 'failed',
              failureReason: outcome.ok ? undefined : (outcome.reason ?? 'unknown'),
            });
          } catch {
            // never break delivery on a listener failure
          }
          // If the provider didn't actually re-arm the socket (ok=false,
          // e.g. no token / refresh failed) the WS will still be torn
          // down and we won't get a fresh `close` event to re-enter
          // handleDisconnect. Schedule another tick ourselves so we keep
          // retrying every 60s — that's the whole point of v0.1.45.
          if (!outcome.ok && !this.stopped && this.state.status !== 'connected') {
            this.scheduleAutoRetry(outcome.reason ?? 'provider-not-ok');
          }
        })
        .catch((err) => {
          this.providerInFlight = false;
          const msg = (err as Error)?.message ?? String(err);
          try {
            this.autoAttemptListener?.({
              attempt,
              reason,
              outcome: 'failed',
              failureReason: msg,
            });
          } catch {
            // never break delivery on a listener failure
          }
          if (!this.stopped && this.state.status !== 'connected') {
            this.scheduleAutoRetry(msg);
          }
        });
    }, AUTO_RETRY_INTERVAL_MS);
  }

  /**
   * v0.1.49: schedule the one-shot initial-connect retry (5s) on the
   * very first handshake failure of a fresh `start()` / `reconnect()`
   * session. This is INTENTIONALLY scoped narrower than `scheduleAutoRetry`:
   *
   * - Fires at most ONCE per session (gated by `initialRetryUsedThisSession`
   *   in `handleDisconnect`).
   * - Does NOT chain off its own failure — if the retry also fails to
   *   reach `connected`, we land in `disconnected` and wait for the
   *   manual Reconnect button. The whole point of v0.1.47 was to stop
   *   the perpetual polling, and this retry only exists for the
   *   "transient blip during sign-in" case; if the second attempt fails,
   *   the user's network or token is genuinely off and a 60s poll
   *   wouldn't help any more than a manual click would.
   * - Uses the unified-reconnect provider when installed (real app path)
   *   so the retry handshake gets a fresh OAuth refresh + chat.reconnect()
   *   pipeline, identical to the manual button. Falls back to bare
   *   `this.connect()` (with the cached access token) when no provider
   *   is installed — that's the unit-test path and matches the legacy
   *   behaviour for `scheduleAutoRetry`'s fallback branch.
   */
  private scheduleInitialConnectRetry(reason: string) {
    if (this.stopped) return;
    const attempt = this.attempt;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      // If something flipped us to `connected` in the meantime (rare —
      // would mean someone else called `reconnect()` during the delay —
      // but safe to guard) skip the retry to avoid tearing down the
      // already-healthy socket.
      if (this.state.status === 'connected') return;
      if (this.providerInFlight) return;
      const provider = this.reconnectProvider;
      if (!provider) {
        // Test path / pre-app-ready: no provider installed. Fall back to
        // a bare `this.connect()` with the cached access token. That
        // matches the legacy `scheduleAutoRetry` fallback branch and
        // keeps the v0.1.47 unit tests working without changes.
        this.connect();
        return;
      }
      this.providerInFlight = true;
      Promise.resolve()
        .then(() => provider())
        .then((outcome) => {
          this.providerInFlight = false;
          try {
            this.autoAttemptListener?.({
              attempt,
              reason: `initial-retry:${reason}`,
              outcome: outcome.ok ? 'ok' : 'failed',
              failureReason: outcome.ok ? undefined : (outcome.reason ?? 'unknown'),
            });
          } catch {
            // never break delivery on a listener failure
          }
          // If the provider returned ok=false (no token / refresh failed)
          // it never re-armed the socket, so we won't get a fresh
          // `close` event to re-enter `handleDisconnect`. Surface
          // `disconnected` here so the UI stops spinning on
          // `reconnecting`. The user can then click manual Reconnect
          // once their auth is sorted.
          if (!outcome.ok && !this.stopped && this.state.status !== 'connected') {
            this.setState({
              status: 'disconnected',
              attempt: this.attempt,
              lastError: outcome.reason ?? 'initial-retry-failed',
            });
          }
        })
        .catch((err) => {
          this.providerInFlight = false;
          const msg = (err as Error)?.message ?? String(err);
          try {
            this.autoAttemptListener?.({
              attempt,
              reason: `initial-retry:${reason}`,
              outcome: 'failed',
              failureReason: msg,
            });
          } catch {
            // never break delivery on a listener failure
          }
          if (!this.stopped && this.state.status !== 'connected') {
            this.setState({
              status: 'disconnected',
              attempt: this.attempt,
              lastError: msg,
            });
          }
        });
    }, INITIAL_CONNECT_RETRY_MS);
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

// v0.1.45: expose the auto-retry cadence so the unified-reconnect tests can
// fake-timer-advance by exactly one interval.
export const __test_auto_retry_interval_ms = AUTO_RETRY_INTERVAL_MS;

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
