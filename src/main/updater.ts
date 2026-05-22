// Auto-update wiring for Restream Chat++.
//
// Uses the `update-electron-app` wrapper, which polls
// `https://update.electronjs.org/<owner>/<repo>/<platform>-<arch>/<version>`
// (Electron's free public service for open-source apps) and surfaces a
// native restart-to-update dialog when a new release ships.
//
// Notes:
// - The service requires the GitHub repo to be PUBLIC. Ours is.
// - Auto-update only works when the app is signed + notarized on macOS
//   (Squirrel.Mac refuses unsigned updates). The CI release job handles
//   that; local `npm run make` produces unsigned builds that simply skip
//   auto-update (the `update-electron-app` helper bails early when the
//   app is in dev or not packaged).
// - `update-electron-app` swallows errors from update.electronjs.org so
//   they don't disrupt the user; we surface them through electron-log.

import { app, autoUpdater, BrowserWindow, dialog, shell } from 'electron';
import log from 'electron-log/main';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import { IPC, UpdateInfo } from '../shared/types';
import { performGithubUpdateCheck } from './github-update-check';

const REPO = 'EthanSK/restream-chat-plus-plus';

let configured = false;
// True once `updateElectronApp({...})` has run, i.e. `autoUpdater.setFeedURL`
// has been called. We must not invoke `autoUpdater.checkForUpdates()` before
// this — the native autoUpdater throws synchronously without a feed URL,
// which in turn surfaces the macOS "this command is disabled and cannot be
// executed" alert when the throw happens inside a menu click handler.
let feedURLReady = false;
// Re-entrancy guard: stop the user spam-clicking the menu item while a
// check is already mid-flight (each click adds a `once` listener; without
// this guard multiple "you're on the latest version" dialogs would stack).
let checkInFlight = false;
// True after Squirrel emits `update-downloaded` — guards `quitAndInstall()`
// so the renderer's Restart button can't trigger a sync throw if it
// somehow fires before the download settled. v0.1.25.
let updateDownloaded = false;

/**
 * Push an UpdateInfo payload to every live BrowserWindow via the existing
 * `IPC.UPDATE_STATUS` channel — shared with the GH-Releases poller so the
 * renderer's `onUpdateStatus` subscription handles both signal sources
 * uniformly. We deliberately do NOT route through `github-update-check`'s
 * internal `broadcast()` because that helper is gated on a meaningful
 * payload diff (kind/latestVersion/error) — Squirrel emits dozens of
 * `download-progress` events with the same kind, and they all need to
 * reach the renderer for the percentage to animate. v0.1.25.
 */
function broadcastSquirrelStatus(info: UpdateInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.UPDATE_STATUS, info);
    } catch (err) {
      log.error('[updater] broadcast failed', err);
    }
  }
}

/**
 * Subscribe to Squirrel's autoUpdater events and forward each into the
 * renderer's `UpdateBanner` via `IPC.UPDATE_STATUS` so the user gets live
 * feedback while a background download is in flight. v0.1.25.
 *
 * Events of interest:
 *   - `download-progress` (newer Electron + Squirrel-mac builds) — fires
 *     with `{ percent, bytesPerSecond, total, transferred }`. We forward
 *     `percent` only; the banner's progress bar doesn't need the rest.
 *     NOTE: not every Squirrel.Mac build emits this event; on older
 *     builds the user sees an indeterminate "Downloading…" bar instead.
 *   - `update-downloaded` — fires once the new bundle is staged + ready
 *     to apply. Renderer flips to the `ready-to-install` state.
 *
 * `update-electron-app`'s `notifyUser: true` ALSO listens to
 * `update-downloaded` and shows its own native restart-to-update dialog.
 * That's fine: both UI paths coexist — the user can click either the
 * banner's Restart button or the dialog's button; both call
 * `quitAndInstall()` in the end.
 */
function attachSquirrelProgressForwarders(): void {
  // `download-progress` isn't in Electron's `autoUpdater` d.ts (Squirrel
  // emits it internally). Cast through EventEmitter so we can subscribe
  // without TS complaining about the unknown event name. Runtime contract
  // from Squirrel: the callback receives a single
  // `{ percent, bytesPerSecond?, total?, transferred? }` object.
  (autoUpdater as unknown as NodeJS.EventEmitter).on(
    'download-progress',
    (progress?: { percent?: number }) => {
      try {
        const raw = progress?.percent;
        const percent =
          typeof raw === 'number' && Number.isFinite(raw)
            ? Math.max(0, Math.min(100, raw))
            : undefined;
        broadcastSquirrelStatus({
          kind: 'downloading',
          currentVersion: app.getVersion(),
          downloadPercent: percent,
          checkedAt: Date.now(),
        });
      } catch (err) {
        log.error('[updater] download-progress forward failed', err);
      }
    },
  );

  autoUpdater.on(
    'update-downloaded',
    (_evt: Electron.Event, _releaseNotes?: string, releaseName?: string) => {
      try {
        updateDownloaded = true;
        broadcastSquirrelStatus({
          kind: 'ready-to-install',
          currentVersion: app.getVersion(),
          // `releaseName` is the version string per Electron's autoUpdater
          // contract on macOS (Squirrel.Mac sets it to the new bundle's
          // CFBundleShortVersionString).
          latestVersion: typeof releaseName === 'string' ? releaseName : undefined,
          checkedAt: Date.now(),
        });
        log.info('[updater] update downloaded, ready to install', { releaseName });
      } catch (err) {
        log.error('[updater] update-downloaded forward failed', err);
      }
    },
  );
}

/**
 * Renderer-triggered restart. Bound to `IPC.UPDATE_QUIT_AND_INSTALL` in
 * `main.ts`. `autoUpdater.quitAndInstall()` throws synchronously if no
 * update has been staged — guarded with `updateDownloaded` so the
 * Restart button can't accidentally crash the app. v0.1.25.
 */
export function quitAndInstallStagedUpdate(): { ok: boolean; reason?: string } {
  if (!updateDownloaded) {
    log.warn('[updater] quit-and-install requested but no update staged');
    return { ok: false, reason: 'no-update-downloaded' };
  }
  try {
    log.info('[updater] quit-and-install triggered from renderer');
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (err) {
    log.error('[updater] quit-and-install threw', err);
    return { ok: false, reason: String((err as Error)?.message ?? err) };
  }
}

/**
 * Result of triggering Squirrel's in-app download from the renderer's
 * "Download" button. v0.1.32+.
 *
 *   - 'started'              → autoUpdater.checkForUpdates() was kicked.
 *                              Squirrel will emit `download-progress` and
 *                              `update-downloaded` events which the
 *                              progress forwarders broadcast as
 *                              `IPC.UPDATE_STATUS` payloads — the banner
 *                              transitions through 'downloading' →
 *                              'ready-to-install' automatically.
 *   - 'not-packaged'         → dev mode; nothing to do.
 *   - 'unsupported-platform' → Linux; no Squirrel support compiled in.
 *   - 'feed-unavailable'     → `updateElectronApp({...})` never settled
 *                              (unsigned build, network problem at boot,
 *                              etc.). User is told in-app rather than
 *                              being silently bounced to the browser.
 *   - 'error'                → `autoUpdater.checkForUpdates()` threw.
 */
/**
 * v0.1.39: `mode` discriminator added so the renderer can pick the
 * right user-facing toast. `squirrel` = in-app pipeline kicked
 * (banner will transition through `downloading` automatically);
 * `browser` = main-process fallback successfully bounced the user to
 * the GitHub release page in their default browser. On failure
 * (`ok: false`) the renderer renders an error toast with the
 * release-page URL as a manual-fallback link.
 */
export type StartDownloadResult =
  | { ok: true; reason: 'started'; mode: 'squirrel' }
  | { ok: true; reason: 'opened-release-page'; mode: 'browser'; fallbackReason: string }
  | {
      ok: false;
      reason: 'not-packaged' | 'unsupported-platform' | 'feed-unavailable' | 'error';
      error?: string;
      /**
       * Always populated on failure so the renderer can offer a manual
       * "click here" link as last-resort fallback (e.g. shell.openExternal
       * threw too — extremely rare but possible on locked-down systems).
       */
      releaseUrl: string;
    };

/**
 * Renderer-triggered in-app download. Bound to
 * `IPC.UPDATE_DOWNLOAD_START` in `main.ts`. Click handler for the
 * `UpdateBanner`'s "Download" button when the banner is in `available`
 * state.
 *
 * Pre-v0.1.32 this button opened the GitHub release page in the user's
 * default browser via `shell.openExternal`. That side-stepped the entire
 * Squirrel pipeline we'd already wired in v0.1.25 (Squirrel emits
 * download-progress → renderer shows progress bar → Squirrel emits
 * update-downloaded → renderer shows Restart button → user clicks →
 * quitAndInstall swaps the bundle). v0.1.32 wires the button to fire
 * `autoUpdater.checkForUpdates()` instead so the in-app pipeline
 * actually runs.
 *
 * `autoUpdater.checkForUpdates()` is idempotent — calling it while
 * a download is already in flight is a no-op. We guard against a stray
 * call before the feed URL is configured because the native autoUpdater
 * throws synchronously in that case (same root cause as
 * `checkForUpdatesInteractive`).
 */
export const UPDATE_RELEASE_PAGE_URL =
  'https://github.com/EthanSK/restream-chat-plus-plus/releases';

export function triggerSquirrelDownload(): StartDownloadResult {
  if (!app.isPackaged) {
    log.info('[updater] download requested in dev/unpackaged build — no-op');
    return { ok: false, reason: 'not-packaged', releaseUrl: UPDATE_RELEASE_PAGE_URL };
  }
  if (process.platform === 'linux') {
    // Squirrel.Mac handles macOS, Squirrel.Windows handles win32; Linux
    // updates ship as .deb / .rpm packages outside the Electron auto-
    // update pipeline. We surface this distinctly so the renderer (or
    // a main-process dialog) can route the user to the right path.
    log.info('[updater] download requested on linux — no in-app updater');
    return {
      ok: false,
      reason: 'unsupported-platform',
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
  if (!feedURLReady) {
    // `configureAutoUpdater()` never settled — common on unsigned builds
    // where `updateElectronApp({...})` throws because Squirrel.Mac refuses
    // an unsigned feed. Without this guard, calling checkForUpdates()
    // would throw synchronously ("Update feed URL is not set"). v0.1.32.
    log.warn('[updater] download requested but feed URL not ready');
    return {
      ok: false,
      reason: 'feed-unavailable',
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
  try {
    log.info('[updater] kicking autoUpdater.checkForUpdates() from renderer');
    autoUpdater.checkForUpdates();
    return { ok: true, reason: 'started', mode: 'squirrel' };
  } catch (err) {
    log.error('[updater] checkForUpdates() threw', err);
    return {
      ok: false,
      reason: 'error',
      error: String((err as Error)?.message ?? err),
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
}

export function configureAutoUpdater(): void {
  if (configured) return;
  configured = true;

  // Skip in dev — `update-electron-app` already short-circuits when
  // `!app.isPackaged`, but this also avoids the misleading log line.
  if (!app.isPackaged) {
    log.info('[updater] skipping auto-update (not packaged / dev mode)');
    return;
  }

  try {
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: REPO,
      },
      // Poll every hour. The default is also 1h; we set it explicitly so
      // tweaking later is one line.
      updateInterval: '1 hour',
      logger: log,
      notifyUser: true, // built-in restart-to-update dialog
    });
    feedURLReady = true;
    // Wire Squirrel download-progress + update-downloaded forwarders so
    // the renderer's `UpdateBanner` can show a progress bar + restart
    // button respectively. Must be attached AFTER `updateElectronApp`
    // configures the feed URL — before that, the autoUpdater isn't set
    // up. v0.1.25.
    attachSquirrelProgressForwarders();
    log.info('[updater] auto-update configured for', REPO);
  } catch (err) {
    log.error('[updater] failed to configure auto-update', err);
  }
}

/**
 * Resolve a usable parent window for `dialog.showMessageBox`.
 *
 * `dialog.showMessageBox(null, opts)` is NOT a valid Electron overload —
 * the first arg must be a real `BrowserWindow` or omitted entirely.
 * Passing `null` throws `TypeError: Error processing argument at index 0`,
 * which inside a menu-click handler bubbles up to the native menu validator
 * and is surfaced by macOS as "this command is disabled and cannot be
 * executed". Always normalise to either a live window or `undefined`.
 */
function resolveParent(parent: BrowserWindow | null): BrowserWindow | undefined {
  if (parent && !parent.isDestroyed()) return parent;
  const fallback = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return fallback && !fallback.isDestroyed() ? fallback : undefined;
}

/**
 * Show a message box that works whether or not we have a parent window.
 * Electron requires the two-arg form when `parent` is truthy and the
 * one-arg form when it isn't; mixing them up throws synchronously.
 */
async function safeMessageBox(
  parent: BrowserWindow | undefined,
  opts: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  try {
    return parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts);
  } catch (err) {
    log.error('[updater] showMessageBox failed', err);
    return { response: 0, checkboxChecked: false };
  }
}

/**
 * Triggered by the "Check for Updates Now…" menu item.
 *
 * v0.1.37 rewrite: this is now backed by the **GH-Releases pipeline**
 * (`performGithubUpdateCheck`) so the user-facing dialog ALWAYS agrees
 * with the in-app banner. Pre-v0.1.37 the menu used Squirrel's
 * `autoUpdater.checkForUpdates()`, which on unsigned macOS builds
 * resolves to `update-not-available` and shows "you're on the latest
 * version" — even when GH Releases is reporting a newer release that
 * the banner is already advertising. Voice 3351 flagged this two-
 * sources-of-truth mismatch directly: "Your dialogue says you're on
 * the latest version, but then the top banner says update available
 * 0.1.36. Is it looking at a different source? Maybe that's the
 * problem."
 *
 * After producing the authoritative GH-Releases verdict, this function
 * ALSO kicks Squirrel's `autoUpdater.checkForUpdates()` in the
 * background when the feed is ready (signed packaged builds) so the
 * in-app download → restart-to-install flow still runs without the
 * user needing to click Install on the banner. On unsigned / dev /
 * Linux Squirrel is skipped entirely and the dialog offers an "Open
 * Releases" button that drops the user on the GitHub release page.
 *
 * IMPORTANT: this function must never throw synchronously. The
 * Electron menu-click dispatcher treats a sync throw as a failed
 * action invocation and macOS surfaces it as the cryptic alert "this
 * command is disabled and cannot be executed". All known throw sites
 * are caught and converted into user-visible dialogs.
 */
export async function checkForUpdatesInteractive(
  parent: BrowserWindow | null,
): Promise<void> {
  const owner = resolveParent(parent);

  if (checkInFlight) {
    log.info('[updater] check already in flight, ignoring duplicate click');
    return;
  }
  checkInFlight = true;

  try {
    // 1. Hit GH Releases — authoritative source. `performGithubUpdateCheck`
    //    broadcasts `UPDATE_STATUS` so the banner state syncs to the
    //    dialog automatically (no two-sources-of-truth window).
    const info = await performGithubUpdateCheck(true);

    // 2. Render dialog based on the GH-Releases verdict.
    if (info.kind === 'available') {
      const latest = info.latestVersion ?? '(unknown)';
      const releaseUrl = info.releaseUrl ?? `https://github.com/${REPO}/releases`;
      const detail =
        `You're running ${info.currentVersion}. Latest is ${latest}.\n\n` +
        (app.isPackaged && process.platform !== 'linux' && feedURLReady
          ? "The update is downloading in the background — you'll be prompted to restart once it's ready."
          : 'Open the release page to install manually (this build is not connected to the in-app update feed).');
      const buttons = ['Open Release Page', 'OK'];
      const { response } = await safeMessageBox(owner, {
        type: 'info',
        message: `Update available (${latest}).`,
        detail,
        buttons,
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) await shell.openExternal(releaseUrl);

      // 3. Kick Squirrel in the background if it can actually run.
      //    Wrapped in a try/catch because the native autoUpdater
      //    throws synchronously if anything is misconfigured — we
      //    don't want that to leak into the menu-click dispatcher.
      if (app.isPackaged && process.platform !== 'linux' && feedURLReady) {
        try {
          log.info('[updater] kicking Squirrel checkForUpdates() from menu');
          autoUpdater.checkForUpdates();
        } catch (err) {
          log.error('[updater] background Squirrel kick threw', err);
        }
      }
    } else if (info.kind === 'up-to-date') {
      await safeMessageBox(owner, {
        type: 'info',
        message: `You're on the latest version (${info.currentVersion}).`,
        buttons: ['OK'],
      });
    } else if (info.kind === 'error') {
      await safeMessageBox(owner, {
        type: 'warning',
        message: 'Update check failed.',
        detail: info.error ?? 'Unknown error.',
        buttons: ['OK'],
      });
    } else if (info.kind === 'disabled') {
      // Forcing through performGithubUpdateCheck(true) should never
      // resolve to `disabled` — `force=true` bypasses the autoCheck
      // gate. Guard defensively anyway.
      await safeMessageBox(owner, {
        type: 'info',
        message: 'Update checks are currently disabled in Settings.',
        buttons: ['OK'],
      });
    }
    // `checking` is transient — `performGithubUpdateCheck` resolves
    // with a terminal kind, never `checking`, so we don't handle it.
  } catch (err) {
    log.error('[updater] interactive check failed', err);
    await safeMessageBox(owner, {
      type: 'warning',
      message: 'Update check failed.',
      detail: String((err as Error)?.message ?? err),
      buttons: ['OK'],
    });
  } finally {
    checkInFlight = false;
  }
}
