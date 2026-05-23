// v0.1.64 — pin the new `getDownloadState()` accessor that the MCP
// `update_download_status` tool relies on. The states map 1:1 with the
// Squirrel autoUpdater events handled in `attachSquirrelProgressForwarders`:
//
//   boot                        → 'idle'
//   checking-for-update         → 'downloading' (we collapse checking + downloading)
//   update-downloaded           → 'ready-to-install'
//   error                       → 'error' (+ lastErrorMessage)
//
// We also pin that `lastErrorMessage` is cleared on `checking-for-update`
// and `update-downloaded` so the MCP tool doesn't keep reporting a stale
// "previous attempt failed" message after a successful recovery.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same mock surface as update-flow-fixes.test.ts — we drive the updater
// module under a fully fake Electron runtime so no real autoUpdater is
// invoked.
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

const fakeApp = vi.hoisted(() => ({
  getVersion: vi.fn(() => '0.1.64'),
  isPackaged: true,
  relaunch: vi.fn(),
  exit: vi.fn(),
}));

const fakeBrowserWindow = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => null),
}));

vi.mock('electron', () => ({
  app: fakeApp,
  autoUpdater: fakeAutoUpdater,
  BrowserWindow: fakeBrowserWindow,
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('update-electron-app', () => ({
  updateElectronApp: vi.fn(() => undefined),
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
  return await import('../main/updater');
}

describe('v0.1.64 — getDownloadState() state machine', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('reports idle at boot before any Squirrel event fires', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    expect(updater.getDownloadState().state).toBe('idle');
  });

  it('reports downloading after triggerSquirrelDownload + checking-for-update', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    fakeAutoUpdater.emit('checking-for-update');
    const snap = updater.getDownloadState();
    expect(snap.state).toBe('downloading');
    expect(snap.downloadStartedAt).toBeTypeOf('number');
  });

  it('reports ready-to-install after update-downloaded event', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    fakeAutoUpdater.emit('checking-for-update');
    // Squirrel.Mac releaseName = the version string per its contract.
    fakeAutoUpdater.emit('update-downloaded', {}, undefined, '0.1.64');
    const snap = updater.getDownloadState();
    expect(snap.state).toBe('ready-to-install');
    expect(snap.lastErrorMessage).toBeUndefined();
  });

  it('reports error + caches lastErrorMessage when autoUpdater emits error', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    fakeAutoUpdater.emit('checking-for-update');
    const err = new Error(
      'Code signature at URL file:///Applications/Restream Chat Plus Plus.app/ did not pass validation: code failed to satisfy specified code requirement(s)',
    );
    fakeAutoUpdater.emit('error', err);
    const snap = updater.getDownloadState();
    expect(snap.state).toBe('error');
    expect(snap.lastErrorMessage).toMatch(/code signature/i);
    expect(snap.lastErrorCategory).toBe('signature-mismatch');
  });

  it('clears lastErrorMessage on the next checking-for-update event', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();

    // First attempt fails with a signature error.
    updater.triggerSquirrelDownload();
    fakeAutoUpdater.emit('checking-for-update');
    fakeAutoUpdater.emit('error', new Error('code signature did not pass validation'));
    expect(updater.getDownloadState().state).toBe('error');

    // Second attempt — Squirrel re-enters checking. The error must clear so
    // the MCP tool doesn't keep reporting a stale failure.
    updater.triggerSquirrelDownload();
    fakeAutoUpdater.emit('checking-for-update');
    const snap = updater.getDownloadState();
    expect(snap.lastErrorMessage).toBeUndefined();
    expect(snap.state).toBe('downloading');
  });

  it('clears lastErrorMessage on successful update-downloaded', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    fakeAutoUpdater.emit('checking-for-update');
    fakeAutoUpdater.emit('error', new Error('transient network failure'));
    // Retry — emit the success path directly without going through
    // `checking-for-update` again so we can prove `update-downloaded` is
    // itself an error-clearing event (real Squirrel sometimes emits
    // update-downloaded without re-entering checking after a recovered
    // transient).
    fakeAutoUpdater.emit('update-downloaded', {}, undefined, '0.1.64');
    const snap = updater.getDownloadState();
    expect(snap.state).toBe('ready-to-install');
    expect(snap.lastErrorMessage).toBeUndefined();
  });

  it('triggerInstallNow refuses when no update is staged', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    const result = updater.triggerInstallNow();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-update-downloaded');
  });

  it('triggerInstallNow returns ok:true when an update is staged', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    fakeAutoUpdater.emit('checking-for-update');
    fakeAutoUpdater.emit('update-downloaded', {}, undefined, '0.1.64');
    const result = updater.triggerInstallNow();
    expect(result.ok).toBe(true);
  });
});
