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
 *
 * v0.1.61 — added `error` state. Previously the `error` UpdateInfo kind
 * was hidden (the GH-Releases poller's `error` payload was treated as a
 * silent / logged-only condition). The Squirrel-side updater now also
 * broadcasts `kind: 'error'` when an `error` event fires (most commonly
 * the ad-hoc → Developer-ID signature mismatch on Ethan's MBP), and the
 * banner needs to render a persistent error pane with a manual-fallback
 * "Open GitHub Releases" button instead of silently dropping the signal.
 * The state-machine treats every `error` as visible regardless of the
 * dismiss flag — the user must explicitly dismiss the error pane to
 * hide it.
 */
export type BannerState =
  | 'hidden'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready-to-install'
  | 'error';

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
    case 'error':
      // v0.1.61 — only show the error pane when the error came from the
      // Squirrel download/install path (i.e. populated by
      // `attachSquirrelProgressForwarders`' `error` handler). The
      // GH-Releases poller also broadcasts `kind: 'error'` on transient
      // network failures; those are intentionally silent (no banner) so
      // a flaky wifi blip doesn't drop a red error pane on an unaware
      // user.
      //
      // We distinguish the two paths via `errorReleaseUrl`, which is
      // ONLY populated by the Squirrel side (the GH poller's `error`
      // payload has no `errorReleaseUrl`). The renderer therefore only
      // shows the error banner when there's actually a manual-fallback
      // link to offer.
      if (dismissed) return 'hidden';
      if (!info.errorReleaseUrl) return 'hidden';
      return 'error';
    default:
      // 'up-to-date' / 'disabled' — no banner.
      return 'hidden';
  }
}

/**
 * v0.1.61 — format bytes for the download progress label. Returns
 * e.g. "12.4 MB", "987 KB", "543 B". Locale-free so the test suite can
 * pin exact strings without flapping on CI's default locale.
 */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

/**
 * v0.1.61 — format download speed as "1.4 MB/s" or "234 KB/s".
 */
export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (
    typeof bytesPerSecond !== 'number' ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond < 0
  ) {
    return '';
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * v0.1.61 — turn `errorCategory` + `error` into the banner's headline +
 * action-suggestion strings. Pure helper so tests can pin the wording
 * contract without going through the full render path.
 */
export interface ErrorCopy {
  headline: string;
  detail: string;
  buttonLabel: string;
}

export function decideErrorCopy(info: UpdateInfo): ErrorCopy {
  const cat = info.errorCategory ?? 'unknown';
  const version = info.latestVersion ? ` (${info.latestVersion})` : '';
  if (cat === 'signature-mismatch') {
    return {
      headline: `Couldn't auto-install update${version}`,
      detail:
        'Your installed app and the new release are signed differently, so macOS blocked the in-place swap. Open GitHub Releases and reinstall from there.',
      buttonLabel: 'Open GitHub Releases',
    };
  }
  if (cat === 'network') {
    return {
      headline: `Update download failed${version}`,
      detail:
        'A network error interrupted the download. Check your connection or grab the release manually from GitHub.',
      buttonLabel: 'Open GitHub Releases',
    };
  }
  if (cat === 'staging') {
    return {
      headline: `Update couldn't be staged${version}`,
      detail:
        "macOS rejected staging the new bundle (disk space, permissions, or ShipIt error). Try again or install manually from GitHub.",
      buttonLabel: 'Open GitHub Releases',
    };
  }
  return {
    headline: `Update failed${version}`,
    detail:
      info.error?.trim() ||
      "Something went wrong applying the update. Install manually from GitHub Releases.",
    buttonLabel: 'Open GitHub Releases',
  };
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
    return (
      <DownloadingPane info={info!} />
    );
  }

  if (state === 'error') {
    const copy = decideErrorCopy(info!);
    return (
      <div
        className="update-banner update-banner-error"
        role="alert"
        aria-live="assertive"
      >
        <div className="update-banner-error-body">
          <span className="update-banner-text update-banner-error-headline">
            {copy.headline}
          </span>
          <span className="update-banner-text update-banner-error-detail">
            {copy.detail}
          </span>
        </div>
        <div className="update-banner-actions">
          <button
            className="btn primary"
            onClick={() => {
              const url = info!.errorReleaseUrl;
              if (!url) return;
              try {
                const api = (
                  globalThis as unknown as {
                    rcpp?: { openExternal?: (u: string) => Promise<unknown> };
                  }
                ).rcpp;
                void api?.openExternal?.(url);
              } catch {
                // No-op — the preload API may be absent in tests.
              }
            }}
          >
            {copy.buttonLabel}
          </button>
          <button className="btn ghost" onClick={onDismiss}>
            Dismiss
          </button>
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

/**
 * v0.1.61 — broken out into its own component so the elapsed-time tick
 * effect (which the banner uses to detect a stalled download) doesn't
 * pollute the main banner's hook tree across other states. The pane
 * shows:
 *
 *   - Percentage (if Squirrel reported one) OR "starting" placeholder.
 *   - Bytes-downloaded / bytes-total (if Squirrel reported them).
 *   - Download speed in KB/s or MB/s.
 *   - Elapsed time since the user clicked Install Update.
 *   - After 30s with NO percent reported AND no bytes transferred, a
 *     "Squirrel hasn't reported progress yet — this can take a moment"
 *     hint to reassure the user (the common silent-failure mode on
 *     Ethan's MBP is the download stalls before the first chunk; the
 *     error event eventually fires, but until then there's dead air).
 */
function DownloadingPane({ info }: { info: UpdateInfo }): React.ReactElement {
  const pct = info.downloadPercent;
  const hasPct = typeof pct === 'number';
  const bytes = info.downloadBytesTransferred;
  const total = info.downloadBytesTotal;
  const bps = info.downloadBytesPerSecond;
  const startedAt = info.downloadStartedAt;
  const version = info.latestVersion;

  // Re-render on a wall-clock tick so the elapsed-time label updates
  // even when no fresh `download-progress` event has arrived. Bounded
  // to once per second — Squirrel can fire `download-progress` MUCH
  // more often than that, but elapsed-time UI only needs second
  // resolution.
  const [nowTick, setNowTick] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsedSec =
    typeof startedAt === 'number' && startedAt > 0
      ? Math.max(0, Math.floor((nowTick - startedAt) / 1000))
      : 0;
  const elapsedLabel =
    elapsedSec > 0
      ? elapsedSec < 60
        ? `${elapsedSec}s`
        : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
      : '';

  const percentLabel = hasPct ? `${Math.round(pct as number)}%` : '…';
  const bytesLabel =
    typeof bytes === 'number' && typeof total === 'number'
      ? `${formatBytes(bytes)} / ${formatBytes(total)}`
      : typeof bytes === 'number'
        ? formatBytes(bytes)
        : '';
  const speedLabel = formatSpeed(bps);

  const headline = version
    ? `Downloading Restream Chat++ v${version}… ${percentLabel}`
    : `Downloading update… ${percentLabel}`;

  // Stall hint: more than 30 seconds elapsed AND we have no percent
  // and no bytes-transferred. Squirrel sometimes goes silent here when
  // the staged bundle is being unzipped + signature-checked; usually
  // resolves within another ~30s, but the user gets no signal until
  // either the next progress chunk OR the eventual error event. Show
  // an explicit hint so the user knows the click did kick the
  // pipeline.
  const looksStalled =
    !hasPct && (typeof bytes !== 'number' || bytes === 0) && elapsedSec >= 30;

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
      <span className="update-banner-text update-banner-downloading-headline">
        {headline}
      </span>
      <div
        className="update-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasPct ? Math.round(pct as number) : undefined}
      >
        <div
          className={`update-progress-bar${hasPct ? '' : ' indeterminate'}`}
          style={
            hasPct
              ? { width: `${Math.max(0, Math.min(100, pct as number))}%` }
              : undefined
          }
        />
      </div>
      <div className="update-banner-progress-meta">
        {bytesLabel && (
          <span className="update-banner-meta-item">{bytesLabel}</span>
        )}
        {speedLabel && (
          <span className="update-banner-meta-item">{speedLabel}</span>
        )}
        {elapsedLabel && (
          <span className="update-banner-meta-item">elapsed {elapsedLabel}</span>
        )}
      </div>
      {looksStalled && (
        <span
          className="update-banner-text update-banner-stall-hint"
          role="status"
          aria-live="polite"
        >
          Still working… Squirrel hasn't reported progress yet. If this
          stays stuck for another minute, the download may have failed —
          we'll surface an error here if so.
        </span>
      )}
    </div>
  );
}
