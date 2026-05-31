// v0.1.84 regression test — Dock re-activation must recreate the MAIN window
// whenever it's gone, even if ANOTHER window (e.g. an OAuth helper) is open.
//
// THE BUG (Codex review, latent menu/window edge):
//   The `app.on('activate')` handler keyed off
//   `BrowserWindow.getAllWindows().length === 0`. Since v0.1.83 the main
//   window's `closed` listener sets the module-level `mainWindow = null`. If
//   the user closes the main window while an OAuth helper window (oauth.ts) is
//   still open, `mainWindow` is null but `getAllWindows().length` is still > 0
//   (the OAuth window counts). The length-based guard then short-circuits and
//   Dock re-activation does NOTHING — the user is stuck with no main window.
//
// THE FIX: key the activate handler off `mainWindow` directly
//   (`if (!mainWindow) createMainWindow();`). createMainWindow() reassigns
//   mainWindow, so the next activate is a no-op when a main window exists.
//
// We mock `electron` so importing main.ts doesn't boot a real runtime (vitest
// runs under environment: node), and CAPTURE the `activate` handler that main.ts
// registers at module load so we can invoke it under both conditions.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every app.on(event, handler) registration so the test can fire them.
const appHandlers: Record<string, (...args: unknown[]) => unknown> = {};

// Track BrowserWindow construction so we can assert createMainWindow ran (or not).
const browserWindowCtor = vi.fn();

// `electron-squirrel-startup` default must be FALSY or main.ts top-level quits.
vi.mock('electron-squirrel-startup', () => ({ default: false }));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    // Minimal surface createMainWindow() touches.
    webContents = {
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
    };
    constructor(opts?: unknown) {
      browserWindowCtor(opts);
    }
    loadURL = vi.fn();
    loadFile = vi.fn();
    on = vi.fn();
    isDestroyed = vi.fn(() => false);
    static getAllWindows() {
      // Simulate the bug condition: a NON-main window (OAuth helper) is open, so
      // the OLD length-based guard would (wrongly) short-circuit. The new guard
      // ignores this and keys off `mainWindow` instead.
      return [{ id: 'oauth-helper' }];
    }
    static getFocusedWindow() {
      return null;
    }
  }
  return {
    app: {
      commandLine: { appendSwitch: vi.fn() },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        appHandlers[event] = handler;
      }),
      quit: vi.fn(),
      getPath: vi.fn(() => '/tmp/rcpp-test-logs'),
      getVersion: vi.fn(() => '0.1.84'),
      setName: vi.fn(),
      whenReady: vi.fn(() => new Promise(() => undefined)), // never resolves → bootstrap body never runs
      isPackaged: false,
      requestSingleInstanceLock: vi.fn(() => true),
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showMessageBox: vi.fn() },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })), setApplicationMenu: vi.fn() },
    Notification: class {
      show = vi.fn();
    },
    powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: vi.fn(() => false) },
    shell: { openExternal: vi.fn() },
  };
});

describe("app.on('activate') — recreate main window when gone (v0.1.84)", () => {
  beforeEach(() => {
    browserWindowCtor.mockClear();
  });

  it('registers an activate handler at module load', async () => {
    await import('../main/main');
    expect(typeof appHandlers['activate']).toBe('function');
  });

  it('creates a main window on activate when mainWindow is null (even with another window open)', async () => {
    await import('../main/main');
    // Fresh module import → mainWindow starts null; whenReady never resolves so
    // createMainWindow has not run yet. Firing activate must construct one,
    // despite getAllWindows() reporting a live (OAuth) window — the exact bug.
    browserWindowCtor.mockClear();
    appHandlers['activate']();
    expect(browserWindowCtor).toHaveBeenCalledTimes(1);
  });

  it('does NOT create a second main window on a follow-up activate (createMainWindow reassigned mainWindow)', async () => {
    await import('../main/main');
    // First activate created + reassigned mainWindow.
    appHandlers['activate']();
    browserWindowCtor.mockClear();
    // Second activate: mainWindow is now set → no-op.
    appHandlers['activate']();
    expect(browserWindowCtor).not.toHaveBeenCalled();
  });
});
