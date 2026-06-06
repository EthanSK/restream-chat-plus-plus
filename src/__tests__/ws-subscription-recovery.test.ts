import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * v0.1.86 (voice 4491) — subscription-loss recovery tests.
 *
 * THE BUG: on 2026-06-06 Restream sent `connection_closed` reason:"replaced"
 * frames for EVERY platform connection at once. The app deleted each entry,
 * draining the connections map to empty — but the WS socket stayed OPEN
 * (heartbeats kept flowing every 30s). With zero subscriptions, no chat
 * `event` frames ever arrived again, so TTS went dead silent. The
 * stale-inbound watchdog couldn't catch it because heartbeats kept
 * `lastInboundFrameAt` fresh, and nothing went through `handleDisconnect`
 * (the socket never closed), so the managed re-subscribe never ran.
 *
 * THE FIX (under test here):
 *   (a) Draining all connections via `connection_closed` while the socket is
 *       OPEN schedules exactly ONE debounced managed reconnect (which
 *       re-subscribes). A burst of per-platform "replaced" frames coalesces
 *       into a single reconnect.
 *   (b) Replace-war guard: if we get drained to zero AGAIN within
 *       REPLACE_WAR_WINDOW_MS after WE triggered a recovery, we do NOT
 *       reconnect again (would ping-pong with the competing client); we
 *       surface a warning instead.
 *   (c) A genuinely quiet-but-connected socket (no drain, just no chat) does
 *       NOT reconnect.
 */

// FakeWS: like the mock in ws-auto-reconnect-unified.test.ts, but `open`
// flips readyState to OPEN so the drain-recovery code's
// `this.ws?.readyState === WebSocket.OPEN` guard sees a live socket. Tests
// emit `connection_closed` frames via `emit('message', Buffer)` exactly as
// the real ws library delivers them.
vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWS extends EventEmitter {
    static OPEN = 1;
    static instances: FakeWS[] = [];
    readyState = 0;
    constructor(public url: string) {
      super();
      FakeWS.instances.push(this);
      // Auto-flip to OPEN whenever an 'open' listener fires. We emit 'open'
      // manually in each test; mirror the real ws lib which sets readyState
      // before dispatching 'open'.
      this.on('open', () => {
        this.readyState = FakeWS.OPEN;
      });
    }
    ping() {}
    terminate() {
      this.readyState = 3;
    }
    close() {
      this.readyState = 3;
    }
    removeAllListeners() {
      super.removeAllListeners();
      return this;
    }
  }
  return { default: FakeWS };
});

import { ChatClient, type AutoReconnectAttempt } from '../main/ws-client';
import WSMock from 'ws';

const WS = WSMock as any;

// Helper: build a Restream connection_info frame (= a fresh subscription) and
// deliver it to the client as the real ws lib would (Buffer payload).
function deliverConnectionInfo(
  ws: any,
  connectionIdentifier: string,
  connectionUuid: string,
) {
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        action: 'connection_info',
        payload: {
          connectionIdentifier,
          connectionUuid,
          eventSourceId: 13,
          status: 'connected',
          target: { owner: { displayName: connectionIdentifier } },
        },
      }),
    ),
  );
}

// Helper: build a Restream connection_closed frame (= a subscription dropped).
function deliverConnectionClosed(ws: any, connectionUuid: string, reason = 'replaced') {
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        action: 'connection_closed',
        payload: { connectionUuid, reason },
      }),
    ),
  );
}

describe('ChatClient subscription-loss recovery (v0.1.86)', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) draining ALL connections while open schedules exactly ONE managed reconnect', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: true });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');

    // Subscribe to two platforms (youtube + twitch) via connection_info.
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt');
    deliverConnectionInfo(ws, 'u-twitch-2', 'uuid-tw');
    expect(client.getConnections()).toHaveLength(2);

    // Restream drains BOTH with reason "replaced" in a burst (same tick).
    deliverConnectionClosed(ws, 'uuid-yt', 'replaced');
    deliverConnectionClosed(ws, 'uuid-tw', 'replaced');
    expect(client.getConnections()).toHaveLength(0);

    // The provider must NOT have fired yet — it's debounced.
    expect(provider).not.toHaveBeenCalled();

    // After the debounce window, exactly ONE managed reconnect fires (the two
    // close frames coalesced into a single recovery).
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('(b) replace-war guard: a SECOND drain within the window does NOT reconnect again, and surfaces a warning', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: true });
    client.setReconnectProvider(provider);
    const states: string[] = [];
    const warnings: (string | undefined)[] = [];
    client.on('state', (s) => {
      states.push(s.status);
      warnings.push(s.warning);
    });
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');

    // First drain → schedules + fires one recovery reconnect.
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt');
    deliverConnectionClosed(ws, 'uuid-yt', 'replaced');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);

    // The competing client takes over AGAIN ~10s later (well within the 60s
    // replace-war window). The reconnect re-subscribed us (simulate a fresh
    // connection_info), then it gets replaced again.
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt2');
    await vi.advanceTimersByTimeAsync(10_000);
    deliverConnectionClosed(ws, 'uuid-yt2', 'replaced');

    // Guard must trip: NO second reconnect, even after the debounce window.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(provider).toHaveBeenCalledTimes(1); // still just the first one

    // A non-blocking warning was surfaced on the (still-'connected') state.
    const warned = warnings.find((w) => typeof w === 'string' && w.includes('took over'));
    expect(warned).toBeTruthy();
  });

  it('(c) a quiet-but-connected socket (no drain) does NOT reconnect', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: true });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');

    // Subscribe to one platform, then go quiet on CHAT for a long time. We
    // still model heartbeats arriving (every ~30s) the way the real server
    // sends them — these are non-chat inbound frames that keep the
    // stale-inbound watchdog satisfied. The point of this test: no
    // connection_closed = no drain-to-zero = NO subscription-recovery
    // reconnect, even though there's zero CHAT traffic.
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt');
    expect(client.getConnections()).toHaveLength(1);

    // 10 minutes pass; deliver a heartbeat-ish frame every 30s so the
    // stale-inbound watchdog (90s threshold) never trips. A "heartbeat"
    // action is a non-chat frame — it bumps lastInboundFrameAt but NOT the
    // connections map. (Real Restream heartbeats are ping/pong, but any
    // inbound frame bumps lastInboundFrameAt, so this faithfully models the
    // masking behaviour.)
    for (let i = 0; i < 20; i++) {
      ws.emit('message', Buffer.from(JSON.stringify({ action: 'heartbeat' })));
      await vi.advanceTimersByTimeAsync(30_000);
    }

    // We still hold the connection, and NO recovery reconnect fired.
    expect(client.getConnections()).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does NOT trigger recovery when the socket is NOT open (closed path owns it)', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: true });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt');

    // Socket transitions to CLOSED (e.g. mid-teardown), THEN a trailing
    // connection_closed drains the map. The drain-recovery path must bail —
    // handleDisconnect (via the real 'close' event) owns recovery here.
    ws.readyState = 3; // CLOSED
    deliverConnectionClosed(ws, 'uuid-yt', 'replaced');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(provider).not.toHaveBeenCalled();
  });

  it('reports the recovery attempt to the auto-attempt listener', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: true });
    client.setReconnectProvider(provider);
    const attempts: AutoReconnectAttempt[] = [];
    client.setAutoAttemptListener((a) => attempts.push(a));
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt');
    deliverConnectionClosed(ws, 'uuid-yt', 'replaced');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);
    const rec = attempts.find((a) => a.reason.startsWith('subscription-recovery:'));
    expect(rec).toBeTruthy();
    expect(rec!.outcome).toBe('ok');
  });
});
