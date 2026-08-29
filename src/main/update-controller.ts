import type { UpdateInfo } from '../shared/types';
import { isNewerVersion } from '../shared/version';

export type UpdateErrorCategory =
  | 'signature-mismatch'
  | 'network'
  | 'staging'
  | 'unknown';

export interface LatestRelease {
  version: string;
  releaseUrl: string;
}

export interface UpdateControllerDependencies {
  currentVersion: () => string;
  autoCheckEnabled: () => boolean;
  nativeUpdaterReady: () => boolean;
  fetchLatestRelease: () => Promise<LatestRelease>;
  startNativeDownload: () => void;
  installNativeUpdate: () => void;
  publish: (info: UpdateInfo) => void;
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
  recordError: (phase: string, error: unknown, context?: Record<string, string>) => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancelScheduled?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface DownloadStartResult {
  ok: boolean;
  reason:
    | 'started'
    | 'already-downloading'
    | 'already-staged'
    | 'not-available'
    | 'native-updater-unavailable'
    | 'error';
  error?: string;
}

export const UPDATE_CHECK_RETRY_DELAYS_MS = [10_000, 30_000] as const;
export const UPDATE_DOWNLOAD_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
export const UPDATE_INSTALL_RESTART_TIMEOUT_MS = 10_000;

export function categoriseUpdateError(raw: unknown): UpdateErrorCategory {
  const message =
    typeof raw === 'string'
      ? raw
      : typeof (raw as Error | undefined)?.message === 'string'
        ? (raw as Error).message
        : String(raw ?? '');
  const lower = message.toLowerCase();
  if (
    lower.includes('code signature') ||
    lower.includes('code requirement') ||
    lower.includes('codesign') ||
    lower.includes('team identifier') ||
    lower.includes('not pass validation') ||
    lower.includes('not signed') ||
    lower.includes('signature is missing')
  ) {
    return 'signature-mismatch';
  }
  if (
    lower.includes('shipit') ||
    lower.includes('install failed') ||
    lower.includes('no such file') ||
    lower.includes('permission') ||
    lower.includes('staging') ||
    lower.includes('eperm') ||
    lower.includes('enoent') ||
    lower.includes('disk full')
  ) {
    return 'staging';
  }
  if (
    lower.includes('connect') ||
    lower.includes('network') ||
    lower.includes('offline') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('socket') ||
    lower.includes('tls') ||
    lower.includes('certificate') ||
    lower.includes('http') ||
    lower.includes('dns')
  ) {
    return 'network';
  }
  return 'unknown';
}

function errorMessage(error: unknown): string {
  return String((error as Error | undefined)?.message ?? error ?? 'Unknown updater error');
}

/**
 * The one authoritative updater state machine.
 *
 * GitHub release discovery and Squirrel installation are deliberately two
 * adapters behind this controller, not two independently broadcasting flows.
 * A background check can only discover an update. Only an explicit download
 * request enters Squirrel, and the controller publishes `downloading` before
 * that native call so the available button can never remain stale.
 */
export class UpdateController {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly schedule: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly cancelScheduled: (
    handle: ReturnType<typeof setTimeout>,
  ) => void;

  private lastInfo: UpdateInfo | undefined;
  private checkPromise: Promise<UpdateInfo> | undefined;
  private retryHandle: ReturnType<typeof setTimeout> | undefined;
  private downloadRetryAttempt = 0;
  private installRequested = false;

  constructor(private readonly deps: UpdateControllerDependencies) {
    this.now = deps.now ?? Date.now;
    this.wait =
      deps.wait ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelScheduled = deps.cancelScheduled ?? clearTimeout;
  }

  getStatus(): UpdateInfo | undefined {
    return this.lastInfo ? { ...this.lastInfo } : undefined;
  }

  async checkForUpdates(force = false): Promise<UpdateInfo> {
    if (
      this.lastInfo?.kind === 'downloading' ||
      this.lastInfo?.kind === 'ready-to-install' ||
      this.lastInfo?.kind === 'installing'
    ) {
      this.deps.log(
        'info',
        `[updater] check skipped while state=${this.lastInfo.kind}`,
      );
      return { ...this.lastInfo };
    }
    if (this.checkPromise) return this.checkPromise;

    if (!force && !this.deps.autoCheckEnabled()) {
      return this.setStatus({
        kind: 'disabled',
        currentVersion: this.deps.currentVersion(),
        checkedAt: this.now(),
      });
    }

    this.checkPromise = this.runCheck(force).finally(() => {
      this.checkPromise = undefined;
    });
    return this.checkPromise;
  }

  private async runCheck(force: boolean): Promise<UpdateInfo> {
    const currentVersion = this.deps.currentVersion();
    this.setStatus({ kind: 'checking', currentVersion, checkedAt: this.now() });
    const retryDelays = force ? [] : [...UPDATE_CHECK_RETRY_DELAYS_MS];

    for (let attempt = 0; ; attempt += 1) {
      try {
        const release = await this.deps.fetchLatestRelease();
        if (isNewerVersion(release.version, currentVersion)) {
          return this.setStatus({
            kind: 'available',
            currentVersion,
            latestVersion: release.version,
            releaseUrl: release.releaseUrl,
            checkedAt: this.now(),
          });
        }
        return this.setStatus({
          kind: 'up-to-date',
          currentVersion,
          checkedAt: this.now(),
        });
      } catch (error) {
        const retryDelay = retryDelays[attempt];
        if (retryDelay !== undefined) {
          this.deps.log(
            'warn',
            `[updater] release check failed; retrying in ${retryDelay}ms`,
            error,
          );
          await this.wait(retryDelay);
          continue;
        }
        this.deps.recordError('updater.release-check-failed', error);
        return this.setStatus({
          kind: 'error',
          currentVersion,
          error: errorMessage(error),
          checkedAt: this.now(),
        });
      }
    }
  }

  startDownload(): DownloadStartResult {
    if (this.lastInfo?.kind === 'downloading') {
      return { ok: true, reason: 'already-downloading' };
    }
    if (
      this.lastInfo?.kind === 'ready-to-install' ||
      this.lastInfo?.kind === 'installing'
    ) {
      return { ok: true, reason: 'already-staged' };
    }
    if (
      this.lastInfo?.kind !== 'available' &&
      this.lastInfo?.kind !== 'error'
    ) {
      return { ok: false, reason: 'not-available' };
    }
    if (!this.lastInfo.latestVersion || !this.lastInfo.releaseUrl) {
      return { ok: false, reason: 'not-available' };
    }
    if (!this.deps.nativeUpdaterReady()) {
      return { ok: false, reason: 'native-updater-unavailable' };
    }

    const latestVersion = this.lastInfo.latestVersion;
    const releaseUrl = this.lastInfo.releaseUrl;
    this.cancelDownloadRetry();
    this.downloadRetryAttempt = 0;
    this.installRequested = false;
    this.setStatus({
      kind: 'downloading',
      currentVersion: this.deps.currentVersion(),
      latestVersion,
      releaseUrl,
      downloadStartedAt: this.now(),
      checkedAt: this.now(),
    });

    try {
      this.deps.startNativeDownload();
      return { ok: true, reason: 'started' };
    } catch (error) {
      this.failDownload(error);
      return { ok: false, reason: 'error', error: errorMessage(error) };
    }
  }

  onNativeChecking(): void {
    if (this.lastInfo?.kind !== 'downloading') return;
    this.deps.log('info', '[updater] native updater accepted download request');
  }

  onNativeUpdateAvailable(): void {
    if (this.lastInfo?.kind !== 'downloading') return;
    this.deps.log('info', '[updater] native updater found installable bundle');
  }

  onNativeProgress(progress?: {
    percent?: number;
    bytesPerSecond?: number;
    total?: number;
    transferred?: number;
  }): void {
    if (this.lastInfo?.kind !== 'downloading') return;
    const finiteNonNegative = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const rawPercent = finiteNonNegative(progress?.percent);
    const previousPercent = this.lastInfo.downloadPercent ?? 0;
    const nextPercent =
      rawPercent === undefined
        ? this.lastInfo.downloadPercent
        : Math.max(previousPercent, Math.min(100, rawPercent));
    this.setStatus({
      ...this.lastInfo,
      kind: 'downloading',
      downloadPercent: nextPercent,
      downloadBytesPerSecond: finiteNonNegative(progress?.bytesPerSecond),
      downloadBytesTotal: finiteNonNegative(progress?.total),
      downloadBytesTransferred: finiteNonNegative(progress?.transferred),
      downloadRetryAttempt: undefined,
      downloadRetryMax: undefined,
      checkedAt: this.now(),
    });
  }

  onNativeDownloaded(releaseName?: string): void {
    if (
      this.lastInfo?.kind !== 'downloading' &&
      this.lastInfo?.kind !== 'error'
    ) {
      this.deps.log(
        'warn',
        `[updater] ignored update-downloaded while state=${this.lastInfo?.kind ?? 'idle'}`,
      );
      return;
    }
    this.cancelDownloadRetry();
    this.downloadRetryAttempt = 0;
    const latestVersion =
      this.lastInfo.latestVersion || releaseName?.replace(/^v/i, '');
    this.setStatus({
      kind: 'ready-to-install',
      currentVersion: this.deps.currentVersion(),
      latestVersion,
      releaseUrl: this.lastInfo.releaseUrl,
      checkedAt: this.now(),
    });
  }

  onNativeNotAvailable(): void {
    if (this.lastInfo?.kind !== 'downloading') return;
    const message =
      `Release ${this.lastInfo.latestVersion ?? '(unknown)'} exists, but the ` +
      'native update feed did not provide an installable bundle.';
    this.failDownload(new Error(message), false);
  }

  onNativeError(error: unknown): void {
    if (this.lastInfo?.kind !== 'downloading') {
      this.deps.log('warn', '[updater] native updater error outside download', error);
      return;
    }
    this.failDownload(error);
  }

  private failDownload(error: unknown, allowRetry = true): void {
    if (this.lastInfo?.kind !== 'downloading') return;
    const category = categoriseUpdateError(error);
    const message = errorMessage(error);
    this.deps.recordError('updater.native-download-failed', error, { category });

    if (
      allowRetry &&
      category === 'network' &&
      this.downloadRetryAttempt < UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length
    ) {
      const delay = UPDATE_DOWNLOAD_RETRY_DELAYS_MS[this.downloadRetryAttempt];
      this.downloadRetryAttempt += 1;
      this.setStatus({
        ...this.lastInfo,
        kind: 'downloading',
        error: undefined,
        errorCategory: undefined,
        downloadRetryAttempt: this.downloadRetryAttempt,
        downloadRetryMax: UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length,
        checkedAt: this.now(),
      });
      this.deps.log(
        'warn',
        `[updater] download failed; retry ${this.downloadRetryAttempt}/${UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length} in ${delay}ms`,
        error,
      );
      this.retryHandle = this.schedule(() => {
        this.retryHandle = undefined;
        if (this.lastInfo?.kind !== 'downloading') return;
        try {
          this.deps.startNativeDownload();
        } catch (retryError) {
          this.failDownload(retryError);
        }
      }, delay);
      return;
    }

    this.cancelDownloadRetry();
    this.setStatus({
      kind: 'error',
      currentVersion: this.deps.currentVersion(),
      latestVersion: this.lastInfo.latestVersion,
      releaseUrl: this.lastInfo.releaseUrl,
      error: message,
      errorCategory: category,
      errorReleaseUrl: this.lastInfo.releaseUrl,
      checkedAt: this.now(),
    });
  }

  install(): { ok: boolean; reason?: string } {
    if (this.installRequested || this.lastInfo?.kind === 'installing') {
      return { ok: true, reason: 'already-installing' };
    }
    if (this.lastInfo?.kind !== 'ready-to-install') {
      return { ok: false, reason: 'no-update-downloaded' };
    }
    this.installRequested = true;
    this.setStatus({
      ...this.lastInfo,
      kind: 'installing',
      checkedAt: this.now(),
    });
    this.schedule(() => {
      try {
        this.deps.installNativeUpdate();
        // A successful Squirrel handoff terminates this process almost
        // immediately. If we are still alive after the bounded timeout, do
        // not force-relaunch the old bundle: surface a real failure instead.
        this.schedule(() => {
          if (this.lastInfo?.kind !== 'installing') return;
          this.installRequested = false;
          const message =
            'The native installer did not restart Restream Chat++. Install the release manually from GitHub.';
          this.deps.recordError(
            'updater.native-install-did-not-restart',
            new Error(message),
          );
          this.setStatus({
            kind: 'error',
            currentVersion: this.deps.currentVersion(),
            latestVersion: this.lastInfo.latestVersion,
            releaseUrl: this.lastInfo.releaseUrl,
            error: message,
            errorCategory: 'unknown',
            errorReleaseUrl: this.lastInfo.releaseUrl,
            checkedAt: this.now(),
          });
        }, UPDATE_INSTALL_RESTART_TIMEOUT_MS);
      } catch (error) {
        this.installRequested = false;
        this.deps.recordError('updater.native-install-failed', error);
        this.setStatus({
          kind: 'error',
          currentVersion: this.deps.currentVersion(),
          latestVersion: this.lastInfo?.latestVersion,
          releaseUrl: this.lastInfo?.releaseUrl,
          error: errorMessage(error),
          errorCategory: categoriseUpdateError(error),
          errorReleaseUrl: this.lastInfo?.releaseUrl,
          checkedAt: this.now(),
        });
      }
    }, 0);
    return { ok: true };
  }

  dispose(): void {
    this.cancelDownloadRetry();
  }

  private cancelDownloadRetry(): void {
    if (this.retryHandle !== undefined) {
      this.cancelScheduled(this.retryHandle);
      this.retryHandle = undefined;
    }
  }

  private setStatus(info: UpdateInfo): UpdateInfo {
    this.lastInfo = { ...info };
    this.deps.publish({ ...info });
    return { ...info };
  }
}
