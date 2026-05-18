// Update banner — v0.1.25, Download button rewired in v0.1.32, button
// relabelled to "Install Update" + fallback-to-release-page added in v0.1.37,
// in-banner click feedback (spinner + toast) added in v0.1.39.
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
//                        v0.1.39: click now shows a spinner + "Installing…"
//                        on the button (disabled while in flight) plus a
//                        toast in the top-right of the banner explaining
//                        what just happened — Squirrel kicked / browser
//                        opened / error. Voice 3369: "I clicked install
//                        update and I don't see anything happening." The
//                        feedback is always visible regardless of which
//                        backend path actually ran.
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

/**
 * Structural duplicate of `StartDownloadResult` from `src/main/updater.ts`.
 * Inlined here (and in preload.ts) so the renderer never imports anything
 * from the main bundle — keeps the renderer tree free of `electron`
 * imports. SOURCE OF TRUTH: `src/main/updater.ts` — keep these in sync.
 */
export type StartDownloadResult =
  | { ok: true; reason: 'started'; mode: 'squirrel' }
  | {
      ok: true;
      reason: 'opened-release-page';
      mode: 'browser';
      fallbackReason: string;
    }
  | {
      ok: false;
      reason: 'not-packaged' | 'unsupported-platform' | 'feed-unavailable' | 'error';
      error?: string;
      releaseUrl: string;
    };

/**
 * Pure helper — maps a `StartDownloadResult` to the user-facing toast
 * spec the banner renders. Exported for the test suite so the toast-
 * text-vs-result contract is pinned at CI time.
 *
 * - `mode === 'squirrel'`     → info toast, "Downloading update…"
 * - `mode === 'browser'`      → info toast, "Opening release page in browser…"
 * - `ok: false`               → error toast with the underlying error message
 *                               (or a generic fallback if none was provided).
 */
export interface ToastSpec {
  kind: 'info' | 'error';
  text: string;
}

export function decideToast(result: StartDownloadResult): ToastSpec {
  if (result.ok) {
    if (result.mode === 'squirrel') {
      return { kind: 'info', text: 'Downloading update…' };
    }
    return { kind: 'info', text: 'Opening release page in browser…' };
  }
  // ok === false — surface the error verbatim if present, otherwise a
  // generic message. The releaseUrl is intentionally NOT inlined in the
  // toast text because the toast is transient (auto-dismisses after 3s);
  // a user who needs the URL can re-click and the next click will go to
  // the same fallback path. Keeping the toast short = readable on the
  // thin banner strip.
  const msg = result.error?.trim();
  return {
    kind: 'error',
    text: msg && msg.length > 0 ? msg : 'Update could not start',
  };
}

/**
 * Toast auto-dismiss delay in milliseconds. Exported so tests can match
 * the value without hard-coding it. Three seconds is the same value used
 * by Producer Player's update toast and matches the OS-level "short
 * notification" feel.
 */
export const TOAST_AUTO_DISMISS_MS = 3000;

/**
 * Button labels — exported so tests can assert without hard-coding the
 * strings. The `Installing…` label is shown while the click handler is
 * awaiting the IPC round-trip; once the toast renders the button flips
 * back to `Install Update` so a follow-up click is possible (e.g. user
 * dismissed the toast but the browser bounce failed silently — they
 * deserve a retry without having to wait for a banner state transition).
 */
export const INSTALL_BUTTON_LABEL_IDLE = 'Install Update';
export const INSTALL_BUTTON_LABEL_INSTALLING = 'Installing…';

interface Props {
  info: UpdateInfo | null;
  dismissed: boolean;
  onDismiss: () => void;
  /**
   * Kicks Squirrel's in-app download pipeline via the preload
   * `rcpp.startUpdateDownload` API. v0.1.32 replaces the previous
   * `onDownload(url)` signature — the renderer no longer cares about
   * the release URL because the click stays in-app (no browser).
   *
   * v0.1.39: signature changed from `() => void` → `() => Promise<
   * StartDownloadResult>` so the banner can show a toast describing
   * the OUTCOME of the click (Squirrel kicked / browser opened /
   * error). The previous void signature gave the user nothing to look
   * at on unsigned builds where the click silently bounced to the
   * browser — Voice 3369 "I clicked install update and I don't see
   * anything happening".
   *
   * Injected from App.tsx for test-friendliness so the banner stays
   * pure / side-effect-free.
   */
  onStartDownload: () => Promise<StartDownloadResult>;
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
  // v0.1.39 state — only used in the `available` branch but hoisted to
  // the top of the component so React's hook count is stable across
  // renders regardless of which branch we return from (Rules of Hooks).
  const [installing, setInstalling] = React.useState(false);
  const [toast, setToast] = React.useState<ToastSpec | null>(null);

  // Auto-dismiss the toast after TOAST_AUTO_DISMISS_MS. Effect tied to
  // the toast identity so a fresh click while a previous toast is still
  // showing cancels the old timer + starts a new one cleanly.
  React.useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => {
      setToast(null);
    }, TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast]);

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
    const label = installing
      ? INSTALL_BUTTON_LABEL_INSTALLING
      : INSTALL_BUTTON_LABEL_IDLE;
    return (
      <div className="update-banner" role="status" aria-live="polite">
        <span className="update-banner-text">
          Update available {version} — running {info!.currentVersion}
        </span>
        <div className="update-banner-actions">
          <button
            className="btn primary"
            disabled={installing}
            aria-busy={installing}
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
              //
              // v0.1.39: await the structured StartDownloadResult and show
              // a toast describing the outcome. The button flips to
              // disabled + "Installing…" while the IPC is in flight so the
              // user sees something happening even on a slow OAuth-blocked
              // boot path.
              setInstalling(true);
              void (async () => {
                try {
                  const result = await onStartDownload();
                  setToast(decideToast(result));
                } catch (err) {
                  // The IPC layer normalises errors into `ok: false`
                  // results, so this branch is for the truly-pathological
                  // case where the IPC channel itself failed (preload
                  // contextBridge gone, renderer process detached, etc.).
                  setToast({
                    kind: 'error',
                    text: `Update could not start: ${String(
                      (err as Error)?.message ?? err,
                    )}`,
                  });
                } finally {
                  setInstalling(false);
                }
              })();
            }}
          >
            {installing && (
              <span
                className="update-banner-spinner update-banner-button-spinner"
                aria-hidden="true"
              />
            )}
            {label}
          </button>
          <button className="btn ghost" onClick={onDismiss} disabled={installing}>
            Later
          </button>
        </div>
        {toast && (
          <div
            className={`update-banner-toast update-banner-toast-${toast.kind}`}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
          >
            <span className="update-banner-toast-text">{toast.text}</span>
            <button
              className="update-banner-toast-dismiss"
              onClick={() => setToast(null)}
              aria-label="Dismiss notification"
              type="button"
            >
              ×
            </button>
          </div>
        )}
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
