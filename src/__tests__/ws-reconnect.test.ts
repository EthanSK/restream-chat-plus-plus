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
