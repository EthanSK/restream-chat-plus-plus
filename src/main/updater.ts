// Auto-update wiring for Restream Chat Plus Plus.
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

import { app, BrowserWindow, dialog, shell } from 'electron';
import log from 'electron-log/main';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';

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
 * Triggered by the "Check for Updates…" menu item. `update-electron-app`
 * doesn't expose a programmatic "check now" hook, so we rely on the
 * underlying `electron.autoUpdater` (Squirrel.Mac / NSIS) directly.
 *
 * In dev / unsigned builds this just opens a friendly dialog explaining
 * that auto-update is unavailable and pointing at the releases page.
 *
 * IMPORTANT: this function must never throw synchronously. The Electron
 * menu-click dispatcher treats a synchronous throw from a click handler
 * as a failed action invocation, and macOS surfaces that to the user as
 * the cryptic system alert "this command is disabled and cannot be
 * executed". All known throw sites (native `autoUpdater.checkForUpdates()`
 * without a feed URL, `dialog.showMessageBox(null, ...)`) are caught and
 * converted into user-visible dialogs.
 */
export async function checkForUpdatesInteractive(
  parent: BrowserWindow | null,
): Promise<void> {
  const owner = resolveParent(parent);

  if (!app.isPackaged) {
    const { response } = await safeMessageBox(owner, {
      type: 'info',
      message: 'Auto-update is only available in installed builds.',
      detail:
        'You are running a development build. Download a release from ' +
        `https://github.com/${REPO}/releases`,
      buttons: ['Open Releases', 'OK'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) await shell.openExternal(`https://github.com/${REPO}/releases`);
    return;
  }

  if (process.platform === 'linux') {
    // Squirrel doesn't ship Linux updates; route Linux users to the
    // releases page rather than throw.
    const { response } = await safeMessageBox(owner, {
      type: 'info',
      message: 'Linux updates are delivered via .deb / .rpm packages.',
      detail: `Grab the latest from https://github.com/${REPO}/releases`,
      buttons: ['Open Releases', 'OK'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) await shell.openExternal(`https://github.com/${REPO}/releases`);
    return;
  }

  if (!feedURLReady) {
    // configureAutoUpdater() never completed (e.g. unsigned packaged build
    // where `updateElectronApp` threw because Squirrel.Mac refused the feed).
    // Calling autoUpdater.checkForUpdates() here would throw "Update feed URL
    // is not set" synchronously and trip the macOS "disabled" alert. Bail
    // out gracefully instead.
    await safeMessageBox(owner, {
      type: 'warning',
      message: 'Update service unavailable.',
      detail:
        `This build of Restream Chat++ ${app.getVersion()} is not connected to the update feed. ` +
        `Download the latest release from https://github.com/${REPO}/releases instead.`,
      buttons: ['OK'],
    });
    return;
  }

  if (checkInFlight) {
    log.info('[updater] check already in flight, ignoring duplicate click');
    return;
  }
  checkInFlight = true;

  try {
    // Lazy require to avoid pulling Electron's autoUpdater into module
    // scope until the menu is actually clicked.
    const { autoUpdater } = await import('electron');

    // Settle the flow via the next emitted event. `update-not-available`,
    // `update-downloaded`, or `error` are guaranteed to fire after a
    // `checkForUpdates()` call on a configured autoUpdater.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      checkInFlight = false;
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('error', onError);
    };

    const onNotAvailable = () => {
      settle();
      void safeMessageBox(owner, {
        type: 'info',
        message: `You're on the latest version (${app.getVersion()}).`,
        buttons: ['OK'],
      });
    };
    const onAvailable = () => {
      // `update-electron-app`'s `notifyUser: true` already wires the
      // restart-to-update dialog on `update-downloaded`. We just need to
      // tell the user the download has started.
      settle();
      void safeMessageBox(owner, {
        type: 'info',
        message: 'An update is available and is downloading in the background.',
        detail: "You'll be prompted to restart once the download completes.",
        buttons: ['OK'],
      });
    };
    const onError = (err: Error) => {
      settle();
      log.error('[updater] check-now error', err);
      void safeMessageBox(owner, {
        type: 'warning',
        message: 'Update check failed.',
        detail: String(err?.message ?? err),
        buttons: ['OK'],
      });
    };

    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('error', onError);

    // Time out after 30s so the menu doesn't stay "in flight" forever on a
    // silently-stalled network request.
    setTimeout(() => {
      if (settled) return;
      settle();
      void safeMessageBox(owner, {
        type: 'warning',
        message: 'Update check timed out.',
        detail: 'The update service did not respond in time. Try again later.',
        buttons: ['OK'],
      });
    }, 30_000);

    autoUpdater.checkForUpdates();
  } catch (err) {
    checkInFlight = false;
    log.error('[updater] interactive check failed', err);
    await safeMessageBox(owner, {
      type: 'warning',
      message: 'Update check failed.',
      detail: String((err as Error)?.message ?? err),
      buttons: ['OK'],
    });
  }
}
