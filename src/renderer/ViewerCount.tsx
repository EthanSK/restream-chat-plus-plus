import React from 'react';
import type { ViewerStatsSnapshot } from '../shared/viewer-stats-core';

/**
 * v0.1.94 — LIVE VIEWER COUNT toolbar chip.
 *
 * Compact `👁 N` readout of total concurrent viewers across every currently
 * online channel — the same number the official Restream chat app shows.
 * Data flows main → renderer over IPC.VIEWER_STATS (see
 * src/shared/viewer-stats-core.ts for the source contract); this component
 * is a PURE view over the latest snapshot so it can be unit-tested without
 * IPC mocks (repo convention, mirrors ChannelsPanel).
 *
 * Render rules (deliberately quiet — this is an ambient indicator, never an
 * error surface):
 *   - snapshot missing (null) or nothing online   → render NOTHING. Not
 *     streaming is the normal state most of the day; an idle "—" would be
 *     permanent toolbar noise. (Task spec allows either; nothing wins.)
 *   - online but every platform hides its count   → `👁 —` (live, count
 *     unknown — e.g. X/Twitter reports viewers:null).
 *   - online with numeric counts                  → `👁 <sum>`.
 *
 * Tooltip (native `title=`) shows the per-channel breakdown, one line per
 * channel: "Twitch (reeethan_yt): 12". Native tooltip keeps this zero-state
 * and zero-dependency — no popover component for a hover nicety.
 */
export function ViewerCount({
  snapshot,
}: {
  snapshot: ViewerStatsSnapshot | null;
}): React.ReactElement | null {
  // Hidden entirely while not live — see render rules above.
  if (!snapshot || !snapshot.anyOnline) return null;

  const total = snapshot.totalViewers;

  // Per-channel breakdown for the hover tooltip. Offline channels are
  // omitted (they contribute nothing); null counts render as "—" so the
  // user can see WHICH platform is hiding its number.
  const breakdown = snapshot.channels
    .filter((c) => c.online)
    .map(
      (c) =>
        `${c.platformName}${c.channelIdentifier ? ` (${c.channelIdentifier})` : ''}: ${
          c.viewers ?? '—'
        }`,
    )
    .join('\n');

  return (
    <span
      className="viewer-count"
      title={breakdown ? `Live viewers\n${breakdown}` : 'Live viewers'}
      aria-label={`Live viewers: ${total ?? 'unknown'}`}
    >
      {/* Inline SVG eye (stroke style matches the toolbar Reconnect icon —
          we avoid an icon-font dependency and emoji-eye 👁 renders
          inconsistently across platforms/fonts). */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span className="viewer-count-num">
        {total === null ? '—' : total.toLocaleString()}
      </span>
    </span>
  );
}
