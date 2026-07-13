/**
 * v0.1.94 — LIVE VIEWER COUNT, pure aggregation core.
 *
 * ============================================================================
 * DATA-SOURCE CONTRACT (discovered 2026-07-13, see LEARNINGS.md entry)
 * ============================================================================
 *
 * The chat WebSocket (`wss://chat.api.restream.io/ws`) does NOT carry viewer
 * counts — a full grep of raw-frames.jsonl showed only heartbeat /
 * connection_info / connection_closed / event / reply_* / relay_* actions.
 *
 * Viewer counts come from Restream's SEPARATE "Streaming Updates" WebSocket
 * (official docs: https://developers.restream.io/private-api/streaming-updates):
 *
 *     wss://streaming.api.restream.io/ws?accessToken=<same OAuth bearer
 *     token the chat WS uses; requires the `stream.read` scope which this
 *     app already requests — see SCOPES in src/main/oauth.ts>
 *
 * Server behaviour (per docs): upon connection you receive ALL updates from
 * roughly the last minute (enough to reconstruct current state), then new
 * updates as they happen. Each WS text frame is ONE JSON object of the
 * `IUpdates` union. The member we care about is `updateStatuses` — "stream
 * information from the point of view of the end platform":
 *
 *     {
 *       action: 'updateStatuses';
 *       userId: number;
 *       eventId: string | null;
 *       platformId: number;        // Restream platform id (1=Twitch, 5=YouTube…)
 *       channelId: number;         // Restream channel id (stable per channel)
 *       createdAt: number;         // outgoing stream start, unix SECONDS
 *       updatedAt: number;         // when info was collected, unix SECONDS
 *                                  // (docs warn: can be cached/outdated for
 *                                  //  long sessions)
 *       channelIdentifier: string; // e.g. twitch login name
 *       eventIdentifier: string;
 *       channelViews: number | null;
 *       followers: number | null;
 *       gameTitle: string | null;
 *       online: boolean;           // is the END PLATFORM showing us live
 *       streamViews: number | null;
 *       title: string | null;
 *       viewers: number | null;    // CURRENT CONCURRENT VIEWERS (null =
 *                                  //  platform doesn't expose it, e.g. X/Twitter
 *                                  //  frequently reports null)
 *     }
 *
 * Other union members (updateIncoming / deleteIncoming / updateOutgoing /
 * deleteOutgoing) describe ingest + RTMP delivery, not audience size. We use
 * `deleteOutgoing` (platformId+channelId, fired when Restream stops pushing
 * to that platform) as an early "this channel just went offline" signal so
 * the count drops promptly at stream end instead of waiting for the TTL.
 *
 * The official Restream chat app's viewer counter is this same feed: it shows
 * the SUM of `viewers` across currently-online channels. We reproduce that.
 *
 * ============================================================================
 * WHY THIS FILE IS PURE
 * ============================================================================
 * Mirrors the repo convention (side-effect-decision.ts, message-filters.ts):
 * all decision logic lives in `src/shared/` as pure functions over plain
 * data so vitest can exercise every edge without mocking `ws` or Electron.
 * The thin socket shell lives in `src/main/viewer-stats.ts`.
 */

/** One channel's latest known end-platform status (our normalised shape). */
export interface ViewerChannelStat {
  channelId: number;
  platformId: number;
  /** Human platform name resolved from PLATFORM_ID_NAMES (fallback: 'Platform <id>'). */
  platformName: string;
  channelIdentifier: string;
  online: boolean;
  /** Current concurrent viewers as reported by the end platform; null = not exposed. */
  viewers: number | null;
  /** Unix ms when WE last ingested an update for this channel (drives the TTL). */
  seenAtMs: number;
  /** Unix seconds `updatedAt` from Restream (when THEY collected the data). */
  updatedAt: number;
  title: string | null;
}

/**
 * Aggregated snapshot pushed to the renderer over IPC.VIEWER_STATS.
 *
 * `totalViewers` semantics (matches the official app's behaviour):
 *   - number  → at least one ONLINE channel reported a numeric count; value is
 *               the sum over online channels (null-reporting channels count 0).
 *   - null    → nothing live right now, or every live platform hides its count.
 *               Renderer shows a quiet placeholder, never an error.
 */
export interface ViewerStatsSnapshot {
  totalViewers: number | null;
  /** True when any tracked channel is currently online (even if count hidden). */
  anyOnline: boolean;
  /** Per-channel breakdown for the tooltip, sorted by viewers desc then name. */
  channels: ViewerChannelStat[];
  /** Unix ms this snapshot was computed. */
  computedAtMs: number;
}

/**
 * How long a channel entry survives without a fresh `updateStatuses` before
 * the aggregator drops it. Restream refreshes statuses roughly every ~30-60s
 * per channel while live; when the stream ends the updates simply STOP
 * (there's no guaranteed final online:false frame), so without a TTL a stale
 * "online, 42 viewers" entry would linger forever. 5 minutes is generous
 * enough to ride out slow platform polling + brief WS reconnects without
 * flapping, but short enough that a dead stream's count disappears promptly.
 */
export const VIEWER_STAT_TTL_MS = 5 * 60 * 1000;

/**
 * Restream platformId → display name, for the per-platform tooltip breakdown.
 *
 * Snapshot of GET https://api.restream.io/v2/platform/all (public, unauthed)
 * taken 2026-07-13. Static on purpose: the id-space is append-only and the
 * handful Ethan streams to (Twitch/YouTube/Facebook/X/Kick) are ancient ids.
 * Unknown ids fall back to `Platform <id>` + the channelIdentifier still
 * shows, so a brand-new platform degrades gracefully rather than erroring.
 */
export const PLATFORM_ID_NAMES: Record<number, string> = {
  1: 'Twitch',
  5: 'YouTube',
  25: 'YouTube',
  29: 'Custom RTMP',
  37: 'Facebook',
  57: 'DLive',
  59: 'LinkedIn',
  66: 'Dailymotion',
  67: 'TikTok',
  69: 'Trovo',
  71: 'X (Twitter)',
  72: 'Telegram',
  73: 'Instagram',
  75: 'Kick',
  77: 'Rumble',
  78: 'Custom SRT',
  81: 'Custom WHIP',
  83: 'Embed Player',
};

export function platformNameForId(platformId: number): string {
  return PLATFORM_ID_NAMES[platformId] ?? `Platform ${platformId}`;
}

/**
 * The subset of the streaming-updates union we act on. Everything else is
 * ignored (see applyStreamingUpdate). Fields are typed loosely (unknown-ish)
 * because this arrives off the wire — apply* narrows defensively.
 */
interface StreamingUpdateFrame {
  action?: unknown;
  platformId?: unknown;
  channelId?: unknown;
  channelIdentifier?: unknown;
  online?: unknown;
  viewers?: unknown;
  updatedAt?: unknown;
  title?: unknown;
}

/** Map keyed by channelId — the client's single piece of mutable state. */
export type ViewerStatsMap = Map<number, ViewerChannelStat>;

/**
 * Fold ONE parsed streaming-updates frame into the per-channel map.
 * Returns true when the map changed (caller uses this to decide whether to
 * recompute + broadcast a snapshot — avoids waking the renderer for the
 * ingest-metrics frames we don't care about).
 *
 * Defensive by design: any frame missing the fields we need is ignored
 * silently. This socket is an ENHANCEMENT — it must never throw into the
 * main process or spam error logs when Restream evolves the schema.
 */
export function applyStreamingUpdate(
  map: ViewerStatsMap,
  frame: unknown,
  nowMs: number,
): boolean {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as StreamingUpdateFrame;

  // Channel went dark at the Restream delivery layer — drop it immediately
  // so the toolbar count falls the moment the stream stops, instead of
  // holding the last viewer number for up to VIEWER_STAT_TTL_MS.
  if (f.action === 'deleteOutgoing' && typeof f.channelId === 'number') {
    return map.delete(f.channelId);
  }

  if (f.action !== 'updateStatuses') return false;
  if (typeof f.channelId !== 'number' || typeof f.platformId !== 'number') {
    return false;
  }

  const stat: ViewerChannelStat = {
    channelId: f.channelId,
    platformId: f.platformId,
    platformName: platformNameForId(f.platformId),
    channelIdentifier:
      typeof f.channelIdentifier === 'string' ? f.channelIdentifier : '',
    online: f.online === true,
    viewers: typeof f.viewers === 'number' ? f.viewers : null,
    seenAtMs: nowMs,
    updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : 0,
    title: typeof f.title === 'string' ? f.title : null,
  };
  map.set(stat.channelId, stat);
  return true;
}

/**
 * Evict entries that haven't been refreshed within VIEWER_STAT_TTL_MS.
 * Returns true when anything was dropped. Called opportunistically before
 * every snapshot compute AND on the client's periodic sweep timer (so a
 * count doesn't freeze on screen when updates stop arriving entirely).
 */
export function sweepStaleViewerStats(
  map: ViewerStatsMap,
  nowMs: number,
  ttlMs: number = VIEWER_STAT_TTL_MS,
): boolean {
  let changed = false;
  for (const [id, stat] of map) {
    if (nowMs - stat.seenAtMs > ttlMs) {
      map.delete(id);
      changed = true;
    }
  }
  return changed;
}

/**
 * Compute the aggregated snapshot from the per-channel map.
 *
 * Sum rule: only ONLINE channels contribute; a null `viewers` on an online
 * channel contributes 0 but still counts as "live" (anyOnline true) — e.g.
 * X/Twitter often reports online with viewers:null. If NO online channel
 * reports a numeric count, totalViewers is null so the UI can show a quiet
 * placeholder rather than a misleading hard 0.
 */
export function aggregateViewerStats(
  map: ViewerStatsMap,
  nowMs: number,
): ViewerStatsSnapshot {
  const channels = [...map.values()].sort(
    (a, b) =>
      (b.viewers ?? -1) - (a.viewers ?? -1) ||
      a.platformName.localeCompare(b.platformName),
  );
  let anyOnline = false;
  let sawNumeric = false;
  let total = 0;
  for (const c of channels) {
    if (!c.online) continue;
    anyOnline = true;
    if (typeof c.viewers === 'number') {
      sawNumeric = true;
      total += c.viewers;
    }
  }
  return {
    totalViewers: sawNumeric ? total : null,
    anyOnline,
    channels,
    computedAtMs: nowMs,
  };
}
