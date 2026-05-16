import React, { useMemo, useState } from 'react';
import {
  ChatConnection,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
} from '../shared/types';

interface Props {
  connections: ChatConnection[];
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

  const { connectedCount, total } = useMemo(() => {
    const connected = connections.filter((c) => c.status === 'connected').length;
    return { connectedCount: connected, total: connections.length };
  }, [connections]);

  if (total === 0) return null;

  const platformDots = uniqueConnectedPlatforms(connections);

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
          connections={connections}
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
