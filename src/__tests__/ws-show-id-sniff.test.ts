import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same fake-ws shape as ws-reconnect.test.ts so we can drive `message`
// events synchronously and assert the showId-sniff path. v0.1.20.
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

// Import after the mock so the mocked `ws` module is wired in.
import { ChatClient } from '../main/ws-client';
import WSMock from 'ws';

const WS = WSMock as any;

/**
 * Helper: emit a parsed frame as a JSON string on the latest socket. The
 * ChatClient's message handler JSON-parses, so we mimic the wire format.
 */
function sendFrame(client: ChatClient, frame: unknown) {
  const ws = WS.instances[WS.instances.length - 1];
  ws.emit('message', Buffer.from(JSON.stringify(frame)));
}

describe('ChatClient — showId sniff (v0.1.20)', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is undefined before any frame has arrived', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    expect(client.getShowId()).toBeUndefined();
    client.stop();
  });

  it('stays undefined after only heartbeats — heartbeats carry no showId', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, { action: 'heartbeat', timestamp: 1 });
    sendFrame(client, { action: 'heartbeat', timestamp: 2 });
    expect(client.getShowId()).toBeUndefined();
    client.stop();
  });

  it('stays undefined after only connection_info frames — those have no showId either', () => {
    // This is the live-fire bug v0.1.20 fixes: connection_info frames flow
    // on every WS connect even when the user isn't streaming, but they
    // carry no showId. Pre-v0.1.20 the inline send was gated on showId,
    // so users got "waiting for first chat frame" forever.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'connection_info',
      payload: {
        connectionIdentifier: '5849342-twitch-906603453',
        connectionUuid: 'bb3d1063-a424-4190-b543-72b04f1a6ce0',
        eventSourceId: 2,
        status: 'connected',
        target: { owner: { displayName: '3000AD_Music', id: '1', name: '3000ad' } },
        userId: 5849342,
      },
    });
    expect(client.getShowId()).toBeUndefined();
    client.stop();
  });

  it('sniffs showId from an incoming `event` frame', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'event',
      payload: {
        connectionIdentifier: '1-twitch-x',
        eventId: 'evt-1',
        eventIdentifier: 'ident-1',
        eventPayload: { author: { name: 'alice' }, text: 'hi' },
        showId: 'show-from-event',
      },
    });
    expect(client.getShowId()).toBe('show-from-event');
    client.stop();
  });

  it('sniffs showId from a `reply_created` frame', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'reply_created',
      payload: {
        clientReplyUuid: 'cuuid-1',
        connectionIdentifiers: ['1-twitch-x'],
        eventSourceId: 1,
        replyUuid: 'ruuid-1',
        showId: 'show-from-reply',
        text: 'hi back',
      },
    });
    expect(client.getShowId()).toBe('show-from-reply');
    client.stop();
  });

  it('would sniff showId from connection_info IF Restream ever added it', () => {
    // Defensive coverage: the sniff is intentionally untyped on action, so
    // if Restream's backend ever starts emitting `payload.showId` on
    // connection_info frames (which would make the "no first chat frame"
    // problem fully self-healing without the REST fallback), we'll pick
    // it up automatically without code changes. This test pins the
    // behaviour so a future "only sniff event/reply frames" refactor
    // doesn't silently regress it.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'connection_info',
      payload: {
        connectionIdentifier: '1-twitch-x',
        connectionUuid: 'uuid-1',
        eventSourceId: 2,
        status: 'connected',
        target: {},
        userId: 1,
        // Hypothetical future field. Today Restream does NOT include this
        // (verified against raw-frames.jsonl 2026-05-17) but if they
        // do, we want zero-touch upgrades.
        showId: 'hypothetical-show-id',
      },
    });
    expect(client.getShowId()).toBe('hypothetical-show-id');
    client.stop();
  });

  it('resets showId on reconnect so a stale value cannot leak across account switches', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'event',
      payload: { showId: 'show-1' },
    });
    expect(client.getShowId()).toBe('show-1');

    // Force a reconnect. The new socket must start with showId undefined
    // — different stream / different account could be involved.
    client.reconnect();
    WS.instances[1].emit('open');
    expect(client.getShowId()).toBeUndefined();

    sendFrame(client, {
      action: 'event',
      payload: { showId: 'show-2' },
    });
    expect(client.getShowId()).toBe('show-2');
    client.stop();
  });
});
