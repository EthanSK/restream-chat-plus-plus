/**
 * v0.1.85 (voice 7280) — DOWNLOAD-RETRY resilience tests.
 *
 * Pins the new auto-retry behaviour added to `src/main/updater.ts`:
 *
 *   1. A TRANSIENT (network-category) Squirrel `error` event auto-arms a
 *      bounded backoff retry that re-fires `autoUpdater.checkForUpdates()`,
 *      instead of dead-ending on the error pane. This is the headline fix
 *      for Ethan's "if it fails while downloading, retry … it just worked
 *      after about three times" complaint.
 *
 *   2. The retry budget is bounded (3 attempts on a 5s/15s/45s ladder);
 *      after exhaustion the error pane IS surfaced so the user gets the
 *      manual-fallback link.
 *
 *   3. Non-network categories (signature-mismatch / staging / unknown) do
 *      NOT auto-retry — they surface the error pane immediately (retrying a
 *      bad signature would just re-fail).
 *
 *   4. A successful `update-downloaded`, an `update-not-available`, or a
 *      fresh user-initiated `triggerSquirrelDownload()` resets the retry
 *      counter so the next session gets a full ladder.
 *
 * Uses the same hoisted Electron mock pattern as update-flow-fixes.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  getVersion: vi.fn(() => '0.1.85'),
  isPackaged: true,
  relaunch: vi.fn(),
  exit: vi.fn(),
}));

const fakeBrowserWindow = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => null),
}));

const fakeShell = vi.hoisted(() => ({ openExternal: vi.fn() }));
const fakeDialog = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `structured-log` is imported by updater.ts; stub so the test doesn't touch
// the real app-errors.jsonl path.
vi.mock('../main/structured-log', () => ({
  appendErrorLog: vi.fn(),
  errorToString: (e: unknown) => String((e as Error)?.message ?? e),
}));

// `github-update-check` is imported by updater.ts (performGithubUpdateCheck).
// We don't exercise it here; stub to avoid the real fetch path.
vi.mock('../main/github-update-check', () => ({
  performGithubUpdateCheck: vi.fn(),
}));

async function loadUpdater() {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  for (const k of Object.keys(fakeAutoUpdater.listeners)) {
    delete fakeAutoUpdater.listeners[k];
  }
  fakeAutoUpdater.checkForUpdates.mockClear();
  fakeAutoUpdater.quitAndInstall.mockClear();
  fakeUpdateElectronApp.mockClear();
  return await import('../main/updater');
}

describe('v0.1.85 download-retry resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a transient (network) Squirrel error auto-retries checkForUpdates() on the backoff ladder', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    // Simulate Squirrel entering the download then a network drop mid-way.
    fakeAutoUpdater.emit('checking-for-update');
    fakeAutoUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'));

    // First retry is scheduled 5s out — not fired yet.
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('exhausts the bounded retry budget (3 attempts) then stops auto-retrying', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();

    // Each error → retry fires checkForUpdates → another error. Walk the
    // full 5s/15s/45s ladder.
    const delays = [5_000, 15_000, 45_000];
    let expectedChecks = 1; // the initial triggerSquirrelDownload
    for (const delay of delays) {
      fakeAutoUpdater.emit('error', new Error('network timeout'));
      vi.advanceTimersByTime(delay);
      expectedChecks += 1;
      expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(expectedChecks);
    }

    // Budget now exhausted: a 4th error must NOT arm another retry.
    fakeAutoUpdater.emit('error', new Error('network timeout'));
    vi.advanceTimersByTime(60_000);
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(expectedChecks);
  });

  it('does NOT auto-retry a signature-mismatch error (surfaces error pane immediately)', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    fakeAutoUpdater.emit(
      'error',
      new Error('Code signature at URL ... did not pass validation'),
    );
    // No retry should fire even after a long wait.
    vi.advanceTimersByTime(120_000);
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('update-not-available resets the retry counter so the next session gets the full ladder', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();

    // Burn two retries.
    fakeAutoUpdater.emit('error', new Error('network blip'));
    vi.advanceTimersByTime(5_000); // retry 1 fires
    fakeAutoUpdater.emit('error', new Error('network blip'));
    vi.advanceTimersByTime(15_000); // retry 2 fires
    // Squirrel concludes there's no update after all → resets retry state.
    fakeAutoUpdater.emit('update-not-available');

    // Fresh transient error in a new session should arm retry #1 again
    // (5s window), proving the counter reset (otherwise the budget would
    // already be at 2/3 and only one more retry would remain — this asserts
    // a full fresh retry fires at the 5s mark).
    fakeAutoUpdater.checkForUpdates.mockClear();
    fakeAutoUpdater.emit('error', new Error('network blip'));
    vi.advanceTimersByTime(5_000);
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('a fresh triggerSquirrelDownload() cancels a pending auto-retry timer (no double checkForUpdates)', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();

    // Arm a retry but don't let it fire yet.
    fakeAutoUpdater.emit('error', new Error('network blip'));
    fakeAutoUpdater.checkForUpdates.mockClear();

    // User manually re-clicks Install BEFORE the 5s retry fires. That fires
    // one check immediately AND must cancel the pending auto-retry timer.
    updater.triggerSquirrelDownload();
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    // Advance past the original 5s retry window — it must NOT fire a second
    // check (would throw "command is disabled" in production).
    vi.advanceTimersByTime(5_000);
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('scheduleDownloadRetry returns false once the budget is exhausted', async () => {
    const updater = await loadUpdater();
    updater.configureAutoUpdater();
    updater.triggerSquirrelDownload();
    // Drain all retries directly via the exported helper.
    expect(updater.scheduleDownloadRetry()).toBe(true); // attempt 1
    expect(updater.scheduleDownloadRetry()).toBe(true); // attempt 2
    expect(updater.scheduleDownloadRetry()).toBe(true); // attempt 3
    expect(updater.scheduleDownloadRetry()).toBe(false); // exhausted
  });
});
