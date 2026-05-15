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

import { app, BrowserWindow, dialog } from 'electron';
import log from 'electron-log/main';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';

const REPO = 'EthanSK/restream-chat-plus-plus';

let configured = false;

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
    log.info('[updater] auto-update configured for', REPO);
  } catch (err) {
    log.error('[updater] failed to configure auto-update', err);
  }
}

/**
 * Triggered by the "Check for Updates…" menu item. `update-electron-app`
 * doesn't expose a programmatic "check now" hook, so we rely on the
 * underlying `electron.autoUpdater` (Squirrel.Mac / NSIS) directly.
 *
 * In dev / unsigned builds this just opens a friendly dialog explaining
 * that auto-update is unavailable and pointing at the releases page.
 */
export async function checkForUpdatesInteractive(
  parent: BrowserWindow | null,
): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox(parent as BrowserWindow, {
      type: 'info',
      message: 'Auto-update is only available in installed builds.',
      detail:
        'You are running a development build. Download a release from ' +
        `https://github.com/${REPO}/releases`,
      buttons: ['OK'],
    });
    return;
  }

  // Trigger the same update check the periodic poller does. The dialog
  // wired by `update-electron-app` will pop if an update is available.
  try {
    // Lazy require to avoid pulling Electron's autoUpdater into module
    // scope until the menu is actually clicked.
    const { autoUpdater } = await import('electron');
    autoUpdater.once('update-not-available', () => {
      void dialog.showMessageBox(parent as BrowserWindow, {
        type: 'info',
        message: `You're on the latest version (${app.getVersion()}).`,
        buttons: ['OK'],
      });
    });
    autoUpdater.once('error', (err) => {
      log.error('[updater] check-now error', err);
      void dialog.showMessageBox(parent as BrowserWindow, {
        type: 'warning',
        message: 'Update check failed.',
        detail: String(err?.message ?? err),
        buttons: ['OK'],
      });
    });
    autoUpdater.checkForUpdates();
  } catch (err) {
    log.error('[updater] interactive check failed', err);
  }
}
