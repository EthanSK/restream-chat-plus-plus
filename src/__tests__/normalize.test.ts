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
});
