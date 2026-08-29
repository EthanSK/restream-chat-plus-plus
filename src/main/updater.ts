import { app, autoUpdater, BrowserWindow, dialog, shell } from 'electron';
import log from 'electron-log/main';
import { IPC, type UpdateInfo } from '../shared/types';
import { appendErrorLog, errorToString } from './structured-log';
import {
  UpdateController,
  categoriseUpdateError,
  UPDATE_DOWNLOAD_RETRY_DELAYS_MS,
  type LatestRelease,
} from './update-controller';

const REPO = 'EthanSK/restream-chat-plus-plus';
const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const UPDATE_RELEASE_PAGE_URL = `https://github.com/${REPO}/releases`;
export const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 3_000;
const RELEASE_REQUEST_TIMEOUT_MS = 15_000;

let configured = false;
let feedURLReady = false;
let nativeListenersAttached = false;
let autoCheckEnabled: () => boolean = () => true;
let firstCheckTimer: ReturnType<typeof setTimeout> | undefined;
let intervalTimer: ReturnType<typeof setInterval> | undefined;
let interactiveCheckInFlight = false;

function publish(info: UpdateInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.UPDATE_STATUS, info);
    } catch (error) {
      log.error('[updater] status broadcast failed', error);
    }
  }
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), RELEASE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RELEASES_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `restream-chat-plus-plus/${app.getVersion()}`,
      },
      signal: abort.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }
    const json: unknown = await response.json();
    const record =
      json && typeof json === 'object'
        ? (json as Record<string, unknown>)
        : undefined;
    const tag = typeof record?.tag_name === 'string' ? record.tag_name : '';
    if (!tag) throw new Error('GitHub API response missing tag_name');
    return {
      version: tag.replace(/^v/i, ''),
      releaseUrl:
        typeof record?.html_url === 'string'
          ? record.html_url
          : UPDATE_RELEASE_PAGE_URL,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const controller = new UpdateController({
  currentVersion: () => app.getVersion(),
  autoCheckEnabled: () => autoCheckEnabled(),
  nativeUpdaterReady: () =>
    app.isPackaged && process.platform !== 'linux' && feedURLReady,
  fetchLatestRelease,
  startNativeDownload: () => {
    log.info('[updater] starting one native download session');
    autoUpdater.checkForUpdates();
  },
  installNativeUpdate: () => {
    log.info('[updater] applying staged update with quitAndInstall');
    autoUpdater.quitAndInstall();
  },
  publish,
  log: (level, message, detail) => {
    if (detail === undefined) log[level](message);
    else log[level](message, detail);
  },
  recordError: (phase, error, context) => {
    appendErrorLog({
      subsystem: 'updater',
      phase,
      errorMessage: errorToString(error),
      context,
    });
  },
});

function attachNativeListeners(): void {
  if (nativeListenersAttached) return;
  nativeListenersAttached = true;

  autoUpdater.on('checking-for-update', () => controller.onNativeChecking());
  autoUpdater.on('update-available', () => controller.onNativeUpdateAvailable());
  autoUpdater.on('update-not-available', () => controller.onNativeNotAvailable());
  autoUpdater.on('error', (error) => controller.onNativeError(error));
  autoUpdater.on(
    'update-downloaded',
    (_event, _releaseNotes, releaseName) =>
      controller.onNativeDownloaded(
        typeof releaseName === 'string' ? releaseName : undefined,
      ),
  );
  (autoUpdater as unknown as NodeJS.EventEmitter).on(
    'download-progress',
    (progress?: {
      percent?: number;
      bytesPerSecond?: number;
      total?: number;
      transferred?: number;
    }) => controller.onNativeProgress(progress),
  );
}

/** Configure Squirrel once. This never starts a check or download. */
export function configureAutoUpdater(): void {
  if (configured) return;
  configured = true;
  if (!app.isPackaged || process.platform === 'linux') {
    log.info('[updater] native updater unavailable for this build/platform');
    return;
  }
  try {
    const windowsStoreSegment = process.windowsStore ? '/msix' : '';
    const feedURL =
      `https://update.electronjs.org/${REPO}/` +
      `${process.platform}-${process.arch}${windowsStoreSegment}/${app.getVersion()}`;
    autoUpdater.setFeedURL({
      url: feedURL,
      headers: {
        'User-Agent':
          `restream-chat-plus-plus/${app.getVersion()} ` +
          `(${process.platform}: ${process.arch})`,
      },
    });
    feedURLReady = true;
    attachNativeListeners();
    log.info('[updater] native updater configured; waiting for explicit download');
  } catch (error) {
    feedURLReady = false;
    log.error('[updater] native updater configuration failed', error);
    appendErrorLog({
      subsystem: 'updater',
      phase: 'updater.configure-failed',
      errorMessage: errorToString(error),
    });
  }
}

/** Start metadata-only update discovery. Native Squirrel remains idle. */
export function startUpdatePoller(getter: () => boolean): void {
  autoCheckEnabled = getter;
  if (firstCheckTimer || intervalTimer) return;
  firstCheckTimer = setTimeout(() => {
    firstCheckTimer = undefined;
    void controller.checkForUpdates(false);
  }, FIRST_CHECK_DELAY_MS);
  firstCheckTimer.unref?.();
  intervalTimer = setInterval(() => {
    void controller.checkForUpdates(false);
  }, AUTO_UPDATE_INTERVAL_MS);
  intervalTimer.unref?.();
  log.info('[updater] metadata poller armed; native download is user-initiated');
}

export function stopUpdatePoller(): void {
  if (firstCheckTimer) clearTimeout(firstCheckTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstCheckTimer = undefined;
  intervalTimer = undefined;
  controller.dispose();
}

export function performUpdateCheck(force = false): Promise<UpdateInfo> {
  return controller.checkForUpdates(force);
}

export function getLastUpdateInfo(): UpdateInfo | undefined {
  return controller.getStatus();
}

export type UpdateDownloadState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready-to-install'
  | 'installing'
  | 'error';

export function getDownloadState(): {
  state: UpdateDownloadState;
  pendingVersion: string | undefined;
  downloadStartedAt: number | undefined;
  lastErrorMessage: string | undefined;
  lastErrorCategory:
    | 'signature-mismatch'
    | 'network'
    | 'staging'
    | 'unknown'
    | undefined;
} {
  const info = controller.getStatus();
  const state: UpdateDownloadState =
    info?.kind === 'checking' ||
    info?.kind === 'downloading' ||
    info?.kind === 'ready-to-install' ||
    info?.kind === 'installing' ||
    info?.kind === 'error'
      ? info.kind
      : 'idle';
  return {
    state,
    pendingVersion: info?.latestVersion,
    downloadStartedAt: info?.downloadStartedAt,
    lastErrorMessage: info?.kind === 'error' ? info.error : undefined,
    lastErrorCategory:
      info?.kind === 'error' ? info.errorCategory : undefined,
  };
}

export type StartDownloadResult =
  | { ok: true; reason: 'started'; mode: 'squirrel' }
  | { ok: true; reason: 'already-downloading'; mode: 'squirrel' }
  | { ok: true; reason: 'already-staged'; mode: 'squirrel' }
  | {
      ok: true;
      reason: 'opened-release-page';
      mode: 'browser';
      fallbackReason: string;
    }
  | {
      ok: false;
      reason:
        | 'not-packaged'
        | 'unsupported-platform'
        | 'feed-unavailable'
        | 'not-available'
        | 'error';
      error?: string;
      releaseUrl: string;
    };

export function triggerSquirrelDownload(): StartDownloadResult {
  if (!app.isPackaged) {
    return {
      ok: false,
      reason: 'not-packaged',
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
  if (process.platform === 'linux') {
    return {
      ok: false,
      reason: 'unsupported-platform',
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
  if (!feedURLReady) {
    return {
      ok: false,
      reason: 'feed-unavailable',
      releaseUrl: UPDATE_RELEASE_PAGE_URL,
    };
  }
  const result = controller.startDownload();
  if (result.ok) {
    if (result.reason === 'already-downloading') {
      return { ok: true, reason: 'already-downloading', mode: 'squirrel' };
    }
    if (result.reason === 'already-staged') {
      return { ok: true, reason: 'already-staged', mode: 'squirrel' };
    }
    return { ok: true, reason: 'started', mode: 'squirrel' };
  }
  return {
    ok: false,
    reason: result.reason === 'not-available' ? 'not-available' : 'error',
    error: result.error,
    releaseUrl: UPDATE_RELEASE_PAGE_URL,
  };
}

export function quitAndInstallStagedUpdate(): {
  ok: boolean;
  reason?: string;
} {
  return controller.install();
}

export function triggerInstallNow(): { ok: boolean; reason?: string } {
  return quitAndInstallStagedUpdate();
}

export const categoriseUpdaterError = categoriseUpdateError;
export const DOWNLOAD_RETRY_DELAYS_MS = UPDATE_DOWNLOAD_RETRY_DELAYS_MS;
export const DOWNLOAD_RETRY_MAX = UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length;

function resolveParent(candidate: BrowserWindow | null): BrowserWindow | undefined {
  if (candidate && !candidate.isDestroyed()) return candidate;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  const first = BrowserWindow.getAllWindows()[0];
  return first && !first.isDestroyed() ? first : undefined;
}

async function safeMessageBox(
  parent: BrowserWindow | undefined,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  try {
    return parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
  } catch (error) {
    log.error('[updater] message box failed', error);
    return { response: -1, checkboxChecked: false };
  }
}

/** Manual menu flow backed by the same state machine as the banner and MCP. */
export async function checkForUpdatesInteractive(
  parent: BrowserWindow | null,
): Promise<void> {
  if (interactiveCheckInFlight) {
    log.info('[updater] duplicate interactive check coalesced');
    return;
  }
  interactiveCheckInFlight = true;
  try {
    const info = await controller.checkForUpdates(true);
    const owner = resolveParent(parent);
    if (info.kind === 'available') {
      const { response } = await safeMessageBox(owner, {
        type: 'info',
        message: `Update available (${info.latestVersion}).`,
        detail:
          `You're running ${info.currentVersion}. Downloading starts only ` +
          'when you choose Download Update, and progress will stay visible.',
        buttons: ['Download Update', 'Later', 'Open GitHub Releases'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        const result = triggerSquirrelDownload();
        if (!result.ok) {
          await shell.openExternal(info.releaseUrl ?? UPDATE_RELEASE_PAGE_URL);
        }
      } else if (response === 2) {
        await shell.openExternal(info.releaseUrl ?? UPDATE_RELEASE_PAGE_URL);
      }
      return;
    }
    if (info.kind === 'downloading') {
      await safeMessageBox(owner, {
        type: 'info',
        message: 'The update is downloading.',
        detail: 'Progress is shown in the main window.',
        buttons: ['OK'],
      });
      return;
    }
    if (info.kind === 'ready-to-install' || info.kind === 'installing') {
      await safeMessageBox(owner, {
        type: 'info',
        message:
          info.kind === 'installing'
            ? 'The update is being installed.'
            : 'The update is ready to install.',
        detail:
          info.kind === 'ready-to-install'
            ? 'Use Restart & Install in the main window when you are ready.'
            : undefined,
        buttons: ['OK'],
      });
      return;
    }
    if (info.kind === 'up-to-date') {
      await safeMessageBox(owner, {
        type: 'info',
        message: `You're on the latest version (${info.currentVersion}).`,
        buttons: ['OK'],
      });
      return;
    }
    if (info.kind === 'error') {
      await safeMessageBox(owner, {
        type: 'warning',
        message: 'Update check failed.',
        detail: info.error ?? 'Unknown error.',
        buttons: ['OK'],
      });
    }
  } catch (error) {
    log.error('[updater] interactive check failed', error);
  } finally {
    interactiveCheckInFlight = false;
  }
}
