import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import {
  aggregateViewerStats,
  applyStreamingUpdate,
  sweepStaleViewerStats,
  type ViewerStatsMap,
  type ViewerStatsSnapshot,
} from '../shared/viewer-stats-core';
import { appendJsonl, errorToString } from './structured-log';

/**
 * v0.1.94 — LIVE VIEWER COUNT, main-process socket shell.
 *
 * Thin WebSocket client for Restream's "Streaming Updates" feed:
 *
 *     wss://streaming.api.restream.io/ws?accessToken=<OAuth bearer>
 *
 * The FULL data-source contract (endpoint, auth, `updateStatuses` payload
 * shape, why the chat WS can't provide this) is documented at the top of
 * `src/shared/viewer-stats-core.ts` — read that first. This file only owns
 * the socket lifecycle; every decision about what a frame MEANS lives in
 * the pure core so it's unit-testable without mocking `ws`.
 *
 * DESIGN PRINCIPLES (deliberately different from ws-client.ts):
 *
 *  - This feed is a NICE-TO-HAVE overlay. Chat must never suffer for it, so
 *    there is NO shared state with ChatClient, NO reconnectProvider hook into
 *    the OAuth-refresh machinery, and every failure path degrades to "the
 *    toolbar shows the idle placeholder" — never a user-facing error.
 *  - Quiet reconnect: exponential backoff 5s → 5min cap. When the token is
 *    stale the server closes/refuses; we DON'T hammer refresh ourselves —
 *    main.ts hands us the fresh token whenever the chat stack gets one
 *    (same call sites as chat.setToken), and setToken() resets the backoff.
 *  - Keepalive: the server pushes nothing while no stream is live, so we
 *    can't use inbound-staleness to detect a dead socket (that's the same
 *    trap the chat WS hit in v0.1.86 — heartbeats keeping a zombie looking
 *    alive, but inverted). Instead we send protocol-level pings every 30s
 *    and terminate after 2 consecutive missed pongs; the close handler then
 *    reconnects with backoff.
 *
 * Forensics: lifecycle + status rows land in
 *   ~/Library/Logs/Restream Chat++/viewer-stats.jsonl
 * via the shared appendJsonl (which no-ops safely outside Electron/tests).
 * updateStatuses rows are logged ONLY when they change the aggregate (to
 * keep the file small — Restream re-sends unchanged statuses every ~30s).
 */

const STREAMING_WS_URL = 'wss://streaming.api.restream.io/ws';
const PING_INTERVAL_MS = 30_000;
/** Missed-pong budget before we declare the socket dead (2 × 30s = 60s). */
const MAX_MISSED_PONGS = 2;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * Periodic stale-entry sweep cadence. Independent of frame arrival so a
 * frozen count self-heals even when Restream stops sending updates entirely
 * (stream ended, socket quietly dead, etc.). 60s is frequent enough that the
 * UI never shows a >6min-old number (TTL 5min + one sweep period).
 */
const SWEEP_INTERVAL_MS = 60_000;
const LOG_FILE = 'viewer-stats.jsonl';

export declare interface ViewerStatsClient {
  /** Emitted with a fresh aggregated snapshot whenever it changes. */
  on(event: 'stats', listener: (snap: ViewerStatsSnapshot) => void): this;
  emit(event: 'stats', snap: ViewerStatsSnapshot): boolean;
}

// eslint-disable-next-line no-redeclare
export class ViewerStatsClient extends EventEmitter {
  private ws?: WebSocket;
  private accessToken?: string;
  private stopped = true;
  private backoffMs = BASE_BACKOFF_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private missedPongs = 0;
  /** Per-channel latest status — the ONLY mutable domain state. */
  private readonly stats: ViewerStatsMap = new Map();
  /** Last snapshot handed out, so pull-fetchers (IPC GET) get instant truth. */
  private lastSnapshot: ViewerStatsSnapshot = {
    totalViewers: null,
    anyOnline: false,
    channels: [],
    computedAtMs: 0,
  };

  /**
   * Store/replace the bearer token. Called from the SAME main.ts sites that
   * call chat.setToken (startup resume, sign-in, reconnect, transient-refresh
   * recovery) so both sockets always hold the same credential. A fresh token
   * also resets the backoff — the most common connect-failure cause (expired
   * token) has just been cured, so retry promptly.
   */
  setToken(token: string): void {
    this.accessToken = token;
    this.backoffMs = BASE_BACKOFF_MS;
  }

  /** Begin (or resume after stop()) maintaining the connection. Idempotent. */
  start(): void {
    this.stopped = false;
    // Periodic TTL sweep — armed once per start, torn down in stop(). Kept
    // OUTSIDE the socket lifecycle: entries must expire even while the
    // socket is down/reconnecting, otherwise a dead socket freezes the
    // last-seen count on screen indefinitely.
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        if (sweepStaleViewerStats(this.stats, Date.now())) {
          this.recomputeAndBroadcast('ttl-sweep');
        }
      }, SWEEP_INTERVAL_MS);
      // Don't hold the process open for a stats sweep (matches the chat
      // client's timer hygiene; unref is a no-op in some test envs).
      this.sweepTimer.unref?.();
    }
    this.connect();
  }

  /**
   * Tear everything down (sign-out / app quit). Clears domain state and
   * broadcasts an empty snapshot so the renderer's count disappears rather
   * than freezing at the pre-signout value.
   */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.teardownSocket();
    if (this.stats.size > 0) {
      this.stats.clear();
      this.recomputeAndBroadcast('stopped');
    }
    this.log({ kind: 'lifecycle', event: 'stopped' });
  }

  /**
   * Force a fresh connection with the CURRENT token (called next to
   * chat.reconnect() after a token refresh). Safe no-op when stop()ed.
   */
  reconnect(): void {
    if (this.stopped) {
      // A reconnect request implies we should be running (mirrors how
      // main.ts treats chat.reconnect after sign-in) — flip to started.
      this.start();
      return;
    }
    this.clearReconnectTimer();
    this.teardownSocket();
    this.backoffMs = BASE_BACKOFF_MS;
    this.connect();
  }

  /** Pull-fetch for the renderer-mount race (IPC.VIEWER_STATS_GET). */
  getSnapshot(): ViewerStatsSnapshot {
    return this.lastSnapshot;
  }

  // ---------------------------------------------------------------- private

  private connect(): void {
    if (this.stopped) return;
    if (!this.accessToken) {
      // No token yet (cold boot before auth resume settles). main.ts calls
      // setToken + start/reconnect once auth lands, so just wait quietly.
      this.log({ kind: 'lifecycle', event: 'connect-skipped-no-token' });
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return; // already live/connecting — idempotent start()
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(
        `${STREAMING_WS_URL}?accessToken=${encodeURIComponent(this.accessToken)}`,
      );
    } catch (err) {
      // Constructor throw (bad URL/env) — extremely rare; schedule retry.
      this.log({
        kind: 'error',
        event: 'ctor-threw',
        error: errorToString(err),
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      // Success resets the backoff so the NEXT outage starts at 5s again.
      this.backoffMs = BASE_BACKOFF_MS;
      this.missedPongs = 0;
      this.log({ kind: 'lifecycle', event: 'open' });
      this.armPing(ws);
    });

    ws.on('message', (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        // Non-JSON frame — ignore silently (enhancement feed; no spam).
        return;
      }
      // Pure-core fold; only recompute/broadcast when the map changed so
      // ingest-metric frames (updateIncoming etc.) don't wake the renderer.
      if (applyStreamingUpdate(this.stats, frame, Date.now())) {
        this.recomputeAndBroadcast('frame');
      }
    });

    // Protocol-level pong answers our ping — the liveness signal.
    ws.on('pong', () => {
      this.missedPongs = 0;
    });

    ws.on('close', (code) => {
      this.log({ kind: 'lifecycle', event: 'close', code });
      this.disarmPing();
      this.ws = undefined;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      // 'close' always follows 'error' on ws, so reconnect scheduling lives
      // there — this handler only records the cause. MUST exist though:
      // an unhandled 'error' event would crash the main process.
      this.log({ kind: 'error', event: 'ws-error', error: errorToString(err) });
    });
  }

  /**
   * Ping keepalive. The streaming feed is silent while nothing is live, so
   * inbound traffic can't prove liveness — we actively ping and count pongs.
   * After MAX_MISSED_PONGS misses, terminate() (hard destroy, fires 'close')
   * which routes into the normal backoff-reconnect path.
   */
  private armPing(ws: WebSocket): void {
    this.disarmPing();
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.missedPongs += 1;
      if (this.missedPongs > MAX_MISSED_PONGS) {
        this.log({ kind: 'lifecycle', event: 'ping-timeout-terminate' });
        try {
          ws.terminate();
        } catch {
          /* already dead */
        }
        return;
      }
      try {
        ws.ping();
      } catch {
        /* socket raced closed between readyState check and ping */
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private disarmPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.missedPongs = 0;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return; // one pending attempt at a time
    const delay = this.backoffMs;
    // Exponential backoff, capped. Reset on successful open or new token.
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
    this.log({ kind: 'lifecycle', event: 'reconnect-scheduled', delayMs: delay });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private teardownSocket(): void {
    this.disarmPing();
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    // Remove listeners FIRST so the deliberate close doesn't trigger the
    // auto-reconnect path (same pattern as ws-client.ts teardown).
    ws.removeAllListeners();
    // Swallowed-error listener: a socket mid-handshake can still emit
    // 'error' after removeAllListeners+terminate; without a handler that
    // would crash the process.
    ws.on('error', () => undefined);
    try {
      ws.terminate();
    } catch {
      /* already closed */
    }
  }

  private recomputeAndBroadcast(reason: string): void {
    // Sweep first so a snapshot never includes >TTL-old entries even when
    // triggered by an unrelated fresh frame.
    sweepStaleViewerStats(this.stats, Date.now());
    const snap = aggregateViewerStats(this.stats, Date.now());
    const prev = this.lastSnapshot;
    this.lastSnapshot = snap;
    this.emit('stats', snap);
    // Log only MEANINGFUL transitions (total or online-set changed) — the
    // raw feed re-sends unchanged statuses every ~30s and we don't want a
    // grow-forever log for a cosmetic feature.
    if (
      prev.totalViewers !== snap.totalViewers ||
      prev.anyOnline !== snap.anyOnline ||
      prev.channels.length !== snap.channels.length
    ) {
      this.log({
        kind: 'stats',
        reason,
        totalViewers: snap.totalViewers,
        anyOnline: snap.anyOnline,
        channels: snap.channels.map((c) => ({
          platform: c.platformName,
          id: c.channelIdentifier,
          online: c.online,
          viewers: c.viewers,
        })),
      });
    }
  }

  /** All rows funnel through appendJsonl (swallows errors, no-ops in tests). */
  private log(record: Record<string, unknown>): void {
    appendJsonl(LOG_FILE, record);
  }
}
