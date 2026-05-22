/**
 * v0.1.52 — three regression tests pinning the fixes for the trio of
 * RC++ auto-update bugs reported by Ethan in voices 3714 + 3715:
 *
 *   1. "Install Update" banner button errors with "Update could not start"
 *      → root cause: a second `autoUpdater.checkForUpdates()` call while a
 *        download is in flight or an update is already staged throws
 *        Squirrel's "The command is disabled and cannot be executed".
 *      → fix in `triggerSquirrelDownload`: short-circuit to a success
 *        outcome (`already-downloading` / `already-staged`) when a
 *        previous call has already armed the state machine.
 *
 *   2. "Update Ready" Restart button does nothing.
 *      → root cause: the built-in `update-electron-app` native dialog
 *        with `notifyUser: true` listens for the same `update-downloaded`
 *        event AND fires `quitAndInstall()` on its own. When the user
 *        dismissed the native dialog with "Later", Squirrel's state
 *        machine internally reset the staged update; the banner's
 *        Restart button then silently no-op'd against the now-empty
 *        staged slot.
 *      → fix in `configureAutoUpdater`: pass `notifyUser: false` so
 *        the banner is the SINGLE source of truth for Restart. Plus
 *        defer `autoUpdater.quitAndInstall()` to next tick so the IPC
 *        round-trip completes before the app tears down, and add a
 *        belt-and-braces `app.relaunch() + app.exit(0)` fallback that
 *        fires if `quitAndInstall()` silently no-ops.
 *
 *   3. Signed out on every update.
 *      → root cause: `oauth.runDeferredDecrypt` wiped `tokenEnc` after
 *        a 2-second decrypt timeout, on the assumption that the
 *        timeout meant ACL drift. After a Sparkle in-place update the
 *        first decrypt of the new binary triggers a SecurityAgent
 *        "Allow" prompt; the user takes longer than 2 seconds to find
 *        and click Allow; we wiped the blob; next read had nothing to
 *        decrypt and the user had to re-OAuth.
 *      → fix in `oauth.ts`: raise the timeout to 30 s AND, more
 *        importantly, PRESERVE the blob across a timeout. Only a
 *        decrypt THROW (genuine "this ciphertext is junk" case)
 *        triggers the wipe. The "signed out" state on timeout is
 *        therefore transient — next launch (after the user has
 *        clicked Allow once) decrypts cleanly and the user stays
 *        signed in across all future updates.
 */
import { describe, it, expect, vi } from 'vitest';

// Reuse the same hoisted Electron mock pattern from oauth-persistence.test.ts
// so we can drive the updater module without a real Electron runtime.
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
  getVersion: vi.fn(() => '0.1.52'),
  isPackaged: true,
  relaunch: vi.fn(),
  exit: vi.fn(),
}));

const fakeBrowserWindow = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => null),
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

// Mock `update-electron-app` so the test doesn't try to actually wire
// Squirrel's feed URL. We just need to confirm it's called and capture
// the options it was called with.
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

// Re-import on every isolated test so the module-level state
// (`feedURLReady`, `updateDownloaded`, `downloadInFlight`) resets between
// suites. Using `vi.resetModules()` inside each `beforeEach`.
async function loadUpdater() {
  vi.resetModules();
  // These regressions exercise Squirrel's macOS updater path. GitHub CI
  // runs this suite on Linux, where triggerSquirrelDownload correctly
  // returns unsupported-platform unless we pin the mocked Electron runtime
  // to darwin before importing the updater module.
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  // Re-arm the listener registry so each test starts from zero.
  for (const k of Object.keys(fakeAutoUpdater.listeners)) {
    delete fakeAutoUpdater.listeners[k];
  }
  fakeAutoUpdater.checkForUpdates.mockClear();
  fakeAutoUpdater.quitAndInstall.mockClear();
  fakeApp.relaunch.mockClear();
  fakeApp.exit.mockClear();
  fakeUpdateElectronApp.mockClear();
  return await import('../main/updater');
}

describe('v0.1.52 update-flow fixes', () => {
  describe('Bug #1 — Install Update banner click after staged/in-flight no longer throws', () => {
    it('first triggerSquirrelDownload() arms Squirrel checkForUpdates()', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();
      const result = updater.triggerSquirrelDownload();
      expect(result).toEqual({
        ok: true,
        reason: 'started',
        mode: 'squirrel',
      });
      expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('second triggerSquirrelDownload() while already downloading returns success with reason=already-downloading (no throw)', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();

      updater.triggerSquirrelDownload();
      // Squirrel emits checking-for-update → downloadInFlight=true.
      fakeAutoUpdater.emit('checking-for-update');

      const second = updater.triggerSquirrelDownload();
      expect(second).toEqual({
        ok: true,
        reason: 'already-downloading',
        mode: 'squirrel',
      });
      // checkForUpdates() must NOT be called twice — that's what would
      // throw "command is disabled" in production.
      expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('triggerSquirrelDownload() after update-downloaded returns reason=already-staged (no throw, no extra check)', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();

      updater.triggerSquirrelDownload();
      fakeAutoUpdater.emit('update-downloaded', {}, undefined, 'v0.1.52');

      const second = updater.triggerSquirrelDownload();
      expect(second).toEqual({
        ok: true,
        reason: 'already-staged',
        mode: 'squirrel',
      });
      expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('after a synchronous checkForUpdates throw, the in-flight flag resets so a retry can succeed', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();

      fakeAutoUpdater.checkForUpdates.mockImplementationOnce(() => {
        throw new Error('something Squirrel went wrong');
      });
      const failed = updater.triggerSquirrelDownload();
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.reason).toBe('error');
        expect(failed.error).toContain('something Squirrel went wrong');
      }

      // Next click should not be blocked.
      const retry = updater.triggerSquirrelDownload();
      expect(retry).toEqual({
        ok: true,
        reason: 'started',
        mode: 'squirrel',
      });
    });
  });

  describe('Bug #2 — Restart button actually triggers app restart', () => {
    it('quitAndInstallStagedUpdate returns ok:true synchronously AND schedules the actual restart for the next tick', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();
      updater.triggerSquirrelDownload();
      fakeAutoUpdater.emit('update-downloaded', {}, undefined, 'v0.1.52');

      vi.useFakeTimers();
      try {
        const result = updater.quitAndInstallStagedUpdate();
        expect(result.ok).toBe(true);
        // Critical: the IPC handler must return BEFORE the actual quit
        // so the renderer's Promise resolves. quitAndInstall is NOT
        // called synchronously inside the handler.
        expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

        // Drain setImmediate.
        vi.advanceTimersToNextTimer();
        await Promise.resolve();
        await Promise.resolve();

        expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('belt-and-braces: if quitAndInstall silently no-ops (1.5 s passes, app still running), forces relaunch+exit', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();
      updater.triggerSquirrelDownload();
      fakeAutoUpdater.emit('update-downloaded', {}, undefined, 'v0.1.52');

      vi.useFakeTimers();
      try {
        updater.quitAndInstallStagedUpdate();
        vi.advanceTimersToNextTimer(); // setImmediate
        await Promise.resolve();
        await Promise.resolve();
        // Now run out the 1500 ms fallback timer.
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
        expect(fakeApp.relaunch).toHaveBeenCalledTimes(1);
        expect(fakeApp.exit).toHaveBeenCalledWith(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('quitAndInstallStagedUpdate before update-downloaded refuses with reason=no-update-downloaded', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();
      const result = updater.quitAndInstallStagedUpdate();
      expect(result).toEqual({ ok: false, reason: 'no-update-downloaded' });
      expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('configureAutoUpdater passes notifyUser:false to update-electron-app (banner is the single source of truth)', async () => {
      const updater = await loadUpdater();
      updater.configureAutoUpdater();
      expect(fakeUpdateElectronApp).toHaveBeenCalledTimes(1);
      const opts = fakeUpdateElectronApp.mock.calls[0][0];
      expect(opts.notifyUser).toBe(false);
    });
  });
});
