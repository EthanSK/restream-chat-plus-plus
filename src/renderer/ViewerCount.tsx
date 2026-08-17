import React, { useEffect, useState } from 'react';
import type {
  ViewerChannelStat,
  ViewerStatsSnapshot,
} from '../shared/viewer-stats-core';
import type { DirectChatConnection } from '../shared/types';

/**
 * v0.1.94 — LIVE VIEWER COUNT toolbar chip.
 * v0.1.95 — chip is now CLICKABLE and opens a per-platform breakdown
 * popover (Ethan follow-up: "the num viewers should be CLICKABLE and show
 * the breakdown per platform like Restream does it").
 *
 * Compact `👁 N` readout of total concurrent viewers across every currently
 * online Restream channel plus the independently connected Twitch and Kick
 * channels.
 * Restream data flows main → renderer over IPC.VIEWER_STATS, while Twitch and
 * Kick reuse the existing DirectChatConnection state; this component is a
 * PURE view over both latest snapshots so it can be unit-tested without IPC
 * mocks (repo convention, mirrors ChannelsPanel).
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
  directConnections = [],
}: {
  snapshot: ViewerStatsSnapshot | null;
  directConnections?: DirectChatConnection[];
}): React.ReactElement | null {
  // ALL hooks live above the early return (Rules of Hooks — the count of
  // hooks must be identical across renders even as `live` flips; same
  // discipline chat-input-hook-order.test.ts pins for ChatInputInline).
  const [open, setOpen] = useState(false);

  const liveDirectConnections = directConnections.filter(isDirectConnectionLive);
  const live = Boolean(snapshot?.anyOnline) || liveDirectConnections.length > 0;
  const knownTotals = [
    ...(snapshot?.anyOnline && snapshot.totalViewers !== null
      ? [snapshot.totalViewers]
      : []),
    ...liveDirectConnections.flatMap((connection) =>
      connection.viewerCount === undefined ? [] : [connection.viewerCount],
    ),
  ];
  const total =
    knownTotals.length > 0
      ? knownTotals.reduce((sum, viewers) => sum + viewers, 0)
      : null;

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
  if (!live) return null;

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
        <ViewerPopover
          snapshot={snapshot}
          directConnections={directConnections}
          total={total}
          onClose={() => setOpen(false)}
        />
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
  directConnections,
  total,
  onClose,
}: {
  snapshot: ViewerStatsSnapshot | null;
  directConnections: DirectChatConnection[];
  total: number | null;
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
              {total === null ? '—' : total.toLocaleString()}
            </span>
          </div>
          {snapshot && snapshot.channels.length > 0 ? (
            <ViewerSection label="Restream">
              {snapshot.channels.map((stat) => (
                <ViewerRow
                  key={`restream-${stat.channelId}`}
                  platformName={stat.platformName}
                  channelIdentifier={stat.channelIdentifier}
                  online={stat.online}
                  viewers={stat.viewers}
                />
              ))}
            </ViewerSection>
          ) : null}
          {directConnections.length > 0 ? (
            <ViewerSection label="Direct">
              {directConnections.map((connection) => (
                <ViewerRow
                  key={`direct-${connection.provider}`}
                  platformName={providerLabel(connection.provider)}
                  channelIdentifier={connection.accountName ?? ''}
                  online={isDirectConnectionLive(connection)}
                  viewers={connection.viewerCount ?? null}
                />
              ))}
            </ViewerSection>
          ) : null}
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
function ViewerSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="viewer-section" aria-label={`${label} viewers`}>
      <div className="viewer-section-label">{label}</div>
      <ul className="viewer-list">{children}</ul>
    </section>
  );
}

function ViewerRow({
  platformName,
  channelIdentifier,
  online,
  viewers,
}: Pick<
  ViewerChannelStat,
  'platformName' | 'channelIdentifier' | 'online' | 'viewers'
>): React.ReactElement {
  return (
    <li className={`viewer-row${online ? '' : ' is-offline'}`}>
      <div className="viewer-row-meta">
        <span className="viewer-row-platform">{platformName}</span>
        {channelIdentifier ? (
          <span className="viewer-row-channel">{channelIdentifier}</span>
        ) : null}
      </div>
      <span className={`viewer-row-pill ${online ? 'online' : 'offline'}`}>
        {online ? 'live' : 'offline'}
      </span>
      <span className="viewer-row-num">
        {/* "—" = platform hides concurrent viewers (viewers:null on the
            wire, e.g. X/Twitter) OR the channel is offline. */}
        {online && viewers !== null ? viewers.toLocaleString() : '—'}
      </span>
    </li>
  );
}

function isDirectConnectionLive(connection: DirectChatConnection): boolean {
  return connection.status === 'connected' && connection.isLive === true;
}

function providerLabel(provider: DirectChatConnection['provider']): string {
  switch (provider) {
    case 'twitch':
      return 'Twitch';
    case 'kick':
      return 'Kick';
  }
}
