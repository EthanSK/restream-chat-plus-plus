/* eslint-disable @typescript-eslint/no-var-requires */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * v0.1.87 (send-warning auto-reconnect request 2026-06-07) — unconfirmed-send
 * recovery tests.
 *
 * THE SYMPTOM: a chat message the user sends POSTs to Restream and gets
 * `200 {"success":true}`, but the matching `ws-echo-received`
 * (`reply_created`) frame never arrives within the renderer's 30s
 * `OPTIMISTIC_SEND_TIMEOUT_MS` guard — so the renderer flips the message to the
 * red ⚠ "unconfirmed" state. Ethan confirmed that clicking the manual Reconnect
 * button at that point fixes it ("that seemed to fix it"). So when the renderer
 * reports an unconfirmed send (over IPC → `chat.requestUnconfirmedSendRecovery()`),
 * we automatically fire the SAME managed reconnect the manual button uses.
 *
 * WHAT'S UNDER TEST (the four required cases):
 *   (a) ONE unconfirmed send schedules exactly ONE managed reconnect.
 *   (b) A BURST of unconfirmed sends within the window schedules only ONE.
 *   (c) The cooldown suppresses a SECOND recovery within the window.
 *   (d) A normally-confirmed send (echo arrives in time → no unconfirmed
 *       report) does NOT trigger a reconnect.
 *
 * Plus: the replace-war guard from v0.1.86 is respected, and the recovery is
 * reported to the auto-attempt listener.
 */

// FakeWS mirrors the mock in ws-subscription-recovery.test.ts: `open` flips
// readyState to OPEN so the recovery code's `readyState === WebSocket.OPEN`
// guard sees a live socket.
vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWS extends EventEmitter {
    static OPEN = 1;
    static instances: FakeWS[] = [];
    readyState = 0;
    constructor(public url: string) {
      super();
      FakeWS.instances.push(this);
      this.on('open', () => {
        this.readyState = FakeWS.OPEN;
      });
    }
    ping() {
      // Test fake: the client only needs the method to exist.
    }
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

import {
  ChatClient,
  type AutoReconnectAttempt,
  __test_unconfirmed_send_cooldown_ms as COOLDOWN_MS,
} from '../main/ws-client';
import WSMock from 'ws';

const WS = WSMock as any;

// Helper: deliver a Restream connection_info frame (= a fresh subscription) so
// a connection_closed can later drain it. Mirrors the helper used in the
// v0.1.86 test (eventSourceId 13 = youtube).
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

// Helper: spin up a started, open ChatClient with a mock reconnect provider.
function makeOpenClient() {
  const client = new ChatClient();
  client.setToken('abc');
  const provider = vi.fn().mockResolvedValue({ ok: true });
  client.setReconnectProvider(provider);
  client.start();
  const ws = WS.instances[WS.instances.length - 1];
  ws.emit('open');
  return { client, provider, ws };
}

describe('ChatClient unconfirmed-send recovery (v0.1.87)', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) ONE unconfirmed send schedules exactly ONE managed reconnect', async () => {
    const { client, provider } = makeOpenClient();

    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    // Debounced — nothing yet.
    expect(provider).not.toHaveBeenCalled();

    // After the debounce window, exactly one managed reconnect fires.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('(b) a BURST of unconfirmed sends within the window schedules only ONE reconnect', async () => {
    const { client, provider } = makeOpenClient();

    // User spam-sent 5 messages while the WS was broken; all 5 time out and
    // report unconfirmed in a tight burst (same tick). They must coalesce.
    for (let i = 0; i < 5; i++) {
      client.requestUnconfirmedSendRecovery('send-unconfirmed');
    }
    expect(provider).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('(c) the cooldown suppresses a SECOND recovery within the window', async () => {
    const { client, provider } = makeOpenClient();

    // First unconfirmed send → fires one recovery.
    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);

    // A second unconfirmed send lands WELL within the cooldown window. It must
    // be suppressed — no second reconnect, even after the debounce window.
    await vi.advanceTimersByTimeAsync(5_000); // total < COOLDOWN_MS
    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1); // STILL just the first one

    // Once the cooldown fully elapses, a fresh unconfirmed send CAN heal again.
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS); // safely past the window
    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('(d) a normally-confirmed send (no unconfirmed report) does NOT trigger a reconnect', async () => {
    const { provider } = makeOpenClient();

    // Simulate a healthy send round-trip: the renderer's optimistic timeout
    // clears on the WS echo, so `requestUnconfirmedSendRecovery` is NEVER
    // called. We model "time passes, chat flows" and assert no reconnect.
    deliverConnectionInfo(WS.instances[0], 'u-youtube-1', 'uuid-yt');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does NOT reconnect when the socket is not OPEN (close path owns it)', async () => {
    const { client, provider, ws } = makeOpenClient();
    ws.readyState = 3; // CLOSED
    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does NOT reconnect when no provider is installed', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    // Intentionally NO setReconnectProvider.
    client.start();
    const ws = WS.instances[WS.instances.length - 1];
    ws.emit('open');
    // Should be a no-op (logged + bailed), and must not throw.
    expect(() => client.requestUnconfirmedSendRecovery('send-unconfirmed')).not.toThrow();
    await vi.advanceTimersByTimeAsync(2_500);
    // Nothing to assert on the provider (there is none); the test passes by not
    // throwing + not scheduling a phantom reconnect.
  });

  it('stands down when the v0.1.86 replace-war guard has tripped (no ping-pong)', async () => {
    const { client, provider, ws } = makeOpenClient();

    // Drive the replace-war guard to TRIP: one drain → recovery, then a second
    // drain within the 60s window trips the guard (this is v0.1.86 behaviour).
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ action: 'connection_closed', payload: { connectionUuid: 'uuid-yt', reason: 'replaced' } }),
      ),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);
    // Re-subscribe + get replaced again within the window → guard trips.
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt2');
    await vi.advanceTimersByTimeAsync(5_000);
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ action: 'connection_closed', payload: { connectionUuid: 'uuid-yt2', reason: 'replaced' } }),
      ),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1); // guard tripped, no 2nd reconnect

    // Now an unconfirmed send arrives. With the guard tripped, we must NOT fire
    // a recovery (a competing client is provably winning; reconnecting loops).
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS); // clear the cooldown so only the guard matters
    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1); // still just the original drain recovery
  });

  it('reports the recovery to the auto-attempt listener with the unconfirmed-send reason', async () => {
    const { client, provider } = makeOpenClient();
    const attempts: AutoReconnectAttempt[] = [];
    client.setAutoAttemptListener((a) => attempts.push(a));

    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(provider).toHaveBeenCalledTimes(1);

    const rec = attempts.find((a) => a.reason.startsWith('unconfirmed-send-recovery:'));
    expect(rec).toBeTruthy();
    expect(rec!.outcome).toBe('ok');
  });

  // v0.1.88 (voice 4504): a SUCCESSFUL unconfirmed-send recovery must emit the
  // 'reconnect-succeeded' event so main can forward it to the renderer, which
  // sweeps + clears the lingering ⚠ on the HTTP-200 send that warned.
  it("(v0.1.88) emits 'reconnect-succeeded' when the unconfirmed-send recovery succeeds", async () => {
    const { client, provider } = makeOpenClient();
    const reasons: string[] = [];
    client.on('reconnect-succeeded', (r: string) => reasons.push(r));

    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe('unconfirmed-send-recovery:send-unconfirmed');
  });

  // v0.1.88: a FAILED recovery (provider returns { ok: false }) must NOT emit
  // 'reconnect-succeeded' — the connection didn't actually heal, so the renderer
  // must keep the ⚠ (the send may genuinely not have delivered).
  it("(v0.1.88) does NOT emit 'reconnect-succeeded' when the recovery provider fails", async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: false, reason: 'refresh-failed' });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[WS.instances.length - 1];
    ws.emit('open');

    const reasons: string[] = [];
    client.on('reconnect-succeeded', (r: string) => reasons.push(r));

    client.requestUnconfirmedSendRecovery('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(2_500);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(reasons).toHaveLength(0); // no success signal on a failed heal
  });

  // v0.1.88: the v0.1.86 drain-to-zero recovery path must ALSO emit
  // 'reconnect-succeeded' on success (it shares the renderer sweep with the
  // unconfirmed-send path).
  it("(v0.1.88) emits 'reconnect-succeeded' when the v0.1.86 drain recovery succeeds", async () => {
    const { client, provider, ws } = makeOpenClient();
    const reasons: string[] = [];
    client.on('reconnect-succeeded', (r: string) => reasons.push(r));

    // Subscribe one platform, then drain it to zero while the socket is OPEN.
    deliverConnectionInfo(ws, 'u-youtube-1', 'uuid-yt');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          action: 'connection_closed',
          payload: { connectionUuid: 'uuid-yt', reason: 'replaced' },
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(2_500);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe('subscription-recovery:replaced');
  });
});
