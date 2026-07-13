import { describe, it, expect } from 'vitest';
import {
  applyStreamingUpdate,
  aggregateViewerStats,
  sweepStaleViewerStats,
  platformNameForId,
  VIEWER_STAT_TTL_MS,
  type ViewerStatsMap,
} from '../shared/viewer-stats-core';
import { ViewerStatsClient } from '../main/viewer-stats';

/**
 * v0.1.94 — LIVE VIEWER COUNT, pure-core coverage.
 *
 * The wire contract these fixtures encode is Restream's "Streaming Updates"
 * WebSocket `updateStatuses` / `deleteOutgoing` frames — verbatim shape
 * documented at the top of src/shared/viewer-stats-core.ts (fetched from
 * https://developers.restream.io/private-api/streaming-updates 2026-07-13).
 * If Restream evolves the schema, update BOTH the core module and these
 * fixtures together.
 */

/** Minimal realistic `updateStatuses` frame builder (wire shape). */
function statusFrame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'updateStatuses',
    userId: 5849342,
    eventId: null,
    platformId: 1, // Twitch
    channelId: 11358207,
    createdAt: 1_783_947_000,
    updatedAt: 1_783_947_600,
    channelIdentifier: 'reeethan_yt',
    eventIdentifier: 'evt-1',
    channelViews: 100,
    followers: 42,
    gameTitle: null,
    online: true,
    streamViews: 10,
    title: 'vibe coding',
    viewers: 7,
    ...over,
  };
}

const NOW = 1_783_947_650_000; // arbitrary fixed unix-ms "now"

describe('applyStreamingUpdate', () => {
  it('folds an updateStatuses frame into the map and reports change', () => {
    const map: ViewerStatsMap = new Map();
    const changed = applyStreamingUpdate(map, statusFrame(), NOW);
    expect(changed).toBe(true);
    const stat = map.get(11358207)!;
    expect(stat.platformName).toBe('Twitch');
    expect(stat.viewers).toBe(7);
    expect(stat.online).toBe(true);
    expect(stat.seenAtMs).toBe(NOW);
  });

  it('replaces the prior entry for the same channelId (no double count)', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(map, statusFrame({ viewers: 7 }), NOW);
    applyStreamingUpdate(map, statusFrame({ viewers: 9 }), NOW + 1000);
    expect(map.size).toBe(1);
    expect(aggregateViewerStats(map, NOW + 1000).totalViewers).toBe(9);
  });

  it('normalises a null viewers count (platform hides it, e.g. X/Twitter)', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(
      map,
      statusFrame({ platformId: 71, channelId: 2, viewers: null }),
      NOW,
    );
    expect(map.get(2)!.viewers).toBeNull();
    expect(map.get(2)!.platformName).toBe('X (Twitter)');
  });

  it('deleteOutgoing drops the channel immediately (early offline signal)', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(map, statusFrame(), NOW);
    const changed = applyStreamingUpdate(
      map,
      { action: 'deleteOutgoing', platformId: 1, channelId: 11358207 },
      NOW,
    );
    expect(changed).toBe(true);
    expect(map.size).toBe(0);
  });

  it('deleteOutgoing for an unknown channel is a quiet no-op', () => {
    const map: ViewerStatsMap = new Map();
    expect(
      applyStreamingUpdate(
        map,
        { action: 'deleteOutgoing', platformId: 1, channelId: 999 },
        NOW,
      ),
    ).toBe(false);
  });

  it('ignores irrelevant/malformed frames without changing the map', () => {
    const map: ViewerStatsMap = new Map();
    // Other union members + garbage — none may throw or mutate.
    expect(applyStreamingUpdate(map, { action: 'updateIncoming' }, NOW)).toBe(false);
    expect(applyStreamingUpdate(map, { action: 'updateOutgoing' }, NOW)).toBe(false);
    expect(applyStreamingUpdate(map, null, NOW)).toBe(false);
    expect(applyStreamingUpdate(map, 'heartbeat', NOW)).toBe(false);
    expect(applyStreamingUpdate(map, 42, NOW)).toBe(false);
    // updateStatuses missing the numeric ids we key on.
    expect(
      applyStreamingUpdate(map, { action: 'updateStatuses', channelId: 'x' }, NOW),
    ).toBe(false);
    expect(map.size).toBe(0);
  });

  it('defends against non-string identifier/title fields', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(
      map,
      statusFrame({ channelIdentifier: 123, title: { evil: true }, viewers: '9' }),
      NOW,
    );
    const stat = map.get(11358207)!;
    expect(stat.channelIdentifier).toBe('');
    expect(stat.title).toBeNull();
    // Non-numeric viewers coerced to null, NOT NaN.
    expect(stat.viewers).toBeNull();
  });
});

describe('aggregateViewerStats', () => {
  it('sums viewers across ONLINE channels only', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(map, statusFrame({ channelId: 1, platformId: 1, viewers: 7 }), NOW);
    applyStreamingUpdate(map, statusFrame({ channelId: 2, platformId: 5, viewers: 3 }), NOW);
    // Offline channel with a stale count must NOT contribute.
    applyStreamingUpdate(
      map,
      statusFrame({ channelId: 3, platformId: 37, viewers: 50, online: false }),
      NOW,
    );
    const snap = aggregateViewerStats(map, NOW);
    expect(snap.totalViewers).toBe(10);
    expect(snap.anyOnline).toBe(true);
    expect(snap.channels).toHaveLength(3); // breakdown still lists offline
  });

  it('is null-total (but anyOnline) when every live platform hides its count', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(
      map,
      statusFrame({ channelId: 2, platformId: 71, viewers: null }),
      NOW,
    );
    const snap = aggregateViewerStats(map, NOW);
    expect(snap.totalViewers).toBeNull();
    expect(snap.anyOnline).toBe(true);
  });

  it('null-count online channels contribute 0 alongside numeric ones', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(map, statusFrame({ channelId: 1, viewers: 12 }), NOW);
    applyStreamingUpdate(
      map,
      statusFrame({ channelId: 2, platformId: 71, viewers: null }),
      NOW,
    );
    expect(aggregateViewerStats(map, NOW).totalViewers).toBe(12);
  });

  it('empty map → idle snapshot (nothing live, null total)', () => {
    const snap = aggregateViewerStats(new Map(), NOW);
    expect(snap.totalViewers).toBeNull();
    expect(snap.anyOnline).toBe(false);
    expect(snap.channels).toEqual([]);
  });

  it('sorts the breakdown by viewers desc (tooltip shows biggest first)', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(map, statusFrame({ channelId: 1, platformId: 1, viewers: 2 }), NOW);
    applyStreamingUpdate(map, statusFrame({ channelId: 2, platformId: 5, viewers: 9 }), NOW);
    applyStreamingUpdate(map, statusFrame({ channelId: 3, platformId: 71, viewers: null }), NOW);
    const snap = aggregateViewerStats(map, NOW);
    expect(snap.channels.map((c) => c.channelId)).toEqual([2, 1, 3]);
  });
});

describe('sweepStaleViewerStats', () => {
  it('evicts entries not refreshed within the TTL, keeps fresh ones', () => {
    const map: ViewerStatsMap = new Map();
    applyStreamingUpdate(map, statusFrame({ channelId: 1 }), NOW);
    applyStreamingUpdate(map, statusFrame({ channelId: 2 }), NOW + VIEWER_STAT_TTL_MS);
    const later = NOW + VIEWER_STAT_TTL_MS + 1;
    expect(sweepStaleViewerStats(map, later)).toBe(true);
    expect([...map.keys()]).toEqual([2]);
    // Second sweep at the same time: nothing left to evict.
    expect(sweepStaleViewerStats(map, later)).toBe(false);
  });
});

describe('platformNameForId', () => {
  it('maps the common platforms and degrades gracefully for unknown ids', () => {
    expect(platformNameForId(1)).toBe('Twitch');
    expect(platformNameForId(5)).toBe('YouTube');
    expect(platformNameForId(75)).toBe('Kick');
    expect(platformNameForId(9999)).toBe('Platform 9999');
  });
});

describe('ViewerStatsClient lifecycle (no socket)', () => {
  it('start() without a token is a quiet no-op; stop() is idempotent', () => {
    const client = new ViewerStatsClient();
    // No token yet → connect must bail without throwing or opening a socket.
    expect(() => client.start()).not.toThrow();
    expect(client.getSnapshot().anyOnline).toBe(false);
    expect(client.getSnapshot().totalViewers).toBeNull();
    expect(() => client.stop()).not.toThrow();
    expect(() => client.stop()).not.toThrow();
  });

  it('setToken alone does not connect (main drives start/reconnect)', () => {
    const client = new ViewerStatsClient();
    expect(() => client.setToken('test-token')).not.toThrow();
    // Still the idle snapshot — nothing connected, nothing emitted.
    expect(client.getSnapshot().channels).toEqual([]);
    client.stop();
  });
});
