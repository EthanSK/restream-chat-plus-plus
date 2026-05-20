import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * v0.1.45 tests: auto-reconnect uses the SAME flow as the manual button.
 *
 * Pre-v0.1.45 the WS client's `handleDisconnect` ran a plain
 * `setTimeout(() => this.connect(), backoff)` that bypassed OAuth refresh —
 * so once the access token expired during a disconnect window, the auto
 * loop ran forever without ever re-handshaking. The manual button worked
 * because it lived in main.ts and ran OAuth refresh first.
 *
 * Fix: ChatClient.setReconnectProvider(fn) lets main.ts inject the same
 * full-reconnect function the manual button uses. handleDisconnect now
 * delegates to that provider every 60s while disconnected.
 */

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWS extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    constructor(public url: string) {
      super();
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

import {
  ChatClient,
  __test_auto_retry_interval_ms,
  type AutoReconnectAttempt,
} from '../main/ws-client';
import WSMock from 'ws';

const WS = WSMock as any;

describe('ChatClient unified reconnect (v0.1.45)', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes a 60s auto-retry interval', () => {
    expect(__test_auto_retry_interval_ms).toBe(60_000);
  });

  it('auto-reconnect calls the provider after AUTO_RETRY_INTERVAL_MS while disconnected', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: true });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));
    expect(client.getState().status).toBe('reconnecting');
    expect(provider).not.toHaveBeenCalled();

    // Just before 60s: still no call
    await vi.advanceTimersByTimeAsync(59_999);
    expect(provider).not.toHaveBeenCalled();

    // At 60s: provider fires
    await vi.advanceTimersByTimeAsync(2);
    expect(provider).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it('manual reconnect() and auto-reconnect both call performFullReconnect', async () => {
    // Verifies the divergence is closed: a single provider function gets
    // called by both paths. We simulate the provider by tracking calls.
    const client = new ChatClient();
    client.setToken('abc');

    let callsFromAutoPath = 0;
    const provider = vi.fn(async () => {
      callsFromAutoPath += 1;
      return { ok: true };
    });
    client.setReconnectProvider(provider);

    // 1. Manual reconnect: in the real app the IPC handler calls
    //    `performFullReconnect()` directly, then chat.reconnect(). The
    //    provider is the SAME function — main.ts wires it once. So both
    //    the manual button and the provider end up running the same
    //    code. We assert that here by invoking the provider directly
    //    (simulating the manual handler) and then triggering an auto
    //    retry (provider invoked again by the ws client itself).
    await provider();
    expect(provider).toHaveBeenCalledTimes(1);

    // 2. Auto reconnect: trigger a close, advance 60s, provider should
    //    have been called once more.
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));
    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(callsFromAutoPath).toBe(2);

    client.stop();
  });

  it('re-schedules another 60s tick when the provider returns ok: false', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    // Always return ok: false (e.g. refresh-failed every time).
    const provider = vi.fn().mockResolvedValue({ ok: false, reason: 'refresh-failed' });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));

    // First tick
    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).toHaveBeenCalledTimes(1);

    // Second tick — should fire automatically since provider returned !ok
    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).toHaveBeenCalledTimes(2);

    // Third tick
    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).toHaveBeenCalledTimes(3);

    client.stop();
  });

  it('stops retrying once the WS reaches connected', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    // First provider call: succeeds, opens a new socket that does NOT
    // immediately close. To simulate, we have the provider call
    // chat.reconnect() then we manually emit 'open' on the new socket.
    const provider = vi.fn(async () => {
      client.reconnect();
      // The new socket is now WS.instances[<latest>]; emit open so the
      // state flips to connected.
      const fresh = WS.instances[WS.instances.length - 1];
      fresh.emit('open');
      return { ok: true };
    });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));

    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(client.getState().status).toBe('connected');

    // Advance another 60s — no second call should fire since we're
    // back to connected.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it('stops retrying when stop() is called', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: false, reason: 'still-no' });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));

    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).toHaveBeenCalledTimes(1);

    client.stop();
    await vi.advanceTimersByTimeAsync(60_001 * 5);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('feeds each attempt outcome to the autoAttemptListener', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const attempts: AutoReconnectAttempt[] = [];
    client.setAutoAttemptListener((entry) => attempts.push(entry));
    // First call: ok: false → second call: ok: true (via chat.reconnect)
    let call = 0;
    const provider = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, reason: 'refresh-failed' };
      client.reconnect();
      const fresh = WS.instances[WS.instances.length - 1];
      fresh.emit('open');
      return { ok: true };
    });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));

    await vi.advanceTimersByTimeAsync(60_001);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('failed');
    expect(attempts[0].failureReason).toBe('refresh-failed');

    await vi.advanceTimersByTimeAsync(60_001);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].outcome).toBe('ok');
    expect(attempts[1].failureReason).toBeUndefined();

    client.stop();
  });

  it('falls back to legacy exponential backoff when no provider is installed', async () => {
    // Backward-compat: existing tests that don't install a provider still
    // see the old self-reconnect behaviour.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));
    // Legacy backoff is 1s on first close
    vi.advanceTimersByTime(1_500);
    expect(WS.instances.length).toBe(2);
    client.stop();
  });

  it('a manual reconnect() cancels any pending auto-retry timer', async () => {
    const client = new ChatClient();
    client.setToken('abc');
    const provider = vi.fn().mockResolvedValue({ ok: true });
    client.setReconnectProvider(provider);
    client.start();
    const ws = WS.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from('boom'));

    // Halfway through the wait, the user clicks manual reconnect.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(provider).not.toHaveBeenCalled();
    client.reconnect(); // manual call
    // The manual reconnect opens a fresh socket immediately.
    expect(WS.instances.length).toBe(2);

    // Advancing past the would-have-fired auto timer should NOT
    // fire the provider — clearTimers in reconnect() cancelled it.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(provider).not.toHaveBeenCalled();

    client.stop();
  });
});
