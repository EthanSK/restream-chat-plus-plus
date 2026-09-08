import { describe, expect, it } from 'vitest';
import {
  normalizeTwitchNotification,
  parseTwitchViewerState,
  sendTwitchChatMessage,
} from '../main/twitch-chat-source';

describe('normalizeTwitchNotification', () => {
  it('normalizes an official channel.chat.message notification', () => {
    const message = normalizeTwitchNotification({
      event: {
        message_id: 'message-1',
        chatter_user_name: 'Ada',
        message: { text: 'hello Twitch' },
      },
    });
    expect(message).toMatchObject({
      id: 'message-1',
      platform: 'twitch',
      username: 'Ada',
      text: 'hello Twitch',
      source: 'twitch-direct',
    });
  });

  it('rejects malformed notifications', () => {
    expect(normalizeTwitchNotification({ event: { message_id: 'x' } })).toBeUndefined();
  });
});

describe('sendTwitchChatMessage', () => {
  it('sends as the connected broadcaster with the official API', async () => {
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.twitch.tv/helix/chat/messages');
      expect(JSON.parse(String(init?.body))).toEqual({
        broadcaster_id: '42',
        sender_id: '42',
        message: 'hello Twitch',
      });
      return new Response(
        JSON.stringify({ data: [{ message_id: 't-1', is_sent: true }] }),
        { status: 200 },
      );
    };
    await expect(
      sendTwitchChatMessage({
        clientId: 'client-id',
        accessToken: 'token',
        userId: '42',
        text: 'hello Twitch',
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true, status: 200, messageId: 't-1' });
  });

  it('marks a rejected authorization as requiring reconnect', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ message: 'Missing scope' }), { status: 401 });
    await expect(
      sendTwitchChatMessage({
        clientId: 'client-id',
        accessToken: 'token',
        userId: '42',
        text: 'hello',
        fetchImpl,
      }),
    ).resolves.toMatchObject({ ok: false, authorizationRequired: true });
  });

  it('preserves the exact drop code instead of losing the reason behind HTTP 200', async () => {
    const result = await sendTwitchChatMessage({ clientId: 'client', accessToken: 'token', userId: '42', text: 'hello',
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ is_sent: false, drop_reason: {
        code: 'automod_held', message: 'Your message has been held for review by Automod.',
      } }] }), { status: 200 }),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'automod_held', error: expect.stringContaining('(automod_held)') });
  });

  it('does not mislabel a chat-room permission rejection as an expired login', async () => {
    const result = await sendTwitchChatMessage({ clientId: 'client', accessToken: 'token', userId: '42', text: 'hello',
      fetchImpl: async () => new Response(JSON.stringify({ message: 'The sender is not permitted to send chat messages.' }), { status: 403 }),
    });
    expect(result).toMatchObject({ ok: false, authorizationRequired: false, status: 403 });
  });
});

describe('parseTwitchViewerState', () => {
  it('reads the channel viewer count independently of Restream', () => {
    expect(parseTwitchViewerState({ data: [{ viewer_count: 17 }] })).toEqual({
      isLive: true,
      viewerCount: 17,
    });
  });

  it('reports an empty streams response as offline', () => {
    expect(parseTwitchViewerState({ data: [] })).toEqual({ isLive: false });
  });
});
