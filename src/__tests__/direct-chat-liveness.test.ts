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
import { DirectChatSources } from '../main/direct-chat-sources';
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

  it('preserves Twitch authorization when a token refresh fails temporarily', async () => {
    const stored = encrypted({
      accessToken: 'expired-access',
      refreshToken: 'refresh',
      expiresAt: Date.now(),
      scope: ['user:read:chat', 'user:write:chat'],
    });
    const store = makeStore({ twitchTokenEnc: stored });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === 'https://id.twitch.tv/oauth2/token') {
          return new Response('{}', { status: 503 });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const source = new TwitchChatSource(store);

    await source.start();

    expect(store.get('twitchTokenEnc')).toBe(stored);
    expect(source.getState()).toMatchObject({
      status: 'connecting',
      detail: expect.stringContaining('Twitch could not refresh authorization'),
    });
    source.stop();
  });

  it('preserves Twitch authorization when validation fails temporarily', async () => {
    const stored = encrypted({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scope: ['user:read:chat', 'user:write:chat'],
    });
    const store = makeStore({ twitchTokenEnc: stored });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === 'https://id.twitch.tv/oauth2/validate') {
          return new Response('{}', { status: 500 });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const source = new TwitchChatSource(store);

    await source.start();

    expect(store.get('twitchTokenEnc')).toBe(stored);
    expect(source.getState()).toMatchObject({
      status: 'connecting',
      detail: expect.stringContaining('Twitch could not verify authorization'),
    });
    source.stop();
  });

  it('recovers the Twitch session once the outage clears', async () => {
    const store = makeStore({
      twitchTokenEnc: encrypted({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: ['user:read:chat', 'user:write:chat'],
      }),
    });
    let offline = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (offline) throw new TypeError('fetch failed');
        if (url === 'https://id.twitch.tv/oauth2/validate') {
          return okJson({
            client_id: 'twitch-client',
            login: 'reeethan_yt',
            scopes: ['user:read:chat', 'user:write:chat'],
            user_id: '42',
            expires_in: 3_600,
          });
        }
        if (url === 'https://api.twitch.tv/helix/eventsub/subscriptions') return okJson({ data: [] });
        if (url.startsWith('https://api.twitch.tv/helix/streams')) {
          return okJson({ data: [{ viewer_count: 7 }] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const source = new TwitchChatSource(store);
    await source.start();
    expect(source.getState().status).toBe('connecting');
    expect(WS.instances).toHaveLength(0);

    offline = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(WS.instances).toHaveLength(1));

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
    source.stop();
  });

  it('requires a fresh Twitch connect only when Twitch rejects the authorization', async () => {
    const store = makeStore({
      twitchTokenEnc: encrypted({
        accessToken: 'revoked-access',
        refreshToken: 'revoked-refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: ['user:read:chat', 'user:write:chat'],
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://id.twitch.tv/oauth2/validate') {
          return new Response(JSON.stringify({ message: 'invalid access token' }), { status: 401 });
        }
        if (url === 'https://id.twitch.tv/oauth2/token') {
          return new Response(JSON.stringify({ message: 'Invalid refresh token' }), { status: 400 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const source = new TwitchChatSource(store);

    await source.start();

    expect(store.get('twitchTokenEnc')).toBeUndefined();
    expect(source.getState()).toMatchObject({
      status: 'disconnected',
      detail: 'Connect Twitch again to continue.',
    });
    source.stop();
  });

  it('coalesces simultaneous Twitch token refreshes', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://id.twitch.tv/oauth2/token') return refreshResponse;
      if (url === 'https://id.twitch.tv/oauth2/validate') {
        return okJson({
          client_id: 'twitch-client',
          login: 'reeethan_yt',
          scopes: ['user:read:chat', 'user:write:chat'],
          user_id: '42',
          expires_in: 3_600,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = makeStore({
      twitchTokenEnc: encrypted({
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        expiresAt: Date.now(),
        scope: ['user:read:chat', 'user:write:chat'],
      }),
    });
    const source = new TwitchChatSource(store);

    const start = source.start();
    const reconnect = source.reconnect();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://id.twitch.tv/oauth2/token',
        expect.any(Object),
      );
    });
    resolveRefresh?.(
      okJson({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 14_400,
        scope: ['user:read:chat', 'user:write:chat'],
      }),
    );
    await Promise.all([start, reconnect]);

    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === 'https://id.twitch.tv/oauth2/token'),
    ).toHaveLength(1);
    expect(store.get('twitchTokenEnc')).toBe(
      encrypted({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 14_400_000,
        scope: ['user:read:chat', 'user:write:chat'],
      }),
    );
    source.stop();
  });

  it('retries a disconnected direct source from the toolbar refresh path', async () => {
    const directChat = new DirectChatSources(
      makeStore({
        twitchTokenEnc: encrypted({
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          scope: ['user:read:chat', 'user:write:chat'],
        }),
      }),
    );

    await directChat.reconnect();

    expect(directChat.getConnections()[0]).toMatchObject({
      provider: 'twitch',
      status: 'connecting',
      accountName: 'reeethan_yt',
    });
    // Kick holds no authorization, so the retry leaves it untouched instead of nagging for a connect.
    expect(directChat.getConnections()[1]).toEqual({ provider: 'kick', status: 'disconnected' });
    expect(WS.instances).toHaveLength(1);
    directChat.stop();
  });

  it('suppresses every direct-provider self event even after pending-send correlation is absent', async () => {
    const directChat = new DirectChatSources(
      makeStore({
        twitchTokenEnc: encrypted({
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          scope: ['user:read:chat', 'user:write:chat'],
        }),
      }),
    );
    const forwarded = vi.fn();
    directChat.on('message', forwarded);
    await directChat.start();
    const socket = WS.instances[0];
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({
        metadata: { message_type: 'session_welcome' },
        payload: { session: { id: 'session-1' } },
      }),
    );
    await vi.waitFor(() => expect(directChat.getConnections()[0].status).toBe('connected'));

    socket.emit(
      'message',
      JSON.stringify({
        metadata: { message_type: 'notification' },
        payload: {
          event: {
            message_id: 'late-own-echo',
            chatter_user_id: '42',
            chatter_user_name: 'reeethan_yt',
            message: { text: 'late self echo' },
          },
        },
      }),
    );
    await Promise.resolve();
    expect(forwarded).not.toHaveBeenCalled();

    socket.emit(
      'message',
      JSON.stringify({
        metadata: { message_type: 'notification' },
        payload: {
          event: {
            message_id: 'viewer-message',
            chatter_user_id: 'viewer-1',
            chatter_user_name: 'viewer',
            message: { text: 'hello' },
          },
        },
      }),
    );
    await vi.waitFor(() => expect(forwarded).toHaveBeenCalledOnce());
    expect(forwarded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'viewer-message', self: false }),
    );
    directChat.stop();
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
