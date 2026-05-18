import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdateInfo } from '../shared/types';

/**
 * v0.1.37 regression test — pre-v0.1.37 the "Check for Updates Now…"
 * menu item ran TWO update pipelines in parallel:
 *
 *   1. `performGithubUpdateCheck(true)` — GH Releases API hit. Drives
 *      the in-app banner. Reports the real latest release.
 *   2. `checkForUpdatesInteractive(mainWindow)` — Squirrel-backed
 *      (`autoUpdater.checkForUpdates()`). On unsigned macOS builds
 *      this either fails ("feed-unavailable") or resolves to
 *      `update-not-available` so the dialog reads "you're on the
 *      latest version".
 *
 * Result: a user who's on an unsigned 0.1.34 build with a 0.1.36
 * release published saw "Update available 0.1.36" in the banner AND
 * a dialog saying "you're on the latest version (0.1.34)" at the
 * same time. Voice 3351 called this out.
 *
 * Fix in v0.1.37: `checkForUpdatesInteractive` now drives its dialog
 * from `performGithubUpdateCheck`. Squirrel is still kicked in the
 * background on signed builds for the in-app download → restart-to-
 * install flow, but it no longer drives user-facing copy.
 *
 * This test asserts that `checkForUpdatesInteractive` calls
 * `performGithubUpdateCheck(true)` once and routes the dialog copy
 * through the GH-Releases result. We mock Electron + the GH module
 * because vitest runs under `environment: node` (no real Electron).
 */

// Hoisted because vi.mock is hoisted above import — must be inside
// the factory so the mock module sees them.
vi.mock('electron', () => {
  const showMessageBox = vi.fn().mockResolvedValue({ response: 1 });
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const checkForUpdates = vi.fn();
  const removeListener = vi.fn();
  return {
    app: {
      getVersion: () => '0.1.34',
      isPackaged: false, // unsigned-build path — Squirrel skipped
    },
    autoUpdater: {
      checkForUpdates,
      on: vi.fn(),
      once: vi.fn(),
      removeListener,
    },
    BrowserWindow: class {
      isDestroyed() {
        return false;
      }
      static getFocusedWindow() {
        return null;
      }
      static getAllWindows() {
        return [];
      }
    },
    dialog: { showMessageBox },
    shell: { openExternal },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
  };
});

vi.mock('electron-log/main', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('update-electron-app', () => ({
  updateElectronApp: vi.fn(),
  UpdateSourceType: { ElectronPublicUpdateService: 'ElectronPublicUpdateService' },
}));

// Mock the GH-Releases module — the unit under test is supposed to
// delegate the authoritative verdict to this. We type via an explicit
// `(...args: unknown[]) => Promise<UpdateInfo>` signature so vitest's
// generic-inference doesn't widen `mockResolvedValue` to `never`.
type GhCheckMockFn = ((..._args: unknown[]) => Promise<UpdateInfo>) & {
  mockResolvedValue: (v: UpdateInfo) => GhCheckMockFn;
  mock: { calls: unknown[][] };
};
const performGithubUpdateCheckMock = vi.fn() as unknown as GhCheckMockFn;
vi.mock('../main/github-update-check', () => ({
  performGithubUpdateCheck: (_force?: boolean) => performGithubUpdateCheckMock(),
  startGithubUpdatePoller: vi.fn(),
  stopGithubUpdatePoller: vi.fn(),
  getLastUpdateInfo: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkForUpdatesInteractive — GH-Releases reconciliation (v0.1.37)', () => {
  it('delegates to performGithubUpdateCheck and shows "Update available" when GH says so', async () => {
    performGithubUpdateCheckMock.mockResolvedValue({
      kind: 'available',
      currentVersion: '0.1.34',
      latestVersion: '0.1.36',
      releaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.36',
      checkedAt: Date.now(),
    });

    const { checkForUpdatesInteractive } = await import('../main/updater');
    const electron = await import('electron');

    await checkForUpdatesInteractive(null);

    expect(performGithubUpdateCheckMock).toHaveBeenCalledTimes(1);
    expect((electron.dialog.showMessageBox as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      1,
    );
    const opts = (electron.dialog.showMessageBox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.message).toContain('Update available');
    expect(opts.message).toContain('0.1.36');
    // Squirrel's autoUpdater.checkForUpdates should NOT be called on
    // unsigned (isPackaged=false) builds — the dialog is enough.
    expect(
      (electron.autoUpdater.checkForUpdates as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it('shows "on the latest version" when GH reports up-to-date', async () => {
    performGithubUpdateCheckMock.mockResolvedValue({
      kind: 'up-to-date',
      currentVersion: '0.1.36',
      checkedAt: Date.now(),
    });

    const { checkForUpdatesInteractive } = await import('../main/updater');
    const electron = await import('electron');

    await checkForUpdatesInteractive(null);

    expect(performGithubUpdateCheckMock).toHaveBeenCalledTimes(1);
    const opts = (electron.dialog.showMessageBox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.message).toContain("latest version");
    expect(opts.message).toContain('0.1.36');
  });

  it('surfaces a warning dialog when GH check errors', async () => {
    performGithubUpdateCheckMock.mockResolvedValue({
      kind: 'error',
      currentVersion: '0.1.34',
      error: 'GitHub API returned HTTP 503',
      checkedAt: Date.now(),
    });

    const { checkForUpdatesInteractive } = await import('../main/updater');
    const electron = await import('electron');

    await checkForUpdatesInteractive(null);

    const opts = (electron.dialog.showMessageBox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.type).toBe('warning');
    expect(opts.detail).toContain('503');
  });
});
