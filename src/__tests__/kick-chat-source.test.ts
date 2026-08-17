import { describe, expect, it } from 'vitest';
import {
  kickToken,
  missingKickScopes,
  normalizeKickRelayMessage,
  parseKickChannelIdentity,
  parseKickViewerState,
  sendKickChatMessage,
} from '../main/kick-chat-source';

describe('Kick OAuth scopes', () => {
  it('reports only the grants missing from the authoritative scope string', () => {
    expect(
      missingKickScopes('channel:read events:subscribe', [
        'channel:read',
        'events:subscribe',
        'chat:write',
      ]),
    ).toEqual(['chat:write']);
  });

  it('does not assume requested grants when Kick omits scope from a token response', () => {
    expect(
      kickToken({ access_token: 'access', refresh_token: 'refresh', expires_in: 3_600 }).scope,
    ).toBe('');
  });
});

describe('parseKickChannelIdentity', () => {
  it('uses channel data without requesting the email-bearing user scope', () => {
    expect(
      parseKickChannelIdentity({
        data: [{ broadcaster_user_id: 42, slug: 'reeethan' }],
      }),
    ).toEqual({ userId: 42, name: 'reeethan' });
  });

  it('rejects malformed channel data', () => {
    expect(parseKickChannelIdentity({ data: [] })).toBeUndefined();
  });
});

describe('normalizeKickRelayMessage', () => {
  it('normalizes a verified relay chat event', () => {
    const message = normalizeKickRelayMessage(
      JSON.stringify({
        kind: 'kick.chat.message',
        event: {
          message_id: 'kick-1',
          content: 'hello Kick',
          created_at: '2026-08-14T12:00:00Z',
          sender: {
            username: 'Grace',
            identity: { username_color: '#53FC18' },
          },
        },
      }),
    );
    expect(message).toMatchObject({
      id: 'kick-1',
      platform: 'kick',
      username: 'Grace',
      text: 'hello Kick',
      color: '#53FC18',
      source: 'kick-direct',
    });
  });

  it('rejects non-chat and malformed relay messages', () => {
    expect(normalizeKickRelayMessage('{"kind":"connected"}')).toBeUndefined();
    expect(normalizeKickRelayMessage('nope')).toBeUndefined();
  });
});

describe('sendKickChatMessage', () => {
  it('sends as the connected user with the official API', async () => {
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.kick.com/public/v1/chat');
      expect(JSON.parse(String(init?.body))).toEqual({
        broadcaster_user_id: 42,
        content: 'hello Kick',
        type: 'user',
      });
      return new Response(
        JSON.stringify({ data: { message_id: 'k-1', is_sent: true } }),
        { status: 200 },
      );
    };
    await expect(
      sendKickChatMessage({
        accessToken: 'token',
        broadcasterUserId: 42,
        text: 'hello Kick',
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true, status: 200, messageId: 'k-1' });
  });

  it('marks a rejected authorization as requiring reconnect', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ message: 'Missing scope' }), { status: 401 });
    await expect(
      sendKickChatMessage({
        accessToken: 'token',
        broadcasterUserId: 42,
        text: 'hello',
        fetchImpl,
      }),
    ).resolves.toMatchObject({ ok: false, authorizationRequired: true });
  });
});

describe('parseKickViewerState', () => {
  it('reads the channel viewer count independently of Restream', () => {
    expect(parseKickViewerState({ data: [{ viewer_count: 9 }] })).toEqual({
      isLive: true,
      viewerCount: 9,
    });
  });

  it('reports an empty livestream response as offline', () => {
    expect(parseKickViewerState({ data: [] })).toEqual({ isLive: false });
  });
});
