// Update-available banner — v0.1.19.
//
// Renders a thin amber strip below the titlebar when the GH-Releases poller
// reports `kind: 'available'`. Two buttons:
//
//   - Download  → opens the release page in the user's default browser
//                 (`rcpp.openExternal(releaseUrl)`), then dismisses the
//                 banner for this session. The next launch will re-check
//                 and re-show the banner if the user hasn't actually
//                 installed the newer build yet, which is the desired
//                 "nag, but not too hard" behavior.
//   - Later     → dismisses the banner for this session. Same re-show
//                 behavior on next launch.
//
// State machine (pure, tested via `updateBannerState` below):
//   info.kind === 'available' AND !dismissed → 'visible'
//   info.kind === 'available' AND  dismissed → 'hidden'
//   anything else                            → 'hidden'
//
// We intentionally don't persist the dismissed flag across launches — Ethan
// preferred a soft nag over a sticky one. Same pattern as Producer Player.

import React from 'react';
import type { UpdateInfo } from '../shared/types';

/**
 * Pure state-machine helper. Exported separately so the test suite can drive
 * the banner without a real DOM. Keep this side-effect-free.
 */
export function updateBannerState(
  info: UpdateInfo | null,
  dismissed: boolean,
): 'visible' | 'hidden' {
  if (!info) return 'hidden';
  if (info.kind !== 'available') return 'hidden';
  if (dismissed) return 'hidden';
  // `available` implies latestVersion + releaseUrl are populated per the
  // main-process contract (`github-update-check.ts`); guard anyway so a
  // malformed payload doesn't render a button with no URL.
  if (!info.latestVersion || !info.releaseUrl) return 'hidden';
  return 'visible';
}

interface Props {
  info: UpdateInfo | null;
  dismissed: boolean;
  onDismiss: () => void;
  /**
   * Opens the release URL in the user's default browser via the preload
   * `rcpp.openExternal` API. The component is dumb — it doesn't know about
   * IPC — so this is injected from App.tsx for test-friendliness.
   */
  onDownload: (url: string) => void;
}

export function UpdateBanner({ info, dismissed, onDismiss, onDownload }: Props): React.ReactElement | null {
  if (updateBannerState(info, dismissed) === 'hidden') return null;
  // After updateBannerState confirms 'visible', latestVersion + releaseUrl
  // are guaranteed non-undefined.
  const version = info!.latestVersion!;
  const url = info!.releaseUrl!;
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-text">
        Update available {version} — running {info!.currentVersion}
      </span>
      <div className="update-banner-actions">
        <button
          className="btn primary"
          onClick={() => {
            onDownload(url);
            onDismiss();
          }}
        >
          Download
        </button>
        <button className="btn ghost" onClick={onDismiss}>
          Later
        </button>
      </div>
    </div>
  );
}
