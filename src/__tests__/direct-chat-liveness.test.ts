/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store, StoreSchema } from '../main/store';

const fakeSafeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString()),
}));

vi.mock('electron', () => ({
  safeStorage: fakeSafeStorage,
  shell: { openExternal: vi.fn() },
}));

vi.mock('../main/credentials', () => ({
  loadTwitchCreds: () => ({ clientId: 'twitch-client' }),
  loadKickCreds: () => ({
    clientId: 'kick-client',
    clientSecret: 'kick-secret',
    relayUrl: 'wss://relay.example/socket',
    relayToken: 'relay-token',
  }),
}));

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CONNECTING;
    readonly sent: string[] = [];

    constructor(
      public readonly url: string,
      public readonly options?: unknown,
    ) {
      super();
      FakeWebSocket.instances.push(this);
      this.on('open', () => {
        this.readyState = FakeWebSocket.OPEN;
      });
    }

    send(value: string): void {
      this.sent.push(value);
    }

    close(code = 1000, reason = ''): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', code, Buffer.from(reason));
    }

    terminate(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', 1006, Buffer.alloc(0));
    }
  }
  return { default: FakeWebSocket };
});

import WebSocket from 'ws';
import { KickChatSource } from '../main/kick-chat-source';
import { TwitchChatSource } from '../main/twitch-chat-source';

const WS = WebSocket as any;

function makeStore(values: Partial<StoreSchema>): Store {
  const data = { ...values };
  return {
    get: (key) => data[key] as any,
    set: (key, value) => {
      (data as any)[key] = value;
    },
    delete: (key) => {
      delete (data as any)[key];
    },
  };
}

function encrypted(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

describe.sequential('direct chat liveness recovery', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://id.twitch.tv/oauth2/validate') {
          return okJson({
            client_id: 'twitch-client',
            login: 'reeethan_yt',
            scopes: ['user:read:chat', 'user:write:chat'],
            user_id: '42',
            expires_in: 3_600,
          });
        }
        if (url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
          return okJson({ data: [] });
        }
        if (url.startsWith('https://api.twitch.tv/helix/streams')) {
          return okJson({ data: [{ viewer_count: 1 }] });
        }
        if (url === 'https://id.kick.com/oauth/token/introspect') {
          return okJson({
            data: {
              active: true,
              exp: Math.floor(Date.now() / 1_000) + 3_600,
              scope: 'channel:read events:subscribe chat:write',
            },
          });
        }
        if (url === 'https://api.kick.com/public/v1/channels') {
          return okJson({ data: [{ broadcaster_user_id: 84, slug: 'reeethan' }] });
        }
        if (url === 'https://api.kick.com/public/v1/events/subscriptions') {
          return okJson({ data: [] });
        }
        if (url.startsWith('https://api.kick.com/public/v1/users/livestreams')) {
          return okJson({ data: [{ viewer_count: 1 }] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reconnects Twitch when EventSub stops delivering keepalives', async () => {
    const source = new TwitchChatSource(
      makeStore({
        twitchTokenEnc: encrypted({
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          scope: ['user:read:chat', 'user:write:chat'],
        }),
      }),
    );
    await source.start();
    const socket = WS.instances[0];
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({
        metadata: { message_type: 'session_welcome' },
        payload: { session: { id: 'session-1' } },
      }),
    );
    await vi.waitFor(() => expect(source.getState().status).toBe('connected'));

    await vi.advanceTimersByTimeAsync(90_000);

    expect(socket.readyState).toBe(WS.CLOSED);
    expect(source.getState()).toMatchObject({
      status: 'connecting',
      detail: expect.stringContaining('stopped receiving data'),
    });
    source.stop();
  });

  it('reconnects Kick when the relay stops answering its application heartbeat', async () => {
    const source = new KickChatSource(
      makeStore({
        kickTokenEnc: encrypted({
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          scope: 'channel:read events:subscribe chat:write',
        }),
      }),
    );
    await source.start();
    const socket = WS.instances[0];
    socket.emit('open');
    expect(source.getState().status).toBe('connected');

    await vi.advanceTimersByTimeAsync(90_000);

    expect(socket.sent).toEqual(['ping', 'ping']);
    expect(socket.readyState).toBe(WS.CLOSED);
    expect(source.getState()).toMatchObject({
      status: 'connecting',
      detail: expect.stringContaining('stopped responding'),
    });
    source.stop();
  });

  it('keeps Kick connected while the relay answers pong', async () => {
    const source = new KickChatSource(
      makeStore({
        kickTokenEnc: encrypted({
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          scope: 'channel:read events:subscribe chat:write',
        }),
      }),
    );
    await source.start();
    const socket = WS.instances[0];
    socket.emit('open');

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      socket.emit('message', 'pong');
    }

    expect(socket.readyState).toBe(WS.OPEN);
    expect(source.getState().status).toBe('connected');
    source.stop();
  });
});
