import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChatConnection,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
} from '../shared/types';
import {
  reconcileStableConnections,
  type PendingDipsMap,
} from './connections-stable';

interface Props {
  connections: ChatConnection[];
}

/**
 * v0.1.46 — when Restream's WS replays its current connections at
 * boot, each per-platform connection often cycles
 * `connected → connecting → connected` (sometimes twice) within ~1s as
 * the server re-subscribes. The renderer used to paint every
 * transition, so the channels-panel pills and the `N/M connected`
 * counter visibly flickered for ~10s after launch. We coalesce dips
 * shorter than `TRANSIENT_CONNECTING_HOLD_MS` (see
 * `connections-stable.ts` for the full algorithm and the captured
 * raw-frame trace).
 *
 * This hook is the renderer-side glue around the pure reducer in
 * `connections-stable.ts`: it persists the pending-dip map across
 * renders via a ref, re-runs the reducer on every `connections` push
 * AND on a single deferred timer when there are pending dips
 * (so an unrecovered dip flushes itself after the hold window even if
 * no new push arrives).
 */
function useStableConnections(upstream: ChatConnection[]): ChatConnection[] {
  const [stable, setStable] = useState<ChatConnection[]>(upstream);
  const pendingRef = useRef<PendingDipsMap>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // We keep a ref to the latest upstream so the deferred-flush timer
  // sees the freshest input, not the snapshot from when it was armed.
  const upstreamRef = useRef<ChatConnection[]>(upstream);

  useEffect(() => {
    upstreamRef.current = upstream;
    const result = reconcileStableConnections(
      upstream,
      stable,
      pendingRef.current,
      Date.now(),
    );
    pendingRef.current = result.pendingDips;
    setStable(result.view);

    // Cancel any prior timer; schedule the next deferred flush if needed.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (result.wakeAtMs !== null) {
      const delay = Math.max(0, result.wakeAtMs - Date.now()) + 1;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const r = reconcileStableConnections(
          upstreamRef.current,
          stable,
          pendingRef.current,
          Date.now(),
        );
        pendingRef.current = r.pendingDips;
        setStable(r.view);
        if (r.wakeAtMs !== null) {
          // Schedule the next flush if another dip is still in-flight.
          const next = Math.max(0, r.wakeAtMs - Date.now()) + 1;
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            const rr = reconcileStableConnections(
              upstreamRef.current,
              stable,
              pendingRef.current,
              Date.now(),
            );
            pendingRef.current = rr.pendingDips;
            setStable(rr.view);
          }, next);
        }
      }, delay);
    }
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // We INTENTIONALLY don't depend on `stable` here — including it
    // would re-run this effect after every state update we make and
    // never settle. The reducer's `prev` argument is read from the
    // CURRENT React state at the time the new upstream arrives, which
    // is exactly the "last painted view" semantics we want.
  }, [upstream]);

  return stable;
}

/**
 * Channels panel: surfaces Restream's WebSocket `connection_info` entries
 * in the toolbar so Ethan can see at a glance which platforms are
 * actually connected vs erroring out (= "I sent a YouTube message but
 * the feed is empty because YouTube broadcast hasn't started yet" type
 * silent failure mode that v0.1.7 had no UI affordance for).
 *
 * Collapsed state shows a chip with `N connected • M total` and the
 * platform colour-dots; clicking expands into a popover listing each
 * channel + status + (when present) public URL.
 *
 * Viewer counts are intentionally NOT shown — Restream's Chat API does
 * not expose viewer counts in the WS stream (only event sources like
 * Twitch IRC + YouTube live-chat which we don't talk to directly). The
 * platform-specific public APIs do have them but plumbing five different
 * polling clients into Electron is overkill for v0.1.10. If Ethan asks
 * later we can add a dedicated viewer-count poller layer.
 */
export function ChannelsPanel({ connections }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const stableConnections = useStableConnections(connections);

  const { connectedCount, total } = useMemo(() => {
    const connected = stableConnections.filter((c) => c.status === 'connected').length;
    return { connectedCount: connected, total: stableConnections.length };
  }, [stableConnections]);

  if (total === 0) return null;

  const platformDots = uniqueConnectedPlatforms(stableConnections);

  return (
    <div className="channels-panel">
      <button
        type="button"
        className={`btn ghost channels-trigger${open ? ' is-open' : ''}`}
        title="Connected channels"
        aria-label="Connected channels"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="channels-count">
          {connectedCount}/{total}
        </span>
        <span className="channels-dots" aria-hidden>
          {platformDots.map((p) => (
            <span
              key={p}
              className="channels-dot"
              style={{ background: PLATFORM_COLORS[p] }}
            />
          ))}
        </span>
        <span className="channels-label">connected</span>
      </button>
      {open && (
        <ChannelsPopover
          connections={stableConnections}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ChannelsPopover({
  connections,
  onClose,
}: {
  connections: ChatConnection[];
  onClose: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="channels-scrim" onClick={onClose} />
      <div className="channels-popover" role="dialog" aria-label="Connected channels">
        <div className="channels-popover-head">
          <h3>Connected channels</h3>
          <button
            type="button"
            className="btn icon ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="channels-popover-body">
          {connections.length === 0 ? (
            <p className="channels-empty">No channels yet — waiting for Restream.</p>
          ) : (
            <ul className="channels-list">
              {connections.map((c) => (
                <li
                  key={c.connectionIdentifier}
                  className={`channels-row status-${c.status}`}
                >
                  <span
                    className="platform-badge"
                    style={{ background: PLATFORM_COLORS[c.platform] }}
                  />
                  <div className="channels-row-meta">
                    <div className="channels-row-head">
                      <span className="channels-name">
                        {c.channelName ?? 'Unknown channel'}
                      </span>
                      <span className="platform-label">
                        {PLATFORM_LABELS[c.platform]}
                      </span>
                    </div>
                    <div className="channels-row-sub">
                      <span className={`channels-status-pill status-${c.status}`}>
                        {c.status}
                      </span>
                      {c.reason ? (
                        <span className="channels-reason" title={c.reason}>
                          {c.reason}
                        </span>
                      ) : null}
                      {c.url ? (
                        <a
                          className="channels-url"
                          href={c.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          open
                        </a>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="channels-foot">
            Viewer counts aren&apos;t exposed by Restream&apos;s Chat API — only
            connect status and identity. To check viewers on a specific
            platform, open its channel page via the link above.
          </p>
        </div>
      </div>
    </>
  );
}

function uniqueConnectedPlatforms(
  connections: ChatConnection[],
): Array<ChatConnection['platform']> {
  const seen = new Set<ChatConnection['platform']>();
  const out: ChatConnection['platform'][] = [];
  for (const c of connections) {
    if (c.status !== 'connected') continue;
    if (seen.has(c.platform)) continue;
    seen.add(c.platform);
    out.push(c.platform);
  }
  return out;
}
