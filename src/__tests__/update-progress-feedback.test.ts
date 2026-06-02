/**
 * v0.1.61 — visible-feedback fixes for the Install Update flow.
 *
 * Three behaviour deltas pinned here:
 *
 *   1. `triggerSquirrelDownload()` now broadcasts a `kind: 'downloading'`
 *      UpdateInfo IMMEDIATELY (before `autoUpdater.checkForUpdates()` is
 *      called) so the banner flips out of `available` state right away.
 *      Pre-v0.1.61 the banner stayed in `available` for several seconds
 *      while the 3s toast auto-dismissed, leaving the user with dead air
 *      — exactly Ethan's "I get a snap about downloading update, but then
 *      nothing happens" voice note (2026-05-23, Voice 3760).
 *
 *   2. The Squirrel `error` event now broadcasts a `kind: 'error'`
 *      UpdateInfo with `errorCategory` + `errorReleaseUrl` populated so
 *      the renderer can show a persistent error pane with a manual-
 *      fallback "Open GitHub Releases" button. Pre-v0.1.61 the handler
 *      only logged + reset state; the renderer never heard about the
 *      failure. Root cause of the silent failure on Ethan's MBP today:
 *      ad-hoc-signed v0.1.59 + Developer-ID-signed v0.1.60 staged →
 *      Squirrel's `SecCodeCheckValidity` rejects the swap → 22s later
 *      the `error` event fires with "Code signature ... did not pass
 *      validation" → user saw nothing because the broadcast was missing.
 *
 *   3. The `download-progress` event now forwards `bytesPerSecond`,
 *      `total`, and `transferred` fields (not just `percent`) so the
 *      banner can show concrete download activity (KB/s + bytes-
 *      downloaded / bytes-total) instead of just an integer percent
 *      that might sit at 0 for 30+ seconds.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock setup mirrors `update-flow-fixes.test.ts` so we can drive the
// updater module without a real Electron runtime.
const fakeAutoUpdater = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const listeners: Record<string, Handler[]> = {};
  return {
    listeners,
    on: vi.fn((evt: string, h: Handler) => {
      (listeners[evt] ??= []).push(h);
    }),
    emit: (evt: string, ...args: unknown[]) => {
      (listeners[evt] ?? []).forEach((h) => h(...args));
    },
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  };
});

const sentMessages = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);

const fakeWindow = vi.hoisted(() => ({
  webContents: {
    send: vi.fn((channel: string, payload: unknown) => {
      // capture every UPDATE_STATUS broadcast so the test suite can
      // assert what the renderer would have received.
      sentMessages.push({ channel, payload });
    }),
  },
}));

const fakeBrowserWindow = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [fakeWindow]),
  getFocusedWindow: vi.fn(() => null),
}));

const fakeApp = vi.hoisted(() => ({
  getVersion: vi.fn(() => '0.1.59'),
  isPackaged: true,
  relaunch: vi.fn(),
  exit: vi.fn(),
}));

const fakeShell = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

const fakeDialog = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
}));

vi.mock('electron', () => ({
  app: fakeApp,
  autoUpdater: fakeAutoUpdater,
  BrowserWindow: fakeBrowserWindow,
  dialog: fakeDialog,
  shell: fakeShell,
}));

const fakeUpdateElectronApp = vi.hoisted(() =>
  vi.fn((_opts: { notifyUser?: boolean }) => undefined),
);
vi.mock('update-electron-app', () => ({
  updateElectronApp: fakeUpdateElectronApp,
  UpdateSourceType: { ElectronPublicUpdateService: 'gh-service' },
}));

vi.mock('electron-log/main', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

async function loadUpdater() {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  for (const k of Object.keys(fakeAutoUpdater.listeners)) {
    delete fakeAutoUpdater.listeners[k];
  }
  fakeAutoUpdater.checkForUpdates.mockClear();
  fakeAutoUpdater.quitAndInstall.mockClear();
  fakeApp.relaunch.mockClear();
  fakeApp.exit.mockClear();
  fakeUpdateElectronApp.mockClear();
  fakeWindow.webContents.send.mockClear();
  sentMessages.length = 0;
  return await import('../main/updater');
}

interface SentBroadcast {
  channel: string;
  payload: {
    kind: string;
    downloadPercent?: number;
    downloadBytesTransferred?: number;
    downloadBytesTotal?: number;
    downloadBytesPerSecond?: number;
    downloadStartedAt?: number;
    latestVersion?: string;
    error?: string;
    errorCategory?: string;
    errorReleaseUrl?: string;
  };
}

function findBroadcasts(kind: string): SentBroadcast[] {
  return sentMessages.filter(
    (m) =>
      m.channel === 'update:status' &&
      (m.payload as { kind?: string })?.kind === kind,
  ) as SentBroadcast[];
}

describe('v0.1.61 — immediate downloading broadcast on Install Update click', () => {
  it('broadcasts kind:downloading synchronously when triggerSquirrelDownload fires', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.rememberPendingDownloadVersion('v0.1.60');

    // The broadcast must happen BEFORE autoUpdater.checkForUpdates(),
    // so the renderer sees the state transition before any further
    // Squirrel events fire.
    const result = updater.triggerSquirrelDownload();
    expect(result.ok).toBe(true);

    const downloadingBroadcasts = findBroadcasts('downloading');
    // At least one immediate broadcast from triggerSquirrelDownload()
    // itself (the `checking-for-update` event would add more — but
    // those only fire when something emits the event).
    expect(downloadingBroadcasts.length).toBeGreaterThan(0);
    const first = downloadingBroadcasts[0]!.payload;
    expect(first.kind).toBe('downloading');
    expect(first.latestVersion).toBe('v0.1.60');
    expect(typeof first.downloadStartedAt).toBe('number');
    expect((first.downloadStartedAt as number) > 0).toBe(true);
  });

  it('subsequent checking-for-update event also broadcasts downloading (banner stays consistent)', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.rememberPendingDownloadVersion('v0.1.60');
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    fakeAutoUpdater.emit('checking-for-update');

    const downloadingBroadcasts = findBroadcasts('downloading');
    expect(downloadingBroadcasts.length).toBe(1);
    expect(downloadingBroadcasts[0]!.payload.latestVersion).toBe('v0.1.60');
  });
});

describe('v0.1.61 — download-progress forwards bytes + speed', () => {
  it('forwards bytesPerSecond + total + transferred', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.rememberPendingDownloadVersion('v0.1.60');
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    fakeAutoUpdater.emit('download-progress', {
      percent: 42.7,
      bytesPerSecond: 1_234_567,
      total: 200_000_000,
      transferred: 85_400_000,
    });

    const broadcasts = findBroadcasts('downloading');
    expect(broadcasts.length).toBe(1);
    const p = broadcasts[0]!.payload;
    expect(p.downloadPercent).toBeCloseTo(42.7);
    expect(p.downloadBytesPerSecond).toBe(1_234_567);
    expect(p.downloadBytesTotal).toBe(200_000_000);
    expect(p.downloadBytesTransferred).toBe(85_400_000);
    expect(p.latestVersion).toBe('v0.1.60');
    expect(typeof p.downloadStartedAt).toBe('number');
  });

  it('handles missing optional fields gracefully (only percent reported)', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    fakeAutoUpdater.emit('download-progress', { percent: 17 });

    const broadcasts = findBroadcasts('downloading');
    expect(broadcasts.length).toBe(1);
    const p = broadcasts[0]!.payload;
    expect(p.downloadPercent).toBe(17);
    expect(p.downloadBytesPerSecond).toBeUndefined();
    expect(p.downloadBytesTotal).toBeUndefined();
    expect(p.downloadBytesTransferred).toBeUndefined();
  });

  it('clamps invalid percent values + drops invalid byte fields', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    fakeAutoUpdater.emit('download-progress', {
      percent: 999,
      bytesPerSecond: -1,
      total: NaN,
      transferred: 'bad' as unknown as number,
    });

    const broadcasts = findBroadcasts('downloading');
    expect(broadcasts.length).toBe(1);
    const p = broadcasts[0]!.payload;
    expect(p.downloadPercent).toBe(100);
    expect(p.downloadBytesPerSecond).toBeUndefined();
    expect(p.downloadBytesTotal).toBeUndefined();
    expect(p.downloadBytesTransferred).toBeUndefined();
  });
});

describe('v0.1.61 — Squirrel error event broadcasts kind:error to renderer', () => {
  it('signature-mismatch error → broadcasts kind:error with errorCategory + errorReleaseUrl', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.rememberPendingDownloadVersion('v0.1.60');
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    fakeAutoUpdater.emit(
      'error',
      new Error(
        'Code signature at URL file:///… did not pass validation: code failed to satisfy specified code requirement(s)',
      ),
    );

    const errorBroadcasts = findBroadcasts('error');
    expect(errorBroadcasts.length).toBe(1);
    const p = errorBroadcasts[0]!.payload;
    expect(p.errorCategory).toBe('signature-mismatch');
    expect(p.errorReleaseUrl).toContain('github.com/EthanSK/restream-chat-plus-plus');
    expect(p.error).toContain('did not pass validation');
    expect(p.latestVersion).toBe('v0.1.60');
  });

  it('network error → auto-retries (no error pane) until budget exhausts, then surfaces error', async () => {
    // v0.1.85 (voice 7280) — a TRANSIENT network error no longer dead-ends on
    // the error pane on its FIRST occurrence; it auto-arms a bounded backoff
    // retry instead (the "if it fails while downloading, retry" fix). Only
    // after the retry budget is exhausted does the error pane surface.
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    // First network error → retry armed, NOT an error broadcast.
    fakeAutoUpdater.emit('error', new Error('connect ECONNREFUSED 140.82.121.4:443'));
    expect(findBroadcasts('error').length).toBe(0);

    // Drain the retry budget directly (each returns true until exhausted).
    expect(updater.scheduleDownloadRetry()).toBe(true);
    expect(updater.scheduleDownloadRetry()).toBe(true);
    expect(updater.scheduleDownloadRetry()).toBe(false); // exhausted

    // A further network error now CAN'T retry → surfaces the error pane,
    // still correctly categorised as `network`.
    sentMessages.length = 0;
    fakeAutoUpdater.emit('error', new Error('connect ECONNREFUSED 140.82.121.4:443'));
    const errorBroadcasts = findBroadcasts('error');
    expect(errorBroadcasts.length).toBe(1);
    expect(errorBroadcasts[0]!.payload.errorCategory).toBe('network');
  });

  it('staging error → categorised as staging', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    fakeAutoUpdater.emit('error', new Error('ShipIt install failed: EPERM on rename'));

    const errorBroadcasts = findBroadcasts('error');
    expect(errorBroadcasts.length).toBe(1);
    expect(errorBroadcasts[0]!.payload.errorCategory).toBe('staging');
  });

  it('unknown error → categorised as unknown but still broadcast', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    sentMessages.length = 0;

    fakeAutoUpdater.emit('error', new Error('some random failure mode'));

    const errorBroadcasts = findBroadcasts('error');
    expect(errorBroadcasts.length).toBe(1);
    expect(errorBroadcasts[0]!.payload.errorCategory).toBe('unknown');
    expect(errorBroadcasts[0]!.payload.errorReleaseUrl).toBeTruthy();
  });
});

describe('v0.1.61 — categoriseUpdaterError pure helper', () => {
  it('recognises signature-mismatch wording variants', async () => {
    const { categoriseUpdaterError } = await loadUpdater();
    expect(
      categoriseUpdaterError(new Error('Code signature did not pass validation')),
    ).toBe('signature-mismatch');
    expect(
      categoriseUpdaterError(new Error('code failed to satisfy specified code requirement(s)')),
    ).toBe('signature-mismatch');
    expect(categoriseUpdaterError('app is not signed')).toBe('signature-mismatch');
    expect(categoriseUpdaterError(new Error('Team identifier mismatch'))).toBe(
      'signature-mismatch',
    );
  });

  it('recognises network wording variants', async () => {
    const { categoriseUpdaterError } = await loadUpdater();
    expect(categoriseUpdaterError('ETIMEDOUT')).toBe('network');
    expect(categoriseUpdaterError('ENOTFOUND github.com')).toBe('network');
    expect(categoriseUpdaterError('TLS handshake failed')).toBe('network');
  });

  it('falls back to unknown for unrecognised messages', async () => {
    const { categoriseUpdaterError } = await loadUpdater();
    expect(categoriseUpdaterError('something completely unrelated')).toBe('unknown');
    expect(categoriseUpdaterError(undefined)).toBe('unknown');
  });
});
