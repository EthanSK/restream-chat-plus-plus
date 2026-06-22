/* eslint-disable @typescript-eslint/no-var-requires */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same fake-ws shape as ws-reconnect.test.ts so we can drive `message`
// events synchronously and assert the chat-context-sniff path. v0.1.20.
vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWS extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    constructor(public url: string) {
      super();
      FakeWS.instances.push(this);
    }
    ping() {
      // Test fake: the client only needs the method to exist.
    }
    close() {
      // Test fake: close side effects are driven by explicit emitted events.
    }
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

/**
 * v0.1.34: tests renamed from "showId sniff" → "chatContext sniff" since
 * the sniffer now picks up the full `{showId, eventId, instant}` union
 * (was showId-only in v0.1.20-v0.1.33). The corresponding ws-client API
 * also moved from `getShowId() / invalidateShowId()` →
 * `getChatContext() / invalidateChatContext()`.
 */
describe('ChatClient — chat-context sniff', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is empty before any frame has arrived', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    expect(client.getChatContext()).toEqual({});
    client.stop();
  });

  it('stays empty after only heartbeats — heartbeats carry no context', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, { action: 'heartbeat', timestamp: 1 });
    sendFrame(client, { action: 'heartbeat', timestamp: 2 });
    expect(client.getChatContext()).toEqual({});
    client.stop();
  });

  it('stays empty after only connection_info frames — those have no showId / eventId', () => {
    // The live-fire bug v0.1.20 fixed: connection_info frames flow on
    // every WS connect even when the user isn't streaming, but they
    // carry no chat context. Pre-v0.1.20 the inline send was gated on
    // showId, so users got "waiting for first chat frame" forever.
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
    expect(client.getChatContext()).toEqual({});
    client.stop();
  });

  it('sniffs eventId from an incoming `event` frame', () => {
    // v0.1.34: `event` frames carry an `eventId`, not a `showId`. The
    // old test asserted `showId: "show-from-event"` but the live payload
    // actually emits `eventId`. The chat backend wants eventId on the
    // reply body anyway.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'event',
      payload: {
        connectionIdentifier: '1-twitch-x',
        eventId: 'evt-from-event',
        eventIdentifier: 'ident-1',
        eventPayload: { author: { name: 'alice' }, text: 'hi' },
      },
    });
    expect(client.getChatContext()).toEqual({ eventId: 'evt-from-event' });
    client.stop();
  });

  it('sniffs both showId AND eventId from a frame that carries both', () => {
    // Defensive: some Restream frames may include both identifiers
    // (e.g. a scheduled show with a backing event). The send-body builder
    // applies the priority order showId > eventId; here we just verify
    // both are captured by the sniffer.
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
        eventId: 'evt-from-reply',
        text: 'hi back',
      },
    });
    expect(client.getChatContext()).toEqual({
      showId: 'show-from-reply',
      eventId: 'evt-from-reply',
    });
    client.stop();
  });

  it('sniffs `instant: true` when a frame includes it', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'event',
      payload: {
        connectionIdentifier: '1-twitch-x',
        eventId: 'rtmp/instant',
        instant: true,
      },
    });
    expect(client.getChatContext()).toEqual({
      eventId: 'rtmp/instant',
      instant: true,
    });
    client.stop();
  });

  it('would sniff showId from connection_info IF Restream ever added it', () => {
    // Defensive coverage: the sniff is intentionally untyped on action, so
    // if Restream's backend ever starts emitting `payload.showId` on
    // connection_info frames (which would make the "no first chat frame"
    // problem fully self-healing without the REST fallback), we'll pick
    // it up automatically without code changes. Pins the behaviour so
    // a future "only sniff event/reply frames" refactor doesn't silently
    // regress it.
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
        // Hypothetical future field.
        showId: 'hypothetical-show-id',
      },
    });
    expect(client.getChatContext()).toEqual({ showId: 'hypothetical-show-id' });
    client.stop();
  });

  it('resets chat context on reconnect so stale values cannot leak across account switches', () => {
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'event',
      payload: { eventId: 'evt-1' },
    });
    expect(client.getChatContext()).toEqual({ eventId: 'evt-1' });

    // Force a reconnect. The new socket must start with empty context
    // — different stream / different account could be involved.
    client.reconnect();
    WS.instances[1].emit('open');
    expect(client.getChatContext()).toEqual({});

    sendFrame(client, {
      action: 'event',
      payload: { eventId: 'evt-2' },
    });
    expect(client.getChatContext()).toEqual({ eventId: 'evt-2' });
    client.stop();
  });

  it('invalidateChatContext() clears the cached context without tearing down WS', () => {
    // Used by the inline-send retry path on 404 — the context we held
    // was stale-but-present, so we drop it and let the next REST hit
    // re-hydrate. Verifies the new (v0.1.34) name doesn't drift from
    // chat-send.ts's `refreshContext` hook.
    const client = new ChatClient();
    client.setToken('abc');
    client.start();
    WS.instances[0].emit('open');
    sendFrame(client, {
      action: 'event',
      payload: { eventId: 'evt-stale', showId: 'show-stale' },
    });
    expect(client.getChatContext()).toEqual({
      eventId: 'evt-stale',
      showId: 'show-stale',
    });

    client.invalidateChatContext();
    expect(client.getChatContext()).toEqual({});
    client.stop();
  });
});
