import { describe, expect, it, vi } from 'vitest';
import {
  UpdateController,
  UPDATE_CHECK_RETRY_DELAYS_MS,
  UPDATE_DOWNLOAD_RETRY_DELAYS_MS,
  UPDATE_INSTALL_RESTART_TIMEOUT_MS,
  categoriseUpdateError,
  type LatestRelease,
} from '../main/update-controller';
import type { UpdateInfo } from '../shared/types';

function harness(overrides: {
  autoCheckEnabled?: boolean;
  nativeReady?: boolean;
  fetchLatestRelease?: () => Promise<LatestRelease>;
} = {}) {
  const published: UpdateInfo[] = [];
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let now = 1_000;
  const startNativeDownload = vi.fn();
  const installNativeUpdate = vi.fn();
  const waits: number[] = [];
  const fetchLatestRelease =
    overrides.fetchLatestRelease ??
    vi.fn(async () => ({
      version: '0.1.108',
      releaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.108',
    }));
  const controller = new UpdateController({
    currentVersion: () => '0.1.107',
    autoCheckEnabled: () => overrides.autoCheckEnabled ?? true,
    nativeUpdaterReady: () => overrides.nativeReady ?? true,
    fetchLatestRelease,
    startNativeDownload,
    installNativeUpdate,
    publish: (info) => published.push(info),
    log: vi.fn(),
    recordError: vi.fn(),
    now: () => now++,
    wait: async (ms) => {
      waits.push(ms);
    },
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    cancelScheduled: (handle) => {
      (handle as unknown as { cancelled: boolean }).cancelled = true;
    },
  });
  return {
    controller,
    published,
    scheduled,
    waits,
    fetchLatestRelease,
    startNativeDownload,
    installNativeUpdate,
    runScheduled(index: number) {
      const entry = scheduled[index];
      if (!entry.cancelled) entry.fn();
    },
  };
}

describe('UpdateController: one visible updater state machine', () => {
  it('discovers an update without entering the native updater', async () => {
    const h = harness();
    const result = await h.controller.checkForUpdates(false);

    expect(result.kind).toBe('available');
    expect(result.latestVersion).toBe('0.1.108');
    expect(h.startNativeDownload).not.toHaveBeenCalled();
    expect(h.published.map((info) => info.kind)).toEqual([
      'checking',
      'available',
    ]);
  });

  it('publishes downloading before making exactly one native call', async () => {
    const h = harness();
    await h.controller.checkForUpdates(true);
    h.startNativeDownload.mockImplementation(() => {
      expect(h.controller.getStatus()?.kind).toBe('downloading');
    });

    expect(h.controller.startDownload()).toEqual({ ok: true, reason: 'started' });
    expect(h.startNativeDownload).toHaveBeenCalledTimes(1);
    expect(h.controller.getStatus()?.kind).toBe('downloading');

    expect(h.controller.startDownload()).toEqual({
      ok: true,
      reason: 'already-downloading',
    });
    expect(h.startNativeDownload).toHaveBeenCalledTimes(1);
  });

  it('never enters native updater when no release is available', async () => {
    const h = harness({
      fetchLatestRelease: async () => ({
        version: '0.1.107',
        releaseUrl: 'https://example.invalid/release',
      }),
    });
    await h.controller.checkForUpdates(true);

    expect(h.controller.startDownload()).toEqual({
      ok: false,
      reason: 'not-available',
    });
    expect(h.startNativeDownload).not.toHaveBeenCalled();
  });

  it('reports native unavailability without corrupting available state', async () => {
    const h = harness({ nativeReady: false });
    await h.controller.checkForUpdates(true);

    expect(h.controller.startDownload()).toEqual({
      ok: false,
      reason: 'native-updater-unavailable',
    });
    expect(h.controller.getStatus()?.kind).toBe('available');
  });

  it('publishes validated monotonic progress and a staged terminal state', async () => {
    const h = harness();
    await h.controller.checkForUpdates(true);
    h.controller.startDownload();
    h.controller.onNativeProgress({
      percent: 47.5,
      bytesPerSecond: 2_000,
      total: 10_000,
      transferred: 4_750,
    });
    h.controller.onNativeProgress({
      percent: 22,
      bytesPerSecond: -1,
      total: Number.NaN,
    });

    expect(h.controller.getStatus()).toMatchObject({
      kind: 'downloading',
      downloadPercent: 47.5,
      downloadBytesPerSecond: undefined,
      downloadBytesTotal: undefined,
    });

    h.controller.onNativeDownloaded('0.1.108');
    expect(h.controller.getStatus()).toMatchObject({
      kind: 'ready-to-install',
      latestVersion: '0.1.108',
    });
  });

  it('freezes metadata checks once a download is active or staged', async () => {
    const h = harness();
    await h.controller.checkForUpdates(true);
    h.controller.startDownload();
    const fetchCount = vi.mocked(h.fetchLatestRelease).mock.calls.length;

    expect((await h.controller.checkForUpdates(true)).kind).toBe('downloading');
    expect(vi.mocked(h.fetchLatestRelease).mock.calls.length).toBe(fetchCount);

    h.controller.onNativeDownloaded('0.1.108');
    expect((await h.controller.checkForUpdates(true)).kind).toBe(
      'ready-to-install',
    );
    expect(vi.mocked(h.fetchLatestRelease).mock.calls.length).toBe(fetchCount);
  });

  it('turns a feed disagreement into a visible actionable error', async () => {
    const h = harness();
    await h.controller.checkForUpdates(true);
    h.controller.startDownload();
    h.controller.onNativeNotAvailable();

    expect(h.controller.getStatus()).toMatchObject({
      kind: 'error',
      latestVersion: '0.1.108',
      errorCategory: 'unknown',
      errorReleaseUrl:
        'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.108',
    });
  });

  it('retries network download failures on the bounded ladder', async () => {
    const h = harness();
    await h.controller.checkForUpdates(true);
    h.controller.startDownload();

    for (let index = 0; index < UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length; index += 1) {
      h.controller.onNativeError(new Error('network timeout'));
      expect(h.scheduled[index].ms).toBe(UPDATE_DOWNLOAD_RETRY_DELAYS_MS[index]);
      expect(h.controller.getStatus()).toMatchObject({
        kind: 'downloading',
        downloadRetryAttempt: index + 1,
        downloadRetryMax: UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length,
      });
      h.runScheduled(index);
    }
    expect(h.startNativeDownload).toHaveBeenCalledTimes(4);

    h.controller.onNativeError(new Error('network timeout'));
    expect(h.controller.getStatus()).toMatchObject({
      kind: 'error',
      errorCategory: 'network',
    });
    expect(h.scheduled).toHaveLength(3);
  });

  it('does not retry signature or staging failures', async () => {
    const h = harness();
    await h.controller.checkForUpdates(true);
    h.controller.startDownload();
    h.controller.onNativeError(
      new Error('Code signature did not pass validation'),
    );

    expect(h.scheduled).toHaveLength(0);
    expect(h.controller.getStatus()).toMatchObject({
      kind: 'error',
      errorCategory: 'signature-mismatch',
    });
  });

  it('installs only from staged state and calls quitAndInstall once', async () => {
    const h = harness();
    expect(h.controller.install()).toEqual({
      ok: false,
      reason: 'no-update-downloaded',
    });
    await h.controller.checkForUpdates(true);
    h.controller.startDownload();
    h.controller.onNativeDownloaded('0.1.108');

    expect(h.controller.install()).toEqual({ ok: true });
    expect(h.controller.getStatus()?.kind).toBe('installing');
    expect(h.installNativeUpdate).not.toHaveBeenCalled();
    expect(h.controller.install()).toEqual({
      ok: true,
      reason: 'already-installing',
    });
    h.runScheduled(0);
    expect(h.installNativeUpdate).toHaveBeenCalledTimes(1);
    expect(h.scheduled[1].ms).toBe(UPDATE_INSTALL_RESTART_TIMEOUT_MS);
    h.runScheduled(1);
    expect(h.controller.getStatus()).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('did not restart'),
    });
  });

  it('coalesces overlapping metadata checks', async () => {
    let resolveRelease!: (release: LatestRelease) => void;
    const fetchLatestRelease = vi.fn(
      () =>
        new Promise<LatestRelease>((resolve) => {
          resolveRelease = resolve;
        }),
    );
    const h = harness({ fetchLatestRelease });
    const first = h.controller.checkForUpdates(true);
    const second = h.controller.checkForUpdates(true);
    expect(fetchLatestRelease).toHaveBeenCalledTimes(1);
    resolveRelease({
      version: '0.1.108',
      releaseUrl: 'https://example.invalid/v0.1.108',
    });
    expect(await first).toEqual(await second);
  });

  it('retries automatic release checks but not explicit checks', async () => {
    const automaticFetch = vi
      .fn<() => Promise<LatestRelease>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        version: '0.1.108',
        releaseUrl: 'https://example.invalid/v0.1.108',
      });
    const automatic = harness({ fetchLatestRelease: automaticFetch });
    expect((await automatic.controller.checkForUpdates(false)).kind).toBe(
      'available',
    );
    expect(automatic.waits).toEqual([...UPDATE_CHECK_RETRY_DELAYS_MS]);

    const explicitFetch = vi.fn(async () => {
      throw new Error('offline');
    });
    const explicit = harness({ fetchLatestRelease: explicitFetch });
    expect((await explicit.controller.checkForUpdates(true)).kind).toBe('error');
    expect(explicitFetch).toHaveBeenCalledTimes(1);
    expect(explicit.waits).toEqual([]);
  });

  it('honours disabled automatic checks without fetching', async () => {
    const h = harness({ autoCheckEnabled: false });
    expect((await h.controller.checkForUpdates(false)).kind).toBe('disabled');
    expect(h.fetchLatestRelease).not.toHaveBeenCalled();
  });
});

describe('updater error categorisation', () => {
  it('distinguishes non-retryable and transient classes', () => {
    expect(categoriseUpdateError('code signature did not pass validation')).toBe(
      'signature-mismatch',
    );
    expect(categoriseUpdateError('ShipIt staging EPERM')).toBe('staging');
    expect(categoriseUpdateError('connect ETIMEDOUT')).toBe('network');
    expect(categoriseUpdateError('unexpected state')).toBe('unknown');
  });
});
