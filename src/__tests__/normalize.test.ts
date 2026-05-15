import { describe, it, expect } from 'vitest';
import { normalizeRestreamEvent } from '../main/normalize';

describe('normalizeRestreamEvent', () => {
  it('parses Twitch-shaped event payload', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 24,
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

  it('parses YouTube-shaped event payload', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 4,
        eventPayload: {
          id: 'yt-1',
          author: { name: 'YTViewer' },
          message: 'gg streamer',
          createdAt: 1714000000000,
        },
      },
    };
    const m = normalizeRestreamEvent(raw);
    expect(m?.platform).toBe('youtube');
    expect(m?.username).toBe('YTViewer');
    expect(m?.text).toBe('gg streamer');
  });

  it('returns undefined for non-event actions', () => {
    expect(normalizeRestreamEvent({ action: 'heartbeat' })).toBeUndefined();
  });

  it('returns undefined when text is missing', () => {
    const raw = {
      action: 'event',
      payload: {
        eventTypeId: 24,
        eventPayload: { author: { displayName: 'NoText' } },
      },
    };
    expect(normalizeRestreamEvent(raw)).toBeUndefined();
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
});
