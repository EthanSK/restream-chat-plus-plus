import { describe, it, expect } from 'vitest';
import { __test_helpers } from '../main/ws-client';
import type { ChatConnection } from '../shared/types';

const { platformFromEventSourceId, extractChannelName, sortConnections } =
  __test_helpers;

describe('platformFromEventSourceId', () => {
  it('maps documented event source ids', () => {
    expect(platformFromEventSourceId(2, '1-twitch-x')).toBe('twitch');
    expect(platformFromEventSourceId(13, '1-youtube-x')).toBe('youtube');
    expect(platformFromEventSourceId(20, '1-facebook-x')).toBe('facebook');
    expect(platformFromEventSourceId(26, '1-kick-x')).toBe('kick');
    expect(platformFromEventSourceId(27, '1-trovo-x')).toBe('trovo');
    expect(platformFromEventSourceId(28, '1-twitter-x')).toBe('x');
    expect(platformFromEventSourceId(29, '1-rumble-x')).toBe('rumble');
  });

  it('falls back to slug from connectionIdentifier when eventSourceId is unknown', () => {
    expect(platformFromEventSourceId(999, '1-kick-x')).toBe('kick');
    expect(platformFromEventSourceId(undefined, '1-twitter-x')).toBe('x');
    expect(platformFromEventSourceId(0, '1-tiktok-abc')).toBe('tiktok');
  });

  it('returns unknown when both id and slug are unrecognised', () => {
    expect(platformFromEventSourceId(999, '1-discord-foo')).toBe('unknown');
    expect(platformFromEventSourceId(999, 'malformed-id')).toBe('unknown');
  });
});

describe('extractChannelName', () => {
  it('pulls displayName for Twitch-style targets', () => {
    expect(
      extractChannelName({
        owner: { displayName: '3000AD_Music', id: '1', name: '3000ad_music' },
        websiteChannelId: 1,
      }),
    ).toBe('3000AD_Music');
  });

  it('pulls page.name for Facebook Page targets', () => {
    expect(
      extractChannelName({
        liveVideo: { id: '' },
        page: { id: '111', name: '3000ad' },
      }),
    ).toBe('3000ad');
  });

  it('pulls channel.name for Discord targets', () => {
    expect(
      extractChannelName({
        channel: { id: '1', name: '💬-stream-chat', url: 'https://discord' },
        owner: { name: 'reeethan_', avatar: 'x', id: '2' },
      }),
    ).toBe('💬-stream-chat');
  });

  it('returns undefined for empty / non-object targets', () => {
    expect(extractChannelName(undefined)).toBeUndefined();
    expect(extractChannelName(null)).toBeUndefined();
    expect(extractChannelName({})).toBeUndefined();
  });
});

describe('sortConnections', () => {
  const mk = (platform: ChatConnection['platform'], name: string): ChatConnection => ({
    connectionIdentifier: `${name}-id`,
    connectionUuid: `${name}-uuid`,
    eventSourceId: 0,
    platform,
    status: 'connected',
    reason: null,
    channelName: name,
    updatedAt: 0,
  });

  it('sorts by platform order then by name', () => {
    const sorted = sortConnections([
      mk('rumble', 'r1'),
      mk('twitch', 't2'),
      mk('youtube', 'y1'),
      mk('twitch', 't1'),
      mk('unknown', 'u1'),
    ]);
    expect(sorted.map((c) => c.channelName)).toEqual([
      't1',
      't2',
      'y1',
      'r1',
      'u1',
    ]);
  });
});
