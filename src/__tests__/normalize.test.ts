import { describe, it, expect } from 'vitest';
import {
  normalizeRestreamEvent,
  normalizeRestreamEventDetailed,
} from '../main/normalize';

// All eventTypeIds tested below are taken from the official Restream docs:
// https://developers.restream.io/chat/events

describe('normalizeRestreamEvent', () => {
  it('parses Twitch-shaped event payload (eventTypeId=4, author.displayName)', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 4,
        eventPayload: {
          id: 'msg-1',
          author: { displayName: 'StreamerFan', color: '#9146FF' },
          text: 'hello there',
          timestamp: 1714000000000,
        },
      },
    };
    const m = normalizeRestreamEvent(raw);
    expect(m).toBeDefined();
    expect(m!.platform).toBe('twitch');
    expect(m!.username).toBe('StreamerFan');
    expect(m!.text).toBe('hello there');
    expect(m!.ts).toBe(1714000000000);
    expect(m!.color).toBe('#9146FF');
  });

  it('parses YouTube-shaped event payload (eventTypeId=5, author.displayName)', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 5,
        eventPayload: {
          id: 'yt-1',
          author: { displayName: 'YTViewer' },
          text: 'gg streamer',
          timestamp: 1714000000000,
        },
      },
    };
    const m = normalizeRestreamEvent(raw);
    expect(m?.platform).toBe('youtube');
    expect(m?.username).toBe('YTViewer');
    expect(m?.text).toBe('gg streamer');
  });

  it('parses Kick-shaped event payload (eventTypeId=25, author.username)', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 25,
        eventPayload: {
          id: 'k-1',
          author: { username: 'kickfan' },
          text: 'PogChamp',
        },
      },
    };
    const m = normalizeRestreamEvent(raw);
    expect(m?.platform).toBe('kick');
    expect(m?.username).toBe('kickfan');
  });

  it('parses X (eventTypeId=24) and Trovo (22) and Rumble (32)', () => {
    expect(
      normalizeRestreamEvent({
        action: 'event',
        payload: {
          eventTypeId: 24,
          eventPayload: { author: { displayName: 'xuser' }, text: 'hi' },
        },
      })?.platform,
    ).toBe('x');
    expect(
      normalizeRestreamEvent({
        action: 'event',
        payload: {
          eventTypeId: 22,
          eventPayload: { author: { name: 'tvuser' }, text: 'hi' },
        },
      })?.platform,
    ).toBe('trovo');
    expect(
      normalizeRestreamEvent({
        action: 'event',
        payload: {
          eventTypeId: 32,
          eventPayload: { author: { displayName: 'rumbler' }, text: 'hi' },
        },
      })?.platform,
    ).toBe('rumble');
  });

  it('returns undefined for non-event actions', () => {
    expect(normalizeRestreamEvent({ action: 'heartbeat' })).toBeUndefined();
    expect(
      normalizeRestreamEvent({ action: 'connection_info', payload: {} }),
    ).toBeUndefined();
  });

  it('returns undefined when text is missing, with a no-text drop reason', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 4,
        eventPayload: { author: { displayName: 'NoText' } },
      },
    };
    expect(normalizeRestreamEvent(raw)).toBeUndefined();
    const r = normalizeRestreamEventDetailed(raw);
    expect(r.message).toBeUndefined();
    expect(r.drop?.reason).toBe('no-text');
    expect(r.drop?.eventTypeId).toBe(4);
  });

  it('falls back to platform guess when eventTypeId is unknown', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 9999,
        eventPayload: {
          author: { displayName: 'Mystery' },
          text: 'visit kick.com/whatever',
        },
      },
    };
    const m = normalizeRestreamEvent(raw);
    expect(m?.platform).toBe('kick');
  });

  it('reports a not-event-action drop for heartbeat/connection_info', () => {
    expect(
      normalizeRestreamEventDetailed({ action: 'heartbeat' }).drop?.reason,
    ).toBe('not-event-action');
  });

  it('maps YouTube Super Chat (7), Super Sticker (8), Member Milestone (23), Membership (28), Gifting (29) all to youtube', () => {
    for (const eventTypeId of [7, 8, 23, 28, 29]) {
      const m = normalizeRestreamEvent({
        action: 'event',
        payload: {
          eventTypeId,
          eventPayload: { author: { displayName: 'YTUser' }, text: 'hi' },
        },
      });
      expect(m?.platform, `eventTypeId=${eventTypeId}`).toBe('youtube');
    }
  });

  it('maps Facebook sticker variants (12, 14) to facebook', () => {
    for (const eventTypeId of [12, 14]) {
      const m = normalizeRestreamEvent({
        action: 'event',
        payload: {
          eventTypeId,
          eventPayload: { author: { name: 'FBUser' }, text: 'sticker' },
        },
      });
      expect(m?.platform, `eventTypeId=${eventTypeId}`).toBe('facebook');
    }
  });

  it('extracts Discord nickname when author.displayName is absent', () => {
    const m = normalizeRestreamEvent({
      action: 'event',
      payload: {
        eventTypeId: 1,
        eventPayload: {
          author: { nickname: 'GuildMember', name: 'rawname#1234' },
          text: 'gg',
        },
      },
    });
    expect(m?.username).toBe('GuildMember');
  });

  // ---- reply_created (self-message) coverage — v0.1.10 fix ----
  //
  // Restream's WebSocket is read-only; the official Restream Chat webchat
  // sends replies via Restream's private API and the WS broadcasts them as
  // `reply_created`. v0.1.7 silently dropped these as 'not-event-action',
  // which is why Ethan's own messages appeared in the official Restream
  // Chat app but not in our feed.
  describe('reply_created → self ChatMessage', () => {
    it('surfaces a common reply (eventSourceId=1) as self with platform from connectionIdentifiers', () => {
      const raw = {
        action: 'reply_created',
        payload: {
          clientReplyUuid: 'cli-1',
          connectionIdentifiers: [
            '5849342-youtube-inCvU1sYMI0',
            '5849342-twitch-806202681',
          ],
          eventSourceId: 1,
          replyUuid: 'reply-1',
          showId: 'show-1',
          text: 'hi test',
          userId: 5849342,
        },
        timestamp: 1714000000,
      };
      const m = normalizeRestreamEvent(raw);
      expect(m).toBeDefined();
      expect(m!.text).toBe('hi test');
      expect(m!.username).toBe('You');
      expect(m!.self).toBe(true);
      expect(m!.id).toBe('reply-1');
      // First recognised platform wins for common replies.
      expect(m!.platform).toBe('youtube');
    });

    it('surfaces a direct Twitch reply (eventSourceId=2) as self/twitch', () => {
      const m = normalizeRestreamEvent({
        action: 'reply_created',
        payload: {
          clientReplyUuid: 'cli-2',
          connectionIdentifiers: ['5849342-twitch-806202681'],
          eventSourceId: 2,
          replyUuid: 'reply-2',
          text: 'pog',
        },
      });
      expect(m?.platform).toBe('twitch');
      expect(m?.self).toBe(true);
      expect(m?.username).toBe('You');
    });

    it('drops reply_created without text', () => {
      const r = normalizeRestreamEventDetailed({
        action: 'reply_created',
        payload: { eventSourceId: 1, connectionIdentifiers: [] },
      });
      expect(r.message).toBeUndefined();
      expect(r.drop?.reason).toBe('no-text');
    });

    it('falls back to unknown platform when eventSourceId=1 and connectionIdentifiers have no recognisable platform', () => {
      const m = normalizeRestreamEvent({
        action: 'reply_created',
        payload: {
          eventSourceId: 1,
          connectionIdentifiers: ['1234-discord-abcd', '1234-dlive-xyz'],
          replyUuid: 'reply-3',
          text: 'hi',
        },
      });
      expect(m?.platform).toBe('unknown');
      expect(m?.self).toBe(true);
    });
  });
});
