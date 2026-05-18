// Update banner — v0.1.25, Download button rewired in v0.1.32, button
// relabelled to "Install Update" + fallback-to-release-page added in v0.1.37.
//
// Renders a thin strip below the titlebar that surfaces the current
// state of the auto-update flow. v0.1.24 had a single "Update available"
// state; v0.1.25 adds three more so the user gets continuous feedback
// while the background download is happening:
//
//   `checking`         → small spinner + "Checking for updates…".
//                        Fired by the GH-Releases poller AND by the
//                        manual "Check for Updates Now…" path.
//   `available`        → "Update available {version}" + Install Update +
//                        Later buttons. v0.1.32: clicking the primary
//                        button kicks Squirrel's in-app `checkForUpdates()`
//                        pipeline (via `IPC.UPDATE_DOWNLOAD_START`)
//                        instead of opening the GitHub release page in
//                        the user's default browser. The banner state
//                        machine transitions to `downloading` once
//                        Squirrel emits its first `download-progress`
//                        event — no extra renderer wiring needed.
//                        v0.1.37: button label changed from "Download" to
//                        "Install Update"; on unsigned / dev / Linux the
//                        main-process handler opens the release page
//                        directly so the click is never a no-op.
//   `downloading`      → "Downloading update… NN%" + progress bar.
//                        Driven by Squirrel's `download-progress` event;
//                        on signed builds only. NO Dismiss button — once
//                        the download is underway we want the user to
//                        see it through to the restart prompt.
//   `ready-to-install` → "Update ready — Restart to install" + Restart
//                        button. Fired by `update-downloaded`. Restart
//                        calls `quitAndInstall()` via IPC.
//
// State machine (pure, tested via `updateBannerState`):
//   info.kind === 'available'        AND !dismissed → 'available'
//   info.kind === 'available'        AND  dismissed → 'hidden'
//   info.kind === 'checking'                       → 'checking'
//   info.kind === 'downloading'                    → 'downloading'
//   info.kind === 'ready-to-install'               → 'ready-to-install'
//   anything else (up-to-date / disabled / error)  → 'hidden'
//
// The `dismissed` flag is intentionally session-only and only applies to
// the `available` state — once a download starts, dismissing it would
// hide a process the user can't easily restart. The pattern matches
// Producer Player's update banner.

import React from 'react';
import type { UpdateInfo } from '../shared/types';

/**
 * Pure state-machine helper. Exported separately so the test suite can
 * drive the banner without a real DOM. Keep this side-effect-free.
 */
export type BannerState =
  | 'hidden'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready-to-install';

export function updateBannerState(
  info: UpdateInfo | null,
  dismissed: boolean,
): BannerState {
  if (!info) return 'hidden';
  switch (info.kind) {
    case 'checking':
      return 'checking';
    case 'available':
      if (dismissed) return 'hidden';
      // `available` implies latestVersion + releaseUrl are populated per
      // the main-process contract (`github-update-check.ts`); guard
      // anyway so a malformed payload doesn't render a button with no URL.
      if (!info.latestVersion || !info.releaseUrl) return 'hidden';
      return 'available';
    case 'downloading':
      return 'downloading';
    case 'ready-to-install':
      return 'ready-to-install';
    default:
      // 'up-to-date' / 'disabled' / 'error' — no banner.
      return 'hidden';
  }
}

interface Props {
  info: UpdateInfo | null;
  dismissed: boolean;
  onDismiss: () => void;
  /**
   * Kicks Squirrel's in-app download pipeline via the preload
   * `rcpp.startUpdateDownload` API. v0.1.32 replaces the previous
   * `onDownload(url)` signature — the renderer no longer cares about
   * the release URL because the click stays in-app (no browser).
   * Injected from App.tsx for test-friendliness so the banner stays
   * pure / side-effect-free.
   */
  onStartDownload: () => void;
  /**
   * Triggers Squirrel's `quitAndInstall()` via the preload
   * `rcpp.quitAndInstall` API. Injected for test-friendliness. v0.1.25.
   */
  onRestart: () => void;
}

export function UpdateBanner({
  info,
  dismissed,
  onDismiss,
  onStartDownload,
  onRestart,
}: Props): React.ReactElement | null {
  const state = updateBannerState(info, dismissed);
  if (state === 'hidden') return null;

  if (state === 'checking') {
    return (
      <div className="update-banner update-banner-checking" role="status" aria-live="polite">
        <span className="update-banner-spinner" aria-hidden="true" />
        <span className="update-banner-text">Checking for updates…</span>
      </div>
    );
  }

  if (state === 'available') {
    const version = info!.latestVersion!;
    return (
      <div className="update-banner" role="status" aria-live="polite">
        <span className="update-banner-text">
          Update available {version} — running {info!.currentVersion}
        </span>
        <div className="update-banner-actions">
          <button
            className="btn primary"
            onClick={() => {
              // v0.1.37: button label is now "Install Update" — the v0.1.32
              // wording "Download" was ambiguous (Ethan: "It should just do
              // the same thing as what check for updates does"). Behaviour:
              // fire IPC.UPDATE_DOWNLOAD_START in main → if Squirrel feed is
              // ready (signed packaged build) it kicks the in-app pipeline
              // and the banner transitions through 'downloading' →
              // 'ready-to-install' automatically via Squirrel progress
              // events. On unsigned / dev / Linux the main-process handler
              // opens the GitHub release page directly (no extra dialog
              // click) so a click on this button always results in a
              // visible next step rather than silently failing.
              onStartDownload();
            }}
          >
            Install Update
          </button>
          <button className="btn ghost" onClick={onDismiss}>
            Later
          </button>
        </div>
      </div>
    );
  }

  if (state === 'downloading') {
    // `downloadPercent` may be undefined on the very first event before
    // Squirrel reports its first chunk; render an indeterminate bar in
    // that case so the user still sees "something is happening".
    const pct = info!.downloadPercent;
    const hasPct = typeof pct === 'number';
    const display = hasPct ? `${Math.round(pct as number)}%` : '…';
    return (
      <div
        className="update-banner update-banner-downloading"
        role="status"
        aria-live="polite"
        aria-label={
          hasPct
            ? `Downloading update, ${Math.round(pct as number)} percent complete`
            : 'Downloading update'
        }
      >
        <span className="update-banner-text">Downloading update… {display}</span>
        <div
          className="update-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={hasPct ? Math.round(pct as number) : undefined}
        >
          <div
            className={`update-progress-bar${hasPct ? '' : ' indeterminate'}`}
            style={hasPct ? { width: `${Math.max(0, Math.min(100, pct as number))}%` } : undefined}
          />
        </div>
      </div>
    );
  }

  // ready-to-install
  const readyVersion = info!.latestVersion;
  return (
    <div className="update-banner update-banner-ready" role="status" aria-live="polite">
      <span className="update-banner-text">
        Update ready{readyVersion ? ` (${readyVersion})` : ''} — Restart to install
      </span>
      <div className="update-banner-actions">
        <button className="btn primary" onClick={onRestart}>
          Restart
        </button>
        <button className="btn ghost" onClick={onDismiss}>
          Later
        </button>
      </div>
    </div>
  );
}
