import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * v0.1.83 regression test — the application-menu "Preferences…" item
 * (Cmd+,) must NOT throw when the main window is null OR destroyed.
 *
 * THE BUG (Codex menu-bar review, 🟠 medium):
 *   The handler was `click: () => mainWindow?.webContents.send('menu:open-settings')`.
 *   On macOS, closing the only window does NOT quit the app — the
 *   `window-all-closed` handler only quits on non-darwin — so the app +
 *   the application menu stay alive while `mainWindow` becomes a NON-NULL
 *   handle to a DESTROYED BrowserWindow (it was never reassigned to null on
 *   close). The `?.` guard short-circuits `null` but NOT a destroyed
 *   window, so `.webContents` threw synchronously. Electron's menu-click
 *   dispatcher surfaces a synchronous throw as the cryptic macOS alert
 *   "this command is disabled and cannot be executed".
 *
 * THE FIX:
 *   1. Root cause — `createMainWindow()` now registers
 *      `mainWindow.on('closed', () => { mainWindow = null })`, so every
 *      `mainWindow?.` guard in main.ts genuinely short-circuits after the
 *      window is gone (and `app.on('activate')` recreates + reassigns it).
 *   2. Belt-and-suspenders — the click handler body was factored into the
 *      exported `openSettingsFromMenu(win)` helper, which bails on a null
 *      OR destroyed window and wraps the send in try/catch. This is what
 *      this test pins: a stale/destroyed handle can never throw out of the
 *      handler, and a null/destroyed window never sends.
 *
 * We mock `electron` + `electron-squirrel-startup` so importing main.ts
 * doesn't boot a real Electron runtime (vitest runs under
 * `environment: node`). main.ts has no other import-time side effects —
 * its sibling modules (oauth, ws-client, store, updater, …) only DEFINE
 * functions/classes at module load, so they import cleanly. The only
 * top-level executors are `app.commandLine.appendSwitch` + the `app.on`
 * registrations, all of which become mock no-ops here.
 */

// `electron-squirrel-startup`'s default export must be FALSY, or main.ts's
// top-level `else if (started) { app.quit() }` branch would fire on import.
vi.mock('electron-squirrel-startup', () => ({ default: false }));

vi.mock('electron', () => {
  const commandLine = { appendSwitch: vi.fn() };
  return {
    app: {
      commandLine,
      on: vi.fn(),
      quit: vi.fn(),
      getPath: vi.fn(() => '/tmp/rcpp-test-logs'),
      getVersion: vi.fn(() => '0.1.83'),
      setName: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      isPackaged: false,
      requestSingleInstanceLock: vi.fn(() => true),
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
      static getFocusedWindow() {
        return null;
      }
    },
    dialog: { showMessageBox: vi.fn() },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    Menu: {
      buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
      setApplicationMenu: vi.fn(),
    },
    Notification: class {
      show() {}
    },
    powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: vi.fn(() => false) },
    shell: { openExternal: vi.fn() },
  };
});

// Minimal fake BrowserWindow handle for the helper. We only model the two
// surfaces openSettingsFromMenu touches: `isDestroyed()` and
// `webContents.send(...)`.
function makeWindow(opts: { destroyed: boolean }) {
  const send = vi.fn();
  const win = {
    isDestroyed: () => opts.destroyed,
    webContents: { send },
  };
  return { win, send };
}

describe('openSettingsFromMenu — Preferences… menu guard (v0.1.83)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends menu:open-settings when the window is live (not destroyed)', async () => {
    const { openSettingsFromMenu } = await import('../main/main');
    const { win, send } = makeWindow({ destroyed: false });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => openSettingsFromMenu(win as any)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('menu:open-settings');
  });

  it('does NOT throw and does NOT send when the window is null', async () => {
    const { openSettingsFromMenu } = await import('../main/main');

    expect(() => openSettingsFromMenu(null)).not.toThrow();
    // Nothing to assert a send against — a null window has no webContents.
    // The point is purely that the call is a safe no-op.
  });

  it('does NOT throw and does NOT send when the window is DESTROYED (the bug)', async () => {
    const { openSettingsFromMenu } = await import('../main/main');
    const { win, send } = makeWindow({ destroyed: true });

    // This is the exact crash scenario: a non-null but destroyed handle.
    // The OLD `mainWindow?.webContents.send(...)` would NOT short-circuit
    // (the handle isn't null) and `.webContents` on a destroyed window
    // throws → macOS "command is disabled" alert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => openSettingsFromMenu(win as any)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a throw from webContents.send (final safety net)', async () => {
    const { openSettingsFromMenu } = await import('../main/main');
    // Simulate a window that reports "alive" but whose webContents.send
    // throws anyway (e.g. torn down between the isDestroyed() check and the
    // send in a re-entrant edge case). The try/catch must absorb it.
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(() => {
          throw new Error('Object has been destroyed');
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => openSettingsFromMenu(win as any)).not.toThrow();
  });
});
