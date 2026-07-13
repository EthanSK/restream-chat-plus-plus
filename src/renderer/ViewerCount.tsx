import React, { useEffect, useState } from 'react';
import type {
  ViewerChannelStat,
  ViewerStatsSnapshot,
} from '../shared/viewer-stats-core';

/**
 * v0.1.94 — LIVE VIEWER COUNT toolbar chip.
 * v0.1.95 — chip is now CLICKABLE and opens a per-platform breakdown
 * popover (Ethan follow-up: "the num viewers should be CLICKABLE and show
 * the breakdown per platform like Restream does it").
 *
 * Compact `👁 N` readout of total concurrent viewers across every currently
 * online channel — the same number the official Restream chat app shows.
 * Data flows main → renderer over IPC.VIEWER_STATS (see
 * src/shared/viewer-stats-core.ts for the source contract); this component
 * is a PURE view over the latest snapshot so it can be unit-tested without
 * IPC mocks (repo convention, mirrors ChannelsPanel).
 *
 * Chip render rules (deliberately quiet — this is an ambient indicator,
 * never an error surface):
 *   - snapshot missing (null) or nothing online   → render NOTHING. Not
 *     streaming is the normal state most of the day; an idle "—" would be
 *     permanent toolbar noise. (Task spec allows either; nothing wins.)
 *   - online but every platform hides its count   → `👁 —` (live, count
 *     unknown — e.g. X/Twitter reports viewers:null).
 *   - online with numeric counts                  → `👁 <sum>`.
 *
 * Popover (v0.1.95): clicking the chip toggles an anchored breakdown panel
 * listing EVERY tracked channel — platform name + channel identifier +
 * live viewer count ("—" where the platform hides it) + an online/offline
 * pill — with the summed total pinned at the top. Structure/classes mirror
 * ChannelsPanel's trigger+scrim+popover pattern (channels-scrim is reused
 * verbatim; .viewer-popover mirrors .channels-popover) so the two toolbar
 * dropdowns look and behave identically. Close paths: click the chip again,
 * click the scrim (outside), press Escape, or the × button. The old
 * hover-tooltip breakdown was DROPPED in favour of the popover — two
 * competing surfaces for the same data would fight (tooltip covering the
 * popover) and the official app has no tooltip either; the chip's `title`
 * is now just a click affordance hint.
 */
export function ViewerCount({
  snapshot,
}: {
  snapshot: ViewerStatsSnapshot | null;
}): React.ReactElement | null {
  // ALL hooks live above the early return (Rules of Hooks — the count of
  // hooks must be identical across renders even as `live` flips; same
  // discipline chat-input-hook-order.test.ts pins for ChatInputInline).
  const [open, setOpen] = useState(false);

  const live = Boolean(snapshot?.anyOnline);

  // Force-close the popover whenever the stream stops being live. Without
  // this, `open` would survive the chip disappearing (component stays
  // mounted in the toolbar tree, it just renders null) and the popover
  // would surprise-reopen the next time a stream starts.
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  // Escape-to-close, armed only while the popover is open. Guarded on
  // `typeof document` so the component stays inert under the node vitest
  // environment (no DOM globals there — same guard pattern as
  // ChatInputInline's window listeners).
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Hidden entirely while not live — see chip render rules above.
  if (!snapshot || !live) return null;

  const total = snapshot.totalViewers;

  return (
    <div className="viewer-count-panel">
      <button
        type="button"
        className={`btn ghost viewer-count${open ? ' is-open' : ''}`}
        title="Live viewers — click for per-platform breakdown"
        aria-label={`Live viewers: ${total ?? 'unknown'}. Show per-platform breakdown`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
      </button>
      {open && (
        <ViewerPopover snapshot={snapshot} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/**
 * Anchored breakdown panel. Pure presentational — receives the already-
 * aggregated snapshot, renders total + one row per channel. Mirrors
 * ChannelsPopover's scrim+dialog structure so click-outside works the same
 * way (the fixed full-viewport scrim under the popover catches the click).
 */
function ViewerPopover({
  snapshot,
  onClose,
}: {
  snapshot: ViewerStatsSnapshot;
  onClose: () => void;
}): React.ReactElement {
  return (
    <>
      {/* Reuses .channels-scrim verbatim: generic fixed inset-0 overlay. */}
      <div className="channels-scrim" onClick={onClose} />
      <div className="viewer-popover" role="dialog" aria-label="Live viewers">
        <div className="viewer-popover-head">
          <h3>Live viewers</h3>
          <button
            type="button"
            className="btn icon ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="viewer-popover-body">
          {/* Total pinned at the top — the headline number, matching the
              chip. "—" when live but every platform hides its count. */}
          <div className="viewer-total-row">
            <span className="viewer-total-label">Total</span>
            <span className="viewer-total-num">
              {snapshot.totalViewers === null
                ? '—'
                : snapshot.totalViewers.toLocaleString()}
            </span>
          </div>
          <ul className="viewer-list">
            {snapshot.channels.map((c) => (
              <ViewerRow key={c.channelId} stat={c} />
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

/**
 * One per-channel row: platform name, channel identifier, online/offline
 * pill, viewer count. Offline channels ARE listed (greyed, no count
 * contribution) so the user can see which platform just dropped — same
 * philosophy as ChannelsPanel listing erroring connections.
 */
function ViewerRow({ stat }: { stat: ViewerChannelStat }): React.ReactElement {
  return (
    <li className={`viewer-row${stat.online ? '' : ' is-offline'}`}>
      <div className="viewer-row-meta">
        <span className="viewer-row-platform">{stat.platformName}</span>
        {stat.channelIdentifier ? (
          <span className="viewer-row-channel">{stat.channelIdentifier}</span>
        ) : null}
      </div>
      <span
        className={`viewer-row-pill ${stat.online ? 'online' : 'offline'}`}
      >
        {stat.online ? 'live' : 'offline'}
      </span>
      <span className="viewer-row-num">
        {/* "—" = platform hides concurrent viewers (viewers:null on the
            wire, e.g. X/Twitter) OR the channel is offline. */}
        {stat.online && stat.viewers !== null
          ? stat.viewers.toLocaleString()
          : '—'}
      </span>
    </li>
  );
}
