import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We mock the `ws` module to a tiny EventEmitter-like fake so we can drive
// open/close/error events synchronously and assert the ChatClient drives state
// transitions correctly.
vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWS extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    constructor(public url: string) {
      super();
      // Caller will trigger events explicitly via `emit`.
      FakeWS.instances.push(this);
    }
    ping() {}
    close() {}
    removeAllListeners() {
      super.removeAllListeners();
    }
    static instances: FakeWS[] = [];
  }
  return { default: FakeWS };
});

// Import after mock so the mock is wired in.
import { ChatClient } from '../main/ws-client';
import WSMock from 'ws';

const WS = WSMock as any;

describe('ChatClient reconnect', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions idle → connecting → connected on open', () => {
    const client = new ChatClient();
    client.setToken('abc');
    const states: string[] = [];
    client.on('state', (s: any) => states.push(s.status));
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
  });

  it('transitions to reconnecting on close and schedules a retry', () => {
    // v0.1.47: auto-reconnect is OFF by default in prod; tests opt in.
    const client = new ChatClient();
    client.setToken('abc');
    client.setAutoReconnectEnabled(true);
    const states: any[] = [];
    client.on('state', (s: any) => states.push(s));
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));
    // Allow one microtask tick.
    expect(states[states.length - 1].status).toBe('reconnecting');
    expect(states[states.length - 1].attempt).toBe(1);

    // After backoff a new socket should be created.
    vi.advanceTimersByTime(1_500);
    expect(WS.instances.length).toBe(2);

    client.stop();
  });

  it('v0.1.47: with auto-reconnect OFF, close transitions to disconnected and stays', () => {
    // Regression test for Ethan voice 3630 — production default is no
    // auto-reconnect. The state must flip to `disconnected` and stay
    // there; no second socket is created.
    //
    // v0.1.49 update: this test exercises the CONNECTED-then-CLOSED path
    // (open is emitted before close), so the one-shot initial-connect
    // retry never fires — `hasEverConnectedThisSession` flips to true
    // on the open event. The post-connected disconnect path is still
    // the v0.1.47 "stay disconnected" behaviour, exactly as before.
    const client = new ChatClient();
    client.setToken('abc');
    // Deliberately do NOT call setAutoReconnectEnabled — default is OFF.
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));
    expect(client.getState().status).toBe('disconnected');
    vi.advanceTimersByTime(120_000); // 2 minutes — far past any historical backoff
    expect(WS.instances.length).toBe(1);
    client.stop();
  });

  it('v0.1.49: initial-connect failure (no open before close) gets ONE 5s retry', () => {
    // Regression test for Ethan voice 3692 — "Restream Chat++ is stuck
    // on idle. I just signed in." With auto-reconnect fully disabled
    // (v0.1.47 default), if the very first WS handshake closes before
    // ever reaching `connected`, the client used to flip straight to
    // `disconnected` and stay there — no recovery, user stuck on idle.
    // v0.1.49 schedules exactly ONE retry after 5s for this case so
    // transient sign-in handshake blips self-heal without re-enabling
    // the 60s polling loop.
    const client = new ChatClient();
    client.setToken('abc');
    // Default — no setAutoReconnectEnabled(true).
    client.start();
    const ws0 = WS.instances[0];
    // Close WITHOUT emitting open — simulates a handshake hiccup
    // (network blip, server 500, TLS issue) during the very first
    // connect after sign-in.
    ws0.emit('close', 1006, Buffer.from('handshake-hiccup'));

    // We should now be in `reconnecting` (not `disconnected`) because
    // the v0.1.49 one-shot retry has been scheduled.
    expect(client.getState().status).toBe('reconnecting');
    // No new socket yet — the retry waits 5s.
    expect(WS.instances.length).toBe(1);

    // Advance past the 5s retry delay.
    vi.advanceTimersByTime(5_000);
    // The retry should have fired a fresh handshake.
    expect(WS.instances.length).toBe(2);
    const ws1 = WS.instances[1];
    ws1.emit('open');
    expect(client.getState().status).toBe('connected');

    client.stop();
  });

  it('v0.1.49: initial-connect retry fires AT MOST ONCE — second failure goes to disconnected', () => {
    // After the one-shot retry is consumed, a second handshake failure
    // must NOT trigger a third attempt — we don't loop. Ethan
    // explicitly disabled polling in v0.1.47; v0.1.49's one retry is
    // the only deviation. If two consecutive handshakes fail, the user
    // clicks the manual Reconnect button.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws0 = WS.instances[0];
    ws0.emit('close', 1006, Buffer.from('first-fail'));
    // First retry scheduled.
    expect(client.getState().status).toBe('reconnecting');

    vi.advanceTimersByTime(5_000);
    expect(WS.instances.length).toBe(2);

    // The retry's handshake ALSO fails before reaching `connected`.
    const ws1 = WS.instances[1];
    ws1.emit('close', 1006, Buffer.from('second-fail'));

    // Now we should be at `disconnected` with NO further retry scheduled.
    expect(client.getState().status).toBe('disconnected');
    vi.advanceTimersByTime(120_000);
    expect(WS.instances.length).toBe(2);

    client.stop();
  });

  it('v0.1.49: once we reach `connected`, a subsequent disconnect goes straight to `disconnected` (no retry)', () => {
    // After a successful initial connect, the one-shot retry budget is
    // moot — any future disconnect this session goes through the normal
    // v0.1.47 default (stay disconnected, wait for manual Reconnect).
    // This guards against accidentally giving every disconnect a retry
    // budget by resetting `hasEverConnectedThisSession` too aggressively.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws0 = WS.instances[0];
    ws0.emit('open');
    expect(client.getState().status).toBe('connected');

    // Now the live socket drops.
    ws0.emit('close', 1006, Buffer.from('mid-session-drop'));
    expect(client.getState().status).toBe('disconnected');
    vi.advanceTimersByTime(120_000);
    expect(WS.instances.length).toBe(1);
    client.stop();
  });

  it('v0.1.49: manual reconnect() resets the one-shot budget for the new session', () => {
    // After exhausting the one-shot retry in a previous session and
    // landing on `disconnected`, the user clicks manual Reconnect.
    // That fires a fresh `connect()` AND should restore the retry
    // budget for the new attempt — otherwise the user gets one chance
    // per app-launch which is worse than what they had before.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws0 = WS.instances[0];
    ws0.emit('close', 1006, Buffer.from('first-fail'));
    vi.advanceTimersByTime(5_000); // consume the one-shot retry
    const ws1 = WS.instances[1];
    ws1.emit('close', 1006, Buffer.from('second-fail'));
    expect(client.getState().status).toBe('disconnected');

    // User clicks manual Reconnect.
    client.reconnect();
    expect(WS.instances.length).toBe(3);
    // Simulate ANOTHER handshake failure on the manual-reconnect attempt.
    const ws2 = WS.instances[2];
    ws2.emit('close', 1006, Buffer.from('manual-attempt-fail'));
    // We expect a fresh one-shot retry budget — state goes to
    // `reconnecting`, retry is scheduled.
    expect(client.getState().status).toBe('reconnecting');
    vi.advanceTimersByTime(5_000);
    expect(WS.instances.length).toBe(4);

    client.stop();
  });

  it('v0.1.50: provider-triggered retry with second pre-open failure does NOT loop', async () => {
    // Codex finding 1 from v0.1.49 review: the provider path calls
    // `chat.reconnect()` which (pre-v0.1.50) reset BOTH
    // `hasEverConnectedThisSession` AND `initialRetryUsedThisSession`.
    // If the retry handshake ALSO closed before `'open'`, the second
    // disconnect saw both flags reset and fired ANOTHER 5s retry —
    // forever loop at 5s cadence, strictly worse than the 60s polling
    // Ethan disabled in v0.1.47. The fix: provider path passes
    // `preserveInitialBudget: true` so a second pre-open failure goes
    // straight to `disconnected` instead of looping.
    const client = new ChatClient();
    client.setToken('abc');
    // Mirror what main.ts's `performFullReconnect` does: call
    // `chat.reconnect({preserveInitialBudget: true})`. The bug pre-v0.1.50
    // was that `chat.reconnect()` (any-arg) reset both budget flags.
    const provider = vi.fn().mockImplementation(async () => {
      client.reconnect({ preserveInitialBudget: true });
      return { ok: true };
    });
    client.setReconnectProvider(provider);
    client.start();
    const ws0 = WS.instances[0];
    // First handshake fails pre-open.
    ws0.emit('close', 1006, Buffer.from('first-fail'));
    expect(client.getState().status).toBe('reconnecting');
    expect(WS.instances.length).toBe(1);

    // After 5s the initial-connect retry fires the provider, which
    // tears down ws0 and creates ws1.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(WS.instances.length).toBe(2);

    // The retry handshake ALSO fails pre-open.
    const ws1 = WS.instances[1];
    ws1.emit('close', 1006, Buffer.from('second-fail'));

    // Per v0.1.50: we must land at `disconnected`, NO third socket.
    expect(client.getState().status).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(WS.instances.length).toBe(2);
    expect(provider).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it("v0.1.50: ws emits both 'error' and 'close' for same socket — retry still fires", () => {
    // Codex finding 2 from v0.1.49 review: `ws` commonly emits BOTH
    // `'error'` and `'close'` for the same socket on DNS / TCP-RST /
    // TLS-abort failures. Pre-v0.1.50, the first event ran
    // `handleDisconnect` which armed the 5s retry timer; the second
    // event re-entered `handleDisconnect` which called `clearTimers()`
    // FIRST THING, wiping the just-armed timer AND consuming the
    // one-shot budget (`initialRetryUsedThisSession=true`). The retry
    // never fired and the user landed on `disconnected` — the exact
    // case v0.1.49 was meant to fix. The fix: per-socket terminal-event
    // guard so only the first terminal event drives the disconnect flow.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws0 = WS.instances[0];
    // First the socket emits `'error'`.
    ws0.emit('error', new Error('ECONNRESET'));
    // Then `'close'` immediately after (matches real ws lib behaviour).
    ws0.emit('close', 1006, Buffer.from('reset'));

    // After both terminal events, we MUST be in `reconnecting` (the
    // one-shot retry was scheduled by the first event and survived the
    // second event's no-op).
    expect(client.getState().status).toBe('reconnecting');
    expect(WS.instances.length).toBe(1);

    // The retry should still fire after 5s — the timer wasn't wiped.
    vi.advanceTimersByTime(5_000);
    expect(WS.instances.length).toBe(2);

    client.stop();
  });

  it("v0.1.50: double-fire after `connected` doesn't run handleDisconnect twice", () => {
    // Same guard, post-connected path: if a live socket emits both
    // `'error'` and `'close'`, we shouldn't double-bump `attempt` or
    // re-fire state transitions. The state should land at `disconnected`
    // with attempt=1, not attempt=2.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws0 = WS.instances[0];
    ws0.emit('open');
    expect(client.getState().status).toBe('connected');

    ws0.emit('error', new Error('mid-session-error'));
    ws0.emit('close', 1006, Buffer.from('mid-session-close'));

    expect(client.getState().status).toBe('disconnected');
    expect(client.getState().attempt).toBe(1);
    expect(WS.instances.length).toBe(1);

    client.stop();
  });

  it('reconnect() bypasses backoff timer and opens a fresh socket immediately', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws0 = WS.instances[0];
    ws0.emit('open');
    ws0.emit('close', 1006, Buffer.from('boom'));
    // We're now in backoff for ~1s. Without advancing timers, calling
    // reconnect() should immediately spawn a fresh socket — no timer wait.
    expect(WS.instances.length).toBe(1);
    client.reconnect();
    expect(WS.instances.length).toBe(2);
    // The reconnect path should reset the attempt counter back to 0 so
    // future backoff starts fresh from base.
    expect(client.getState().status).toBe('connecting');
    expect(client.getState().attempt).toBe(0);
    client.stop();
  });

  it('reconnect() from connected state tears down current socket and opens new one', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws0 = WS.instances[0];
    ws0.emit('open');
    expect(client.getState().status).toBe('connected');
    client.reconnect();
    // Fresh socket created.
    expect(WS.instances.length).toBe(2);
    expect(client.getState().status).toBe('connecting');
    client.stop();
  });
});
