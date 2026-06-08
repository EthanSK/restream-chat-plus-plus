import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerSaveBlocker,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import { OAuthCoordinator } from './oauth';
import { ChatClient } from './ws-client';
import { createStore } from './store';
import {
  sendChatText,
  ensureRestreamChatCookies,
  type ChatSendLogRecord,
  type ChatContext,
} from './chat-send';
import { createChatSendQueue, type ChatSendQueue } from './chat-send-queue';
import { resumeAuthWithCookieRepair } from './startup-auth-resume';
// v0.1.70 (sign-out diagnosis 2026-05-25) — transient-refresh-retry
// watchdog. Factored out of main.ts so the exponential-backoff state
// machine can be pinned with unit tests (Vitest fake timers) without
// booting Electron's `app.on('ready')` closure.
import {
  TransientRefreshRetryController,
} from './transient-refresh-retry';
// v0.1.69 (voice 4015) — shared structured error log + the 7-day jsonl
// prune step. `appendErrorLog` mirrors many of the existing console.error
// sites into app-errors.jsonl; `pruneJsonlLogs` is run at startup and
// every 24 h to keep the logs dir under the 7-day retention budget Ethan
// explicitly asked for ("gets rid of the old ones after, like, a week").
import {
  appendErrorLog,
  errorToString,
  pruneJsonlLogs,
  PRUNE_INTERVAL_MS,
} from './structured-log';
import {
  configureAutoUpdater,
  checkForUpdatesInteractive,
  quitAndInstallStagedUpdate,
  triggerSquirrelDownload,
  type StartDownloadResult,
} from './updater';
import {
  getLastUpdateInfo,
  performGithubUpdateCheck,
  startGithubUpdatePoller,
} from './github-update-check';
import { startInProcessMcpServer } from './mcp-server';
import {
  NativeTtsEngine,
  ttsToNativeSettings,
  type NativeVoice,
} from './tts-native';
// v0.1.76 — main-process TTS + notification dispatcher (Ethan voice 4414).
// Owns the decision/filter/rate-limit/backend-choice logic that used to live
// in the renderer, so the never-miss guarantee + native fallback don't depend
// on the renderer being alive. See src/main/tts-dispatch.ts.
import { TtsDispatcher } from './tts-dispatch';
// v0.1.84 — shared predicate that decides whether a settings write is a
// transition INTO silence (mute false→true OR enabled true→false). Used to be
// applied only in the renderer (App.tsx); moved into the MAIN saveSettings path
// so the cancel is ATOMIC with the persist and covers EVERY entry point
// (renderer toggle, header mute button, MCP set_tts_enabled). See saveSettings.
import { shouldCancelNativeTtsOnSettingsChange } from '../shared/side-effect-decision';
import {
  DEFAULT_SETTINGS,
  IPC,
  Settings,
  AuthStatus,
  ConnectionState,
  ChatSendEnqueuePayload,
  ChatSendStatus,
  NativeVoiceWire,
  SendTextResult,
  TtsLogEvent,
  TtsNativeEnqueuePayload,
  TtsNativeSettingsPayload,
  UpdateInfo,
} from '../shared/types';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// ---------------------------------------------------------------------------
// Renderer background-throttling switches (kept; rationale updated v0.1.81).
// ---------------------------------------------------------------------------
// These Chromium command-line switches are applied at module-eval time (BEFORE
// `app.on('ready')`) or Electron boots the renderer with the default
// throttling-ON behaviour and they become no-ops.
//
// HISTORY: in v0.1.74 these (plus a now-REMOVED `--disable-features=
// MacWebContentsOcclusion,CalculateNativeWinOcclusion` switch) existed to keep
// the renderer Web-Speech engine awake in the background — Chromium throttles a
// backgrounded renderer and that suspended `speechSynthesis`. v0.1.81 deleted
// the browser voice entirely (speech is now the native OS voice in the main
// process — see src/main/tts-native.ts / tts-dispatch.ts), so that motivation
// is GONE and the occlusion `--disable-features` switch was removed with it.
//
// We KEEP these three because they still cheaply help the renderer stay
// responsive in the background (timely UI updates, prompt feed re-renders) and
// removing them carries no upside. They no longer have anything to do with TTS:
//   - `disable-background-timer-throttling`    — don't clamp backgrounded
//     setTimeout/setInterval to ~1 fire/min.
//   - `disable-renderer-backgrounding`         — don't lower renderer priority
//     when the window loses focus.
//   - `disable-backgrounding-occluded-windows` — don't background a merely
//     covered window.
// The never-miss guarantee does NOT rely on these: chat frames are received in
// MAIN (never throttled) and TTS decision + speech both run in MAIN now.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ---------------------------------------------------------------------------
// MCP server — v0.1.36+ HTTP-over-loopback architecture
// ---------------------------------------------------------------------------
//
// Earlier builds (v0.1.29-v0.1.35) shipped an `--mcp-stdio` child-process
// entrypoint where MCP clients spawned a second copy of the app binary
// to talk to the settings file. That worked but had two structural
// problems:
//
//   1. Settings written by the child process didn't surface in the live
//      GUI until the renderer re-pulled — anything you'd set via MCP
//      wouldn't take effect mid-session.
//   2. Electron's stdout is unreliable for line-delimited JSON-RPC —
//      Squirrel install hooks, the Electron event loop, and child-
//      process startup logging all wrote bytes into stdout that
//      corrupted the wire format.
//
// v0.1.36 reworks the architecture: when the GUI is running, an HTTP
// MCP server listens on `127.0.0.1:19852` INSIDE the main process. ANY
// MCP client (Claude Code via `type: http`, the MCP Inspector, raw
// curl) connects by URL — no child process needed. The HTTP server
// uses the same store + IPC paths the renderer uses, so MCP changes
// reflect in the live UI immediately.
//
// See `src/main/mcp-server.ts` for the lifecycle wiring + bridge into
// the running app's state. See `src/mcp/http.ts` for the HTTP transport.
//
// The `--mcp-stdio` flag is retained as a deprecated alias that exits
// with a clear error message pointing at the new pattern. Removing it
// outright would silently break anyone whose existing `~/.claude/.mcp.json`
// still references the stdio path; printing the migration hint is
// kinder than a fork()ed black hole.
if (process.argv.includes('--mcp-stdio')) {
  process.stderr.write(
    '[restream-chat-plus-plus] --mcp-stdio was removed in v0.1.36.\n' +
      'The MCP server now runs inside the live GUI process at\n' +
      '  http://127.0.0.1:19852/mcp\n' +
      'Update your MCP client config to use `type: "http"` instead of\n' +
      '`type: "stdio"` and start the Restream Chat++ app normally.\n',
  );
  process.exit(2);
} else if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const SEED_VIEWER_MIGRATION_KEY = 'seed-viewer-ignore-regex';

/**
 * Reveal the user-data log folder in Finder / Explorer. We prefer to reveal
 * the raw-frames.jsonl file directly (so Ethan can `Quick Look` it without
 * hunting) but fall back to the parent log directory if the WS client hasn't
 * created the file yet (e.g. authenticated but the WebSocket hasn't opened
 * yet, or running in a path where the log dir is missing).
 */
function revealLogsInFinder(rawLogPath: string | undefined): boolean {
  try {
    if (rawLogPath && fs.existsSync(rawLogPath)) {
      shell.showItemInFolder(rawLogPath);
      return true;
    }
    const dir = rawLogPath
      ? path.dirname(rawLogPath)
      : app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return true;
  } catch (err) {
    console.error('[main] revealLogsInFinder failed', err);
    return false;
  }
}

/**
 * Resolve the path to the Compose-window outbound-request debug log. Sits
 * next to raw-frames.jsonl so "Reveal Logs in Finder" surfaces both.
 *
 * Returns undefined if we couldn't resolve the parent log dir (e.g. the
 * WS client hasn't picked one yet AND the Electron `app` API failed).
 */
function resolveComposeLogPath(rawLogPath: string | undefined): string | undefined {
  try {
    let dir: string | undefined;
    if (rawLogPath) {
      dir = path.dirname(rawLogPath);
    } else {
      try {
        dir = app.getPath('logs');
      } catch {
        dir = undefined;
      }
    }
    if (!dir) return undefined;
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'compose-requests.jsonl');
  } catch {
    return undefined;
  }
}

function appendComposeLog(p: string, record: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(p, line, 'utf8');
  } catch (err) {
    // logging must never crash the parent flow
    console.error('[main] compose log append failed', err);
  }
}

/**
 * Resolve the path to the TTS lifecycle event log (v0.1.41 engine-wake
 * diagnostic). Lives next to the other JSONL logs under `app.getPath('logs')`
 * — on macOS that's `~/Library/Logs/Restream Chat Plus Plus/tts-events.jsonl`.
 */
function resolveTtsLogPath(): string | undefined {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'tts-events.jsonl');
  } catch {
    return undefined;
  }
}

let ttsLogPathCache: string | undefined;

function appendTtsLog(payload: TtsLogEvent): void {
  try {
    if (ttsLogPathCache === undefined) {
      ttsLogPathCache = resolveTtsLogPath() ?? '';
    }
    if (!ttsLogPathCache) return;
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n';
    fs.appendFileSync(ttsLogPathCache, line, 'utf8');
  } catch (err) {
    // logging must never crash the parent flow
    console.error('[main] tts log append failed', err);
  }
}

/**
 * v0.1.45 — auto-reconnect event log.
 *
 * One JSONL record per auto-retry attempt fired by the ChatClient. Lives
 * at `~/Library/Logs/Restream Chat++/reconnect-events.jsonl` on macOS (or
 * the platform-equivalent `app.getPath('logs')` dir). Cached after first
 * resolve so we don't re-walk fs.mkdirSync on every line.
 *
 * Goal: when Ethan reports "the app sat disconnected for hours", we can
 * read this file and see per-attempt outcomes (ok / refresh-failed /
 * not-authenticated / err) without DevTools open. The MANUAL Reconnect
 * button does NOT write to this file — it always worked. This is purely
 * for diagnosing the auto path.
 */
let reconnectEventLogPathCache: string | undefined;
function resolveReconnectEventLogPath(): string | undefined {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'reconnect-events.jsonl');
  } catch {
    return undefined;
  }
}
function appendReconnectEventLog(record: Record<string, unknown>): void {
  try {
    if (reconnectEventLogPathCache === undefined) {
      reconnectEventLogPathCache = resolveReconnectEventLogPath() ?? '';
    }
    if (!reconnectEventLogPathCache) return;
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(reconnectEventLogPathCache, line, 'utf8');
  } catch (err) {
    // logging must never crash the parent flow
    console.error('[main] reconnect-event log append failed', err);
  }
}

/**
 * Best-effort decode of an uploadData[*].bytes Buffer into a string. Most
 * Restream API calls are application/json so this is the common case.
 * Falls back to base64 for binary so we never lose data.
 */
function decodeUploadBytes(buf: Buffer): { kind: 'utf8' | 'base64'; data: string } {
  try {
    const s = buf.toString('utf8');
    // crude printable-ratio check — if the buffer is mostly printable ASCII
    // we treat as utf8 (covers JSON, form-urlencoded, plain text); else b64.
    let printable = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) {
        printable += 1;
      }
    }
    if (s.length > 0 && printable / s.length > 0.85) {
      return { kind: 'utf8', data: s };
    }
  } catch {
    // fall through to base64
  }
  return { kind: 'base64', data: buf.toString('base64') };
}

/**
 * Attach `webRequest` listeners to the Compose window's session that log
 * every outgoing HTTP request — URL, method, headers, request body — to
 * compose-requests.jsonl. This is the v0.1.12 reverse-engineering hook
 * so we can identify Restream's private chat-send endpoint and wire an
 * inline input in a follow-up release.
 *
 * Filtered to api.restream.io / backend.chat.restream.io / chat.restream.io
 * domains so we don't drown the log with analytics / sentry / fonts noise.
 */
function attachComposeRequestLogger(
  win: BrowserWindow,
  rawLogPath: string | undefined,
): void {
  const logPath = resolveComposeLogPath(rawLogPath);
  if (!logPath) {
    console.error('[main] compose request logger: no log path resolved');
    return;
  }
  appendComposeLog(logPath, {
    kind: 'logger-attached',
    note:
      'Compose request logger active. Send a chat message in this window ' +
      'to capture the underlying Restream API call. Cancel any ongoing ' +
      'capture by closing the window.',
  });

  const sess = win.webContents.session;
  const filter: Electron.WebRequestFilter = {
    urls: [
      '*://*.restream.io/*',
      '*://restream.io/*',
    ],
  };

  // Capture URL + method + body in onBeforeRequest (only place uploadData
  // is exposed). Request headers don't arrive on this hook; we grab them
  // separately in onSendHeaders below.
  sess.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      const interesting =
        details.method !== 'GET' && details.method !== 'HEAD' && details.method !== 'OPTIONS';
      const body =
        Array.isArray(details.uploadData) && details.uploadData.length > 0
          ? details.uploadData.map((u) => {
              if (u.bytes) return { type: 'bytes', ...decodeUploadBytes(u.bytes) };
              if ((u as any).file) return { type: 'file', file: (u as any).file };
              return { type: 'unknown' };
            })
          : undefined;
      if (interesting || body) {
        appendComposeLog(logPath, {
          kind: 'request',
          id: details.id,
          method: details.method,
          url: details.url,
          resourceType: details.resourceType,
          body,
        });
      }
    } catch (err) {
      console.error('[main] compose onBeforeRequest log failed', err);
    }
    callback({});
  });

  // Capture headers separately. Cookies are sensitive — redact long
  // values to keep the log readable but preserve enough for shape
  // inspection (first 12 chars). x-axsrf-token / authorization values
  // are similarly redacted.
  sess.webRequest.onSendHeaders(filter, (details) => {
    try {
      if (details.method === 'GET' || details.method === 'HEAD' || details.method === 'OPTIONS') {
        // Skip pure-read traffic to keep the log focused on send paths.
        return;
      }
      const safeHeaders: Record<string, string> = {};
      for (const [key, raw] of Object.entries(details.requestHeaders ?? {})) {
        const lower = key.toLowerCase();
        const value = String(raw);
        if (
          lower === 'cookie' ||
          lower === 'authorization' ||
          lower === 'x-axsrf-token' ||
          lower === 'x-rxsrf-token'
        ) {
          safeHeaders[key] = value.length > 16 ? `${value.slice(0, 12)}…(${value.length})` : value;
        } else {
          safeHeaders[key] = value;
        }
      }
      appendComposeLog(logPath, {
        kind: 'request-headers',
        id: details.id,
        method: details.method,
        url: details.url,
        headers: safeHeaders,
      });
    } catch (err) {
      console.error('[main] compose onSendHeaders log failed', err);
    }
  });

  // Capture response status to confirm whether a candidate send endpoint
  // actually succeeded (2xx) vs. errored (4xx/5xx).
  sess.webRequest.onCompleted(filter, (details) => {
    try {
      if (details.method === 'GET' || details.method === 'HEAD' || details.method === 'OPTIONS') {
        return;
      }
      appendComposeLog(logPath, {
        kind: 'response',
        id: details.id,
        method: details.method,
        url: details.url,
        statusCode: details.statusCode,
        statusLine: details.statusLine,
        fromCache: details.fromCache,
      });
    } catch (err) {
      console.error('[main] compose onCompleted log failed', err);
    }
  });

  win.on('closed', () => {
    appendComposeLog(logPath, { kind: 'window-closed' });
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 340,
    minHeight: 420,
    title: 'Restream Chat++',
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // `backgroundThrottling: false` (kept; rationale updated v0.1.81).
      // ----------------------------------------------------------------------
      // Disables Chromium's per-window background timer throttling. This was
      // originally a v0.1.74 BACKGROUND-TTS fix (the renderer Web-Speech engine
      // stalled when the window was backgrounded), but v0.1.81 removed the
      // browser voice — speech is now the native OS voice in the MAIN process
      // (src/main/tts-native.ts), which is immune to renderer throttling. We
      // keep this flag because it cheaply keeps the renderer's UI/feed updates
      // prompt in the background; it no longer has any bearing on TTS. The
      // never-miss guarantee comes from chat frames being received in MAIN
      // (never throttled) + TTS decision/speech both running in MAIN.
      backgroundThrottling: false,
    },
  });
  // Belt-and-suspenders: also clear backgroundThrottling on the live
  // webContents in case a future Electron honours the runtime setter over the
  // constructor option. Harmless if redundant. (UI-responsiveness only as of
  // v0.1.81 — see the webPreferences comment above; TTS is native/main now.)
  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch (err) {
    console.warn('[main] setBackgroundThrottling(false) failed', err);
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  if (process.env.RC_DEVTOOLS === '1') mainWindow.webContents.openDevTools();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // v0.1.83 — null the module-level `mainWindow` handle the moment the
  // BrowserWindow is closed. WHY this matters:
  //   On macOS, closing the only window does NOT quit the app — the
  //   `window-all-closed` handler (below) only calls `app.quit()` on
  //   non-darwin. So the app + the application menu stay alive with no
  //   visible window. Without this listener, `mainWindow` would remain a
  //   NON-NULL reference to a DESTROYED BrowserWindow. Every `mainWindow?.…`
  //   guard sprinkled through this file uses optional chaining, which only
  //   short-circuits on `null`/`undefined` — it does NOT detect a destroyed
  //   window. Calling `.webContents` on a destroyed window throws
  //   synchronously, and inside a menu-click handler Electron surfaces that
  //   throw as the cryptic macOS alert "this command is disabled and cannot
  //   be executed" (the exact symptom that hit the Preferences… item).
  //   Setting the handle back to `null` on `closed` makes every existing
  //   `mainWindow?.` guard genuinely short-circuit after the window is gone,
  //   and the `app.on('activate')` handler recreates + reassigns it when the
  //   user re-opens via the Dock.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Broadcast the renderer-side "clear chat" action — used by both the
 * application-menu "Clear chat" item (Cmd+K) and the chat-feed context-menu
 * "Clear chat" item. Wraps the IPC send in a try/catch so a torn-down
 * mainWindow can't crash a menu click handler. v0.1.18.
 */
function broadcastChatClear(win: BrowserWindow | null): void {
  try {
    win?.webContents.send(IPC.CHAT_CLEAR);
  } catch (err) {
    console.error('[main] broadcastChatClear failed', err);
  }
}

/**
 * Open the renderer's settings panel from the application-menu
 * "Preferences…" item (Cmd+,). v0.1.83.
 *
 * Extracted into a named helper (mirroring `broadcastChatClear`) so the
 * defensive guard is unit-testable WITHOUT spinning up a real Electron
 * menu. The bug this guards against: on macOS the app + menu outlive the
 * only window, so `win` can be a NON-NULL but DESTROYED BrowserWindow.
 * `win?.` only short-circuits `null`, not a destroyed window, and touching
 * `.webContents` on a destroyed window throws synchronously — which
 * Electron's menu dispatcher surfaces as the macOS "this command is
 * disabled and cannot be executed" alert. We therefore (1) bail on a null
 * OR destroyed window, and (2) wrap the send in try/catch as a final
 * safety net (a window can be torn down between the isDestroyed() check
 * and the send in a re-entrant edge case). Exported for tests only.
 */
export function openSettingsFromMenu(win: BrowserWindow | null): void {
  // Guard BOTH null (window never created / already nulled on `closed`)
  // and destroyed (stale handle that the `closed` listener hasn't cleared
  // yet) before touching webContents.
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('menu:open-settings');
  } catch (err) {
    console.error('[main] openSettingsFromMenu failed', err);
  }
}

function buildMenu(onRevealLogs: () => void) {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Restream Chat++',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                id: 'check-for-updates-now',
                label: 'Check for Updates Now…',
                enabled: true,
                // v0.1.37: `checkForUpdatesInteractive` now uses the
                // GH-Releases pipeline as the authoritative source for
                // the user-facing dialog (instead of Squirrel's
                // `autoUpdater.checkForUpdates()`). Pre-v0.1.37 the
                // dialog and the banner could disagree — on unsigned
                // builds Squirrel reported "you're on the latest
                // version" while GH-Releases said `available`. Voice
                // 3351 called this out explicitly. The menu click
                // therefore only needs ONE call now; the function
                // internally also kicks Squirrel in the background on
                // signed builds so the in-app pipeline still gets a
                // chance to run.
                //
                // The click handler MUST NOT throw synchronously —
                // Electron surfaces a sync throw as the macOS system
                // alert "this command is disabled and cannot be
                // executed". Wrap defensively.
                click: () => {
                  try {
                    void checkForUpdatesInteractive(mainWindow).catch((err) =>
                      console.error('[menu] check-for-updates failed', err),
                    );
                  } catch (err) {
                    console.error('[menu] check-for-updates threw sync', err);
                  }
                },
              },
              { type: 'separator' as const },
              {
                label: 'Preferences…',
                accelerator: 'CmdOrCtrl+,',
                // v0.1.83 — belt-and-suspenders guard mirroring the other
                // menu click handlers (check-for-updates, reveal-logs,
                // clear-chat are all defensively wrapped). The root fix is
                // the `closed → mainWindow = null` listener in
                // createMainWindow(), but we ALSO guard here so that even a
                // stale/destroyed handle (e.g. a `closed` event that hasn't
                // fired yet, or a future refactor that drops the listener)
                // can never throw out of the click dispatcher. A sync throw
                // here would surface as the macOS "this command is disabled
                // and cannot be executed" alert — see openSettingsFromMenu.
                click: () => openSettingsFromMenu(mainWindow),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Reveal Logs in Finder',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            try {
              onRevealLogs();
            } catch (err) {
              console.error('[menu] reveal-logs failed', err);
            }
          },
        },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Chat',
      submenu: [
        {
          label: 'Clear Chat',
          accelerator: 'CmdOrCtrl+K',
          click: () => broadcastChatClear(mainWindow),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Restream Chat++',
          click: () =>
            shell.openExternal('https://github.com/EthanSK/restream-chat-plus-plus'),
        },
        ...(isMac
          ? []
          : [
              {
                id: 'check-for-updates-help',
                label: 'Check for Updates Now…',
                enabled: true,
                // v0.1.37: see Mac App-menu equivalent for the
                // reconciliation rationale. Single GH-Releases-backed
                // call; Squirrel kick is internal to
                // `checkForUpdatesInteractive` so the dialog and the
                // banner agree.
                click: () => {
                  try {
                    void checkForUpdatesInteractive(mainWindow).catch((err) =>
                      console.error('[menu] check-for-updates failed', err),
                    );
                  } catch (err) {
                    console.error('[menu] check-for-updates threw sync', err);
                  }
                },
              },
            ]),
        {
          label: 'View Releases',
          click: () =>
            shell.openExternal(
              'https://github.com/EthanSK/restream-chat-plus-plus/releases',
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('ready', async () => {
  const store = await createStore();
  const oauth = new OAuthCoordinator(store);
  const chat = new ChatClient();

  app.setName('Restream Chat++');

  // v0.1.74 (Ethan voice 4407, 2026-05-30) — BACKGROUND-TTS FIX, layer 3.
  // ----------------------------------------------------------------------
  // macOS App Nap can suspend a backgrounded app entirely — timers freeze,
  // the renderer stops doing work, and (critically) the main-process `say`
  // queue can stall mid-utterance. `powerSaveBlocker.start(
  // 'prevent-app-suspension')` tells the OS to keep the app fully running
  // even when it's not frontmost, which is exactly what we need so chat
  // messages keep being voiced while RC++ sits behind other windows.
  //
  // We hold the blocker for the entire app lifetime (started here, never
  // explicitly stopped — it's released automatically on quit). The blocker
  // does NOT keep the *display* awake (that would be
  // 'prevent-display-sleep'); it only prevents *app* suspension, so the
  // user's screen can still sleep normally.
  //
  // Wrapped defensively: if powerSaveBlocker is unavailable for any reason
  // the app must still boot — a missing nap-guard degrades to "TTS may
  // stall under heavy App Nap" rather than a crash.
  try {
    const blockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[main] powerSaveBlocker(prevent-app-suspension) started', {
      blockerId,
      active: powerSaveBlocker.isStarted(blockerId),
    });
  } catch (err) {
    console.warn('[main] powerSaveBlocker.start failed', err);
  }

  // v0.1.66 attempted to call `app.configureWebAuthn({ touchID: { ... } })`
  // here to surface the macOS passkey sheet during Google sign-in (per
  // Codex xhigh review of voice 3995). That call requires a paired
  // `keychain-access-groups` entitlement in entitlements.mac.plist,
  // which in turn requires a Developer ID provisioning profile
  // (`Contents/embedded.provisionprofile`) on modern macOS —
  // `taskgated-helper` refuses to launch any app that claims
  // `keychain-access-groups` without a matching provisioning profile.
  //
  // v0.1.67 REVERTS that approach because v0.1.66 launch-failed in
  // production. Getting platform-passkey support back is a separate
  // workstream — see the comment in build/entitlements.mac.plist for
  // the App Store Connect / provisioning-profile steps required.
  //
  // The v0.1.65 OAuth-window fixes (UA strip + permission handler) are
  // still in place in src/main/oauth.ts because they're useful for any
  // future WebAuthn path (security key, cross-device passkey, etc.) and
  // don't depend on platform-authenticator support.

  buildMenu(() => revealLogsInFinder(chat.getRawLogPath()));
  await createMainWindow();

  /**
   * Helper: build + broadcast the current AuthStatus to the renderer.
   * Centralised so every code path that mutates auth — initial resume,
   * background refresh on startup, scheduled refresh, manual sign-in / out,
   * Reconnect — pushes a consistent shape to the UI.
   *
   * Uses the in-memory cached value populated by the deferred decrypt
   * (`getTokenAsync`) — does NOT trigger a Keychain prompt itself. The
   * boot resume path calls `getTokenAsync` first so this push reflects
   * the post-decrypt truth.
   */
  function pushAuthStatus(): AuthStatus {
    const t = oauth.getToken();
    const status: AuthStatus = {
      authenticated: oauth.isAuthenticated(),
      scope: t?.scope,
      expiresAt: t?.expiresAt,
    };
    try {
      mainWindow?.webContents.send(IPC.AUTH_STATUS, status);
    } catch (err) {
      console.error('[main] pushAuthStatus send failed', err);
    }
    return status;
  }

  /**
   * Promise that resolves when the startup auth flow has finished — either
   * the stored access token was still valid (synchronous resume) or the
   * background `oauth.refresh()` settled (success or failure).
   *
   * The `did-finish-load` handler waits on this BEFORE sending the initial
   * AUTH_STATUS to the renderer. Without the wait we'd race: a renderer
   * that mounts before refresh completes would receive `authenticated:
   * false` (because the stored access token is past expiresAt) and render
   * the "Sign in" screen — even though a successful refresh moments later
   * silently re-armed the token. The user perceives this as "every update
   * logs me out" because Squirrel's update-then-restart cycle puts the app
   * into exactly this expired-access-token state. v0.1.15 fix.
   */
  let resolveStartupAuth: () => void = () => {
    // Default no-op; replaced synchronously by the Promise executor below.
  };
  const startupAuthDone = new Promise<void>((res) => {
    resolveStartupAuth = res;
  });

  // When the renderer finishes loading, push the CURRENT connection state +
  // current auth status so the renderer doesn't sit on its initial 'idle'
  // placeholder. The push-only IPC channel (CONN_STATE) only delivers
  // updates; if chat.start() ran before the renderer mounted (auth resume
  // path), the renderer would otherwise never receive the initial state.
  //
  // We await `startupAuthDone` so a renderer that mounts BEFORE the
  // background `oauth.refresh()` completes doesn't get a misleading
  // `authenticated: false` snapshot and flash the sign-in screen at the
  // user. The connection-state + connections lists ARE sent immediately
  // so unrelated UI doesn't stall on the auth-resume code path.
  mainWindow?.webContents.on('did-finish-load', async () => {
    try {
      mainWindow?.webContents.send(IPC.CONN_STATE, chat.getState());
      mainWindow?.webContents.send(IPC.CONNECTIONS, chat.getConnections());
    } catch (err) {
      console.error('[main] failed to send initial conn state on did-finish-load', err);
    }
    try {
      await startupAuthDone;
      pushAuthStatus();
    } catch (err) {
      console.error('[main] failed to send initial auth status on did-finish-load', err);
    }
  });

  // Wire auto-update polling (update.electronjs.org → GitHub Releases).
  // Skipped automatically in dev / when not packaged / when running unsigned.
  configureAutoUpdater();

  // Wire the GH-Releases-API-backed update checker. Unlike the Squirrel-based
  // path above, this works on unsigned builds — it only ANSWERS "is there a
  // newer release?" and "where is it?", then surfaces a banner with a
  // Download button that opens the release page in the user's browser.
  // The poller reads `settings.update.autoCheck` at every tick so toggling
  // the Settings switch takes effect without a restart.
  startGithubUpdatePoller(() => loadSettings().update.autoCheck);

  // ----- IPC: auth -----
  ipcMain.handle(IPC.AUTH_START, async () => {
    try {
      const tok = await oauth.authenticate();
      // v0.1.62 — guarantee chat-partition cookies are present before
      // declaring the app send-ready. The v0.1.59 ad-hoc → v0.1.61 signed
      // Developer ID transition split the app's auth state: OAuth token
      // got repaired by sign-in, but the `persist:restream-oauth`
      // chat-partition cookies (`accessXsrfToken`, `refreshToken`,
      // `refreshXsrfToken`) were wiped because codesigning a different
      // identity flipped the partition's scope. From that point on every
      // `sendChatText` hit the `no-session-cookies` bail-out at the
      // pre-`performSend` cookie gate.
      //
      // The OAuth callback writes ONLY analytics cookies (the OAuth flow
      // doesn't pass through chat.restream.io itself), so the hidden
      // cookie-provisioner must run after every fresh sign-in to harvest
      // the chat-session cookies from chat.restream.io. If the headless
      // attempt fails we surface a visible window so the user can
      // complete the handshake interactively — much better UX than the
      // silent "everything looks signed in, every send fails" state Ethan
      // hit on v0.1.61. Errors swallowed so a transient cookie hydration
      // failure doesn't gate the auth path; the renderer can still try
      // to send (and will get the `no-session-cookies` preflight log
      // row if cookies still aren't there).
      try {
        const cookieState = await ensureRestreamChatCookies({
          parentWindow: mainWindow,
          interactiveFallback: true,
        });
        if (!cookieState.ok) {
          console.warn(
            '[main] ensureRestreamChatCookies after auth: ok=false reason=' +
              cookieState.reason +
              ' cookieCount=' +
              cookieState.cookieCount,
          );
          // v0.1.69 (voice 4015): cookie repair returning ok=false after
          // a fresh sign-in is the v0.1.62 split-auth signature in the
          // making — record so we can spot post-Sparkle-update users who
          // still need a manual cookie repair.
          appendErrorLog({
            subsystem: 'main',
            phase: 'main.post-auth-cookie-not-ok',
            errorMessage: `cookie repair after auth ok=false reason=${cookieState.reason}`,
            context: {
              reason: cookieState.reason,
              cookieCount: cookieState.cookieCount,
              hasXsrf: cookieState.hasXsrf,
            },
          });
        }
      } catch (cookieErr) {
        console.error('[main] ensureRestreamChatCookies threw', cookieErr);
        // v0.1.69 (voice 4015): a thrown cookie-repair is rarer than a
        // non-ok one but worth flagging — the user is "signed in" per
        // OAuth but no send will work until they restart.
        appendErrorLog({
          subsystem: 'main',
          phase: 'main.post-auth-cookie-threw',
          errorMessage: errorToString(cookieErr),
        });
      }
      chat.setToken(tok.accessToken);
      chat.start();
      const status: AuthStatus = {
        authenticated: true,
        scope: tok.scope,
        expiresAt: tok.expiresAt,
      };
      mainWindow?.webContents.send(IPC.AUTH_STATUS, status);
      return status;
    } catch (e: any) {
      const status: AuthStatus = { authenticated: false };
      mainWindow?.webContents.send(IPC.AUTH_STATUS, status);
      throw e;
    }
  });

  ipcMain.handle(IPC.AUTH_STATUS, async () => {
    // v0.1.38: await `getTokenAsync` so a renderer that pulls AUTH_STATUS
    // before the deferred decrypt has settled gets the correct truth
    // rather than a transient `authenticated: false`. After the first
    // launch tick this resolves from the in-memory cache instantly.
    const t = await oauth.getTokenAsync();
    const status: AuthStatus = {
      authenticated: await oauth.isAuthenticatedAsync(),
      scope: t?.scope,
      expiresAt: t?.expiresAt,
    };
    return status;
  });

  // ----- IPC: connection state (pull-fetch on renderer mount) -----
  // Pull-fetch counterpart to the push-only CONN_STATE channel. Renderer
  // calls this on mount to sync to the current truth (avoids the "stuck on
  // 'idle' because state transitioned before listener attached" bug).
  ipcMain.handle(IPC.CONN_STATE_GET, (): ConnectionState => chat.getState());

  // ----- IPC: reveal logs in Finder/Explorer (renderer button) -----
  ipcMain.handle(IPC.REVEAL_LOGS, () => revealLogsInFinder(chat.getRawLogPath()));

  // ----- IPC: TTS lifecycle log (v0.1.41 engine-wake diagnostic) -----
  // Fire-and-forget. Persists each speak / onstart / onend / onerror /
  // watchdog / keepalive / cancel event to tts-events.jsonl so we can
  // correlate intermittent subsequent-message skips without DevTools open.
  ipcMain.on(IPC.TTS_LOG, (_evt, payload: TtsLogEvent) => {
    if (!payload || typeof payload.event !== 'string') return;
    appendTtsLog(payload);
  });

  // ----- v0.1.42 native `say` engine wiring ------------------------------
  // Singleton lives for the lifetime of the main process. We seed it with
  // the currently-persisted Settings.tts values so the very first enqueue
  // already knows which voice to use; renderer pushes
  // `TTS_NATIVE_UPDATE_SETTINGS` whenever the user tweaks the dropdown.
  const initialNativeSettings = ttsToNativeSettings(loadSettings().tts);
  const nativeTts = new NativeTtsEngine({
    settings: initialNativeSettings,
    log: (event, data) => {
      // Funnel native events through the same tts-events.jsonl writer
      // the renderer side already uses. Cast is safe because the
      // shared `TtsLogEvent` event union explicitly covers the
      // `native_*` names — see types.ts.
      appendTtsLog({ event: event as TtsLogEvent['event'], data });
    },
  });
  // Pre-warm the voice cache asynchronously so the first
  // `TTS_NATIVE_GET_VOICES` call from the Settings drawer feels instant.
  // Best-effort: a failure here doesn't break anything; the next call
  // re-probes lazily.
  void nativeTts.getAvailableVoices().catch((err) => {
    console.warn('[main] native voice pre-warm failed', err);
  });

  // ----- v0.1.76 main-process TTS + notification dispatcher (voice 4414) -----
  // The dispatcher OWNS the chat→speak decision now (filters, rate-limit,
  // same-id guard, backend choice). It's wired into `chat.on('message')` below
  // so EVERY incoming chat message is decided + dispatched from the background
  // process. The never-miss guarantee: when the window is genuinely hidden, the
  // dispatcher speaks via the native `say` engine here in main — no renderer
  // involvement — so a dead/wedged renderer can never swallow a message.
  const ttsDispatcher = new TtsDispatcher({
    loadSettings,
    // v0.1.81 (Ethan 2026-05-31: "lets just use system voice for everything
    // then. no more browser one. do it.") — speech is ALWAYS the native OS
    // voice now, on EVERY platform. The renderer Web-Speech engine was removed
    // because Chromium throttled/suspended it whenever the window wasn't
    // foreground (Ethan heard nothing). `nativeTts` is the cross-platform
    // engine (macOS `say` / Windows System.Speech / Linux spd-say|espeak) — see
    // src/main/tts-native.ts. No visibility detection, no backend choice, no
    // IPC-to-renderer-to-speak: just enqueue onto the native engine.
    speakNative: (text, opts) => {
      nativeTts.enqueue(text, opts);
    },
    notify: (title, body, silent) => {
      try {
        if (!Notification.isSupported()) return;
        new Notification({ title, body, silent }).show();
      } catch (err) {
        console.warn('[main] dispatcher notify failed', err);
      }
    },
    log: (event, data) => {
      appendTtsLog({ event: event as TtsLogEvent['event'], data });
    },
  });

  ipcMain.on(IPC.TTS_NATIVE_ENQUEUE, (_evt, payload: TtsNativeEnqueuePayload) => {
    if (!payload || typeof payload.text !== 'string') return;
    nativeTts.enqueue(payload.text, {
      voice: payload.voice,
      rate: payload.rate,
      volume: payload.volume,
      messageId: payload.messageId,
    });
  });
  ipcMain.on(IPC.TTS_NATIVE_CANCEL, () => {
    nativeTts.cancel();
  });
  ipcMain.on(
    IPC.TTS_NATIVE_UPDATE_SETTINGS,
    (_evt, payload: TtsNativeSettingsPayload) => {
      if (!payload) return;
      nativeTts.updateSettings({
        voiceURI: payload.voiceURI,
        rate: typeof payload.rate === 'number' ? payload.rate : 1.0,
        volume: typeof payload.volume === 'number' ? payload.volume : 1.0,
      });
    },
  );
  ipcMain.handle(IPC.TTS_NATIVE_GET_VOICES, async (): Promise<NativeVoiceWire[]> => {
    try {
      const voices: NativeVoice[] = await nativeTts.getAvailableVoices();
      // Pass-through: NativeVoice and NativeVoiceWire are structurally
      // identical (kept that way deliberately so this stays free).
      return voices;
    } catch (err) {
      console.warn('[main] native getVoices failed', err);
      return [];
    }
  });
  // v0.1.81 — Settings voice-PREVIEW. Renderer sends the voice name (or
  // undefined for the OS default); the native engine cancels any in-flight
  // preview and speaks "Hello, my name is <voice>" at the current rate/volume.
  // This replaced the renderer Web-Speech preview when the browser engine was
  // removed — preview, like all speech, now uses the native OS voice.
  ipcMain.on(IPC.TTS_NATIVE_PREVIEW, (_evt, voiceURI?: unknown) => {
    try {
      const v = typeof voiceURI === 'string' && voiceURI.length > 0 ? voiceURI : undefined;
      nativeTts.preview(v);
    } catch (err) {
      console.warn('[main] native preview failed', err);
    }
  });
  // SIGTERM the in-flight `say` subprocess on quit so we don't leak
  // a half-spoken utterance into the user's audio output after the
  // window closes.
  app.on('before-quit', () => {
    try {
      nativeTts.cancel();
    } catch (err) {
      console.warn('[main] nativeTts.cancel on quit failed', err);
    }
    // v0.1.70 (sign-out diagnosis 2026-05-25): tear down the
    // transient-refresh retry timer on quit so it doesn't keep the
    // event loop alive past the window close. The forward reference
    // is fine — `cancelTransientRefreshRetry` is declared further down
    // in the same closure but this callback fires later (on quit).
    try {
      cancelTransientRefreshRetry();
    } catch (err) {
      console.warn('[main] cancelTransientRefreshRetry on quit failed', err);
    }
  });

  // -------------------------------------------------------------------
  // v0.1.70 (sign-out diagnosis 2026-05-25): transient-refresh-retry
  // watchdog instance. The exponential-backoff state machine lives in
  // src/main/transient-refresh-retry.ts (factored out so it can be
  // unit-tested with Vitest fake timers). Here we just wire the hooks
  // that drive Electron-specific side effects: renderer AUTH_STATUS
  // pushes, chat.setToken/reconnect, structured logging.
  //
  // See `transient-refresh-retry.ts` for the full bug write-up + state
  // machine documentation.
  // -------------------------------------------------------------------
  const transientRetry = new TransientRefreshRetryController({
    // Tick action: refresh + classify into the controller's union.
    refresh: async () => {
      // Attempt the refresh. We don't gate on token expiry here — the
      // user is in a known-stranded state, so a forced refresh is the
      // recovery action even if `expiresAt` is technically still in
      // the future (transient failures don't move expiresAt).
      const refreshed = await oauth.refresh();
      if (refreshed) return 'success';
      const cls = oauth.getLastRefreshFailure();
      if (cls === 'fatal') return 'fatal';
      // Treat 'none' (no token / no creds — shouldn't happen here
      // since the cycle is only armed after a prior transient failure
      // with tokens still on disk) as transient: re-arm and try again.
      return 'transient';
    },
    onSuccess: () => {
      // ---- Recovery success ----
      // Drive the same post-refresh side effects performFullReconnect
      // would have done if the original refresh hadn't blown up:
      // (1) push authenticated:true to flip renderer back to signed-in
      // UI; (2) update the WS client's cached token; (3) trigger a
      // fresh handshake so chat messages start flowing again.
      const token = oauth.getToken();
      if (token) {
        mainWindow?.webContents.send(IPC.AUTH_STATUS, {
          authenticated: true,
          scope: token.scope,
          expiresAt: token.expiresAt,
        } satisfies AuthStatus);
        try {
          chat.setToken(token.accessToken);
          chat.reconnect();
        } catch (chatErr) {
          // chat.setToken / chat.reconnect failure here is rare and
          // doesn't undo the recovery — the renderer is already back
          // in signed-in state. Surface as a structured row so
          // post-mortem can correlate, but don't re-arm the timer.
          console.error('[main] transient-refresh-recovered chat handoff failed', chatErr);
          appendErrorLog({
            subsystem: 'oauth',
            phase: 'oauth.transient-refresh-recovered-chat-failed',
            errorMessage: errorToString(chatErr),
          });
        }
      }
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.transient-refresh-recovered',
        errorMessage: 'transient-refresh recovered',
      });
    },
    onFatal: () => {
      // ---- Give up: 4xx promotion to fatal ----
      // refresh() already called logout() and wiped tokenEnc. The
      // user truly does need to re-auth. Push the final signed-out
      // state (NO tokenLikelyValid — we don't want the renderer to
      // render the "Reconnecting…" banner because there's no recovery
      // possible).
      mainWindow?.webContents.send(IPC.AUTH_STATUS, {
        authenticated: false,
      } satisfies AuthStatus);
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.transient-refresh-give-up',
        errorMessage: 'transient-refresh escalated to fatal',
      });
    },
    onTick: (info) => {
      // Don't push a new AUTH_STATUS here — the renderer already has
      // `authenticated: false, tokenLikelyValid: true,
      // reconnectingDueToTransient: true` from the original
      // performFullReconnect transient-branch push, so the banner
      // stays up. Just log + bump.
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.transient-refresh-recovery-tick',
        errorMessage: `still transient; next retry in ${info.nextDelayMs}ms (origin=${info.origin})`,
        context: info,
      });
    },
    onError: (err, origin) => {
      console.error('[main] transient-refresh tick threw', err);
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.transient-refresh-tick-threw',
        errorMessage: errorToString(err),
        context: { origin },
      });
    },
  });

  // Closure-scoped facades — keep the existing call sites' contract
  // (`armTransientRefreshRetry(origin)` / `cancelTransientRefreshRetry()`)
  // stable so the diff stays focused on the state-machine extraction.
  const armTransientRefreshRetry = (origin: string): void =>
    transientRetry.arm(origin);
  const cancelTransientRefreshRetry = (): void => transientRetry.cancel();

  // v0.1.70 — make the watchdog reachable from startup-auth-resume.
  // startup-auth-resume.ts runs BEFORE the renderer attaches its
  // AUTH_STATUS listener, but it CAN observe `getLastRefreshFailure()`
  // after its boot-time `refresh()` call returns undefined. If startup
  // sees a transient failure, it should arm the watchdog so the user
  // gets the self-healing experience on the very first launch after a
  // network blip (e.g. wake-from-sleep into a still-handshaking VPN).
  const armTransientRefreshRetryFromStartup = (): void =>
    armTransientRefreshRetry('startup');

  // ----- v0.1.45: unified reconnect flow -----
  //
  // Single source of truth for "tear down the live WebSocket, refresh
  // OAuth if needed, open a fresh handshake". Used by BOTH the manual
  // Reconnect toolbar button (via IPC.CONN_RECONNECT) and the auto-retry
  // path inside ChatClient (installed via setReconnectProvider below).
  //
  // Pre-v0.1.45, the auto-retry path called `this.connect()` directly
  // with the cached access token — no OAuth refresh, no token lookup.
  // If the token expired during the disconnect window, every retry
  // handshake failed and the loop ran forever without ever
  // re-handshaking; only the manual button worked because only the
  // manual button refreshed. Ethan voice: "reconnecting does nothing in
  // restream++ but if i click the reconnect button manually it works.
  // shouldnt it use the same mechanism".
  //
  // Returns an outcome the WS client can log + react to. Throws on
  // genuinely unexpected failures (everything inside the try is caught
  // so the only way to throw is a `pushAuthStatus`-side error or a
  // synchronous `chat.reconnect()` crash — both vanishingly rare).
  const performFullReconnect = async (): Promise<{
    ok: boolean;
    reason?:
      | 'not-authenticated'
      | 'error'
      | 'refresh-failed';
    error?: string;
  }> => {
    try {
      // v0.1.38: async getter — picks up the deferred decrypt result if
      // the reconnect button is clicked before the boot decrypt settled.
      let token = await oauth.getTokenAsync();
      // If the token is missing or about-to-expire, refresh before reconnect.
      // This is the recovery path for a session that's been backgrounded
      // long enough for the access token to lapse — without this, the new
      // WS would open with a stale token and immediately get closed by the
      // server with 401 / handshake fail.
      const aboutToExpire = !token || token.expiresAt - Date.now() < 60_000;
      if (aboutToExpire && token?.refreshToken) {
        const refreshed = await oauth.refresh();
        if (refreshed) {
          token = refreshed;
          mainWindow?.webContents.send(IPC.AUTH_STATUS, {
            authenticated: true,
            scope: refreshed.scope,
            expiresAt: refreshed.expiresAt,
          } satisfies AuthStatus);
        } else {
          // v0.1.70 (sign-out diagnosis 2026-05-25): discriminate
          // transient vs fatal so a single network blip doesn't
          // permanently strand the user on the sign-in screen.
          //
          // Pre-v0.1.70 every undefined-return from refresh() got the
          // same `authenticated: false` push, even though `tokenEnc`
          // was still on disk in the transient case (5xx / fetch threw)
          // and a later retry could recover. The result: Ethan saw
          // ONE `fetch threw` row in reconnect-events.jsonl, then
          // 19 hours of sign-in screen with no recovery, despite the
          // refresh-token still being valid.
          const cls = oauth.getLastRefreshFailure();
          if (cls === 'transient') {
            // 5xx / fetch threw — tokenEnc still on disk. Hint the
            // renderer this is recoverable + arm the periodic retry so
            // the user doesn't have to manually re-auth when the
            // network comes back. The renderer renders a
            // "Reconnecting…" banner with a "Retry now" button instead
            // of the bare sign-in CTA.
            mainWindow?.webContents.send(IPC.AUTH_STATUS, {
              authenticated: false,
              tokenLikelyValid: true,
              reconnectingDueToTransient: true,
            } satisfies AuthStatus);
            armTransientRefreshRetry('performFullReconnect');
            appendErrorLog({
              subsystem: 'oauth',
              phase: 'oauth.transient-refresh-keep-trying',
              errorMessage: 'refresh transient; armed retry loop, tokenEnc preserved',
            });
            return { ok: false, reason: 'refresh-failed' };
          }
          // Fatal — refresh() already called logout() and wiped the
          // token. Reconnecting with this token would just produce a
          // doomed handshake and a noisy reconnect loop. Surface the
          // auth failure so the renderer can prompt re-auth via the
          // existing AUTH_STATUS channel. Codex review (v0.1.7)
          // flagged this as MUST-FIX.
          mainWindow?.webContents.send(IPC.AUTH_STATUS, {
            authenticated: false,
          } satisfies AuthStatus);
          return { ok: false, reason: 'refresh-failed' };
        }
      }
      if (!token) {
        return { ok: false, reason: 'not-authenticated' };
      }
      chat.setToken(token.accessToken);
      chat.reconnect();
      // v0.1.70: the token works again, so any prior transient-refresh
      // retry cycle is moot. Cancel the timer + reset the backoff so the
      // NEXT transient cycle (next time the user puts the laptop to
      // sleep) starts fresh at 2m rather than wherever the previous
      // cycle was capped.
      cancelTransientRefreshRetry();
      return { ok: true };
    } catch (err) {
      console.error('[main] performFullReconnect failed', err);
      return {
        ok: false,
        reason: 'error',
        error: String((err as Error)?.message ?? err),
      };
    }
  };

  // Install the unified-reconnect hook on the ChatClient so the
  // post-close auto-retry inside ws-client.ts runs the SAME flow
  // (OAuth-refresh + chat.reconnect) as the manual toolbar button.
  // v0.1.45 fix — see performFullReconnect comment for the why.
  chat.setReconnectProvider(async () => {
    const out = await performFullReconnect();
    return {
      ok: out.ok,
      reason: out.ok ? undefined : (out.reason ?? out.error ?? 'unknown'),
    };
  });

  // Persist each auto-retry attempt to a JSONL audit log so disconnect
  // loops are diagnosable without DevTools open.
  //   ~/Library/Logs/Restream Chat++/reconnect-events.jsonl
  // (path mirrors the existing raw-frames.jsonl resolution in
  // ws-client.ts; lives next to it in the same logs dir.)
  chat.setAutoAttemptListener((entry) => {
    appendReconnectEventLog({
      ts: new Date().toISOString(),
      attempt: entry.attempt,
      reason: entry.reason,
      outcome: entry.outcome,
      failureReason: entry.failureReason,
    });
  });

  // v0.1.73 (Ethan voice 4364, 2026-05-28) — re-enable the v0.1.45
  // 60s auto-reconnect timer at app boot. The field-default in
  // ws-client.ts stays `false` so unit tests keep deterministic
  // control; the SHIPPING app opts in here.
  //
  // CRITICAL ORDER: this MUST be called AFTER `setReconnectProvider`
  // above. The provider is what the auto-tick runs (`performFullReconnect`
  // → OAuth refresh + chat.reconnect); without it the tick would fall
  // back to the legacy bare-WS reconnect which doesn't refresh the
  // OAuth token first. See `ws-client.ts` AUTO_RETRY_INTERVAL_MS
  // comment block for the full why (v0.1.47 disable → v0.1.73 re-enable).
  chat.setAutoReconnectEnabled(true);

  // ----- IPC: force reconnect (renderer "Reconnect" toolbar button) -----
  // Wires the manual button to the SAME performFullReconnect function
  // the auto-retry path uses. v0.1.45.
  ipcMain.handle(IPC.CONN_RECONNECT, async () => {
    const out = await performFullReconnect();
    if (out.ok) {
      // v0.1.88 (voice 4504): the MANUAL Reconnect button just succeeded —
      // re-subscribe is in flight. Tell the renderer so it sweeps + clears any
      // lingering ⚠ on HTTP-200 sends (same resolution the automatic managed
      // recoveries trigger via chat's 'reconnect-succeeded' event below). The
      // manual path is owned by THIS handler — ws-client doesn't emit for it —
      // so we send the IPC directly here to avoid a double-forward.
      try {
        mainWindow?.webContents.send(IPC.CONN_RECONNECT_SUCCEEDED, 'manual-reconnect');
      } catch (err) {
        console.error('[main] CONN_RECONNECT_SUCCEEDED (manual) emit failed', err);
      }
      return { ok: true as const };
    }
    if (out.reason === 'not-authenticated' || out.reason === 'refresh-failed') {
      return { ok: false, reason: 'not-authenticated' as const };
    }
    return {
      ok: false,
      reason: 'error' as const,
      error: out.error,
    };
  });

  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
    // v0.1.70: user is explicitly signing out — cancel any armed
    // transient-refresh retry BEFORE logout() wipes the token. Otherwise
    // a pending timer would fire mid-logout, call refresh() against the
    // (now-missing) refreshToken, get the no-token early return
    // (classified as 'none' per refreshInner's reset), and push a
    // weird `authenticated: true` to a renderer that was just told the
    // user signed out. Race-free with this cancel-first ordering.
    cancelTransientRefreshRetry();
    chat.stop();
    await oauth.logout();
    const status: AuthStatus = { authenticated: false };
    mainWindow?.webContents.send(IPC.AUTH_STATUS, status);
    return status;
  });

  // v0.1.52: native Sign Out confirmation dialog.
  //
  // Pre-v0.1.52 the renderer used `window.confirm()` to gate the
  // destructive sign-out. In our Electron BrowserWindow config
  // (`sandbox: false`, `contextIsolation: true`), `window.confirm` was
  // returning `false` synchronously without ever showing a dialog —
  // so the renderer's `shouldProceedWithSignOut` short-circuited and
  // `authLogout()` was never called. To the user: "I click Sign out
  // and nothing happens". Ethan voice 3719.
  //
  // Fix: route the prompt through `dialog.showMessageBox` from main
  // (a real native modal that always renders). The renderer awaits the
  // boolean and only fires AUTH_LOGOUT on `true`. dialog.showMessageBox
  // is documented stable across all supported Electron versions.
  ipcMain.handle(IPC.AUTH_CONFIRM_LOGOUT, async () => {
    try {
      const parent = mainWindow ?? undefined;
      const result = parent
        ? await dialog.showMessageBox(parent, {
            type: 'warning',
            buttons: ['Cancel', 'Sign out'],
            defaultId: 0,
            cancelId: 0,
            message: 'Sign out of Restream?',
            detail: "You'll need to re-authenticate on next launch.",
          })
        : await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Cancel', 'Sign out'],
            defaultId: 0,
            cancelId: 0,
            message: 'Sign out of Restream?',
            detail: "You'll need to re-authenticate on next launch.",
          });
      return result.response === 1;
    } catch (err) {
      console.error('[main] authConfirmLogout dialog threw', err);
      // Fail closed — never log the user out if the prompt errored.
      return false;
    }
  });

  // ----- IPC: settings -----
  // Merge persisted settings over DEFAULT_SETTINGS so new fields (e.g.
  // tts.readSenderName introduced in v0.1.9) don't come back as `undefined`
  // when an older settings blob is loaded from disk. Shallow per-section
  // merge is enough — every section is a flat object.
  function loadSettings(): Settings {
    const stored = store.get('settings') as Partial<Settings> | undefined;
    if (!stored) {
      // Fresh install — still mark migrations as already applied so the
      // user doesn't get the seed re-injected if they later delete it
      // from the Settings drawer (DEFAULT_SETTINGS already carries the
      // v0.1.48 `^viewer$` seed; no migration work to do here).
      markMigrationApplied(SEED_VIEWER_MIGRATION_KEY);
      return DEFAULT_SETTINGS;
    }
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      tts: { ...DEFAULT_SETTINGS.tts, ...(stored.tts ?? {}) },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...(stored.notifications ?? {}) },
      filter: {
        ...DEFAULT_SETTINGS.filter,
        ...(stored.filter ?? {}),
        platforms: { ...DEFAULT_SETTINGS.filter.platforms, ...(stored.filter?.platforms ?? {}) },
      },
      // v0.1.26 regex-ignore lists. Two-level merge so a persisted blob
      // that has `filters.tts.ignoreRegex` but not `filters.notifications`
      // (or vice versa, or neither — pre-v0.1.26 blobs lack the section
      // entirely) still resolves to fully-typed arrays via the defaults.
      //
      // IMPORTANT: an EXISTING `stored.filters.tts.ignoreRegex` (e.g. an
      // empty array from a pre-v0.1.48 install) OVERRIDES the default
      // `['^viewer$']` here — that's why v0.1.48 also has the one-time
      // migration below (`applySettingsMigrations`) that injects the seed
      // into a persisted blob if it hasn't been injected before.
      filters: {
        ...DEFAULT_SETTINGS.filters,
        ...(stored.filters ?? {}),
        tts: {
          ...DEFAULT_SETTINGS.filters.tts,
          ...(stored.filters?.tts ?? {}),
        },
        notifications: {
          ...DEFAULT_SETTINGS.filters.notifications,
          ...(stored.filters?.notifications ?? {}),
        },
      },
      update: { ...DEFAULT_SETTINGS.update, ...(stored.update ?? {}) },
    };
    return applySettingsMigrations(merged);
  }

  // ---------------------------------------------------------------------
  // v0.1.48 one-time settings migrations.
  //
  // Persisted settings from a pre-v0.1.48 install will already have
  // `filters.tts.ignoreRegex` / `filters.notifications.ignoreRegex` set
  // (typically `[]`), which means the shallow merge in `loadSettings`
  // OVERRIDES the new v0.1.48 default `['^viewer$']` seed. To make sure
  // upgrading users actually get the seed (not just fresh installs), we
  // record which migrations we've already applied in
  // `store.settingsMigrationsApplied` and inject the seed exactly once.
  //
  // Idempotency: if the user has since deliberately removed the entry
  // from the Settings drawer, the migration key is still marked applied,
  // so we don't bring it back. If the user already had `^viewer$` in the
  // list (e.g. added it manually before upgrading), the migration is a
  // no-op for that list (we de-dupe before writing).
  // ---------------------------------------------------------------------
  function hasMigrationBeenApplied(key: string): boolean {
    const applied = (store.get('settingsMigrationsApplied') ?? []) as string[];
    return Array.isArray(applied) && applied.includes(key);
  }

  function markMigrationApplied(key: string): void {
    const applied = (store.get('settingsMigrationsApplied') ?? []) as string[];
    if (!Array.isArray(applied)) {
      store.set('settingsMigrationsApplied', [key]);
      return;
    }
    if (applied.includes(key)) return;
    store.set('settingsMigrationsApplied', [...applied, key]);
  }

  function applySettingsMigrations(settings: Settings): Settings {
    let next = settings;
    if (!hasMigrationBeenApplied(SEED_VIEWER_MIGRATION_KEY)) {
      const seed = '^viewer$';
      const ttsList = next.filters?.tts?.ignoreRegex ?? [];
      const notifList = next.filters?.notifications?.ignoreRegex ?? [];
      const ttsHas = ttsList.includes(seed);
      const notifHas = notifList.includes(seed);
      if (!ttsHas || !notifHas) {
        next = {
          ...next,
          filters: {
            ...next.filters,
            tts: {
              ...next.filters.tts,
              ignoreRegex: ttsHas ? ttsList : [...ttsList, seed],
            },
            notifications: {
              ...next.filters.notifications,
              ignoreRegex: notifHas ? notifList : [...notifList, seed],
            },
          },
        };
        // Persist the seeded blob back so the renderer reads the same
        // value on its next IPC call (settings drawer textarea will
        // show `^viewer$` populated, matching what the filter applies).
        store.set('settings', next);
      }
      markMigrationApplied(SEED_VIEWER_MIGRATION_KEY);
    }
    return next;
  }
  // Persist Settings + return the saved value. Pulled out as a named
  // helper so the in-process HTTP MCP server (`mcp-server.ts`,
  // v0.1.36+) can write through the same path — that guarantees the
  // store + the on-disk JSON + the IPC contract all stay aligned.
  //
  // v0.1.42: also pushes the latest TTS slice into the native engine so
  // a setting change via SETTINGS_SET (UI) or the MCP path picks up
  // immediately for the next enqueue, with no restart needed.
  function saveSettings(settings: Settings): Settings {
    // v0.1.84 — cancel in-flight/queued native TTS on a "silence" transition,
    // ATOMICALLY with the persist, from the MAIN process.
    //
    // Why this moved here from the renderer (App.tsx updateSettings):
    //   1. Renderer race — the renderer used to fire `ttsNative.cancel()` and
    //      THEN `setSettings(next)` as TWO separate IPCs. A chat message arriving
    //      in main BETWEEN them read the still-unmuted settings, enqueued, and
    //      the v0.1.82 drain spoke it AFTER the user hit mute. Doing the cancel
    //      inside the same synchronous saveSettings call that flips the flags
    //      closes that window — there is no longer a moment where the persisted
    //      settings say "muted" but the queue hasn't been cleared.
    //   2. MCP bypass — `set_tts_enabled(false)` (and any other MCP settings
    //      write) goes through saveSettings via the live bridge, which only ever
    //      called `updateSettings()` (future-utterance config) and NEVER
    //      cancelled. So disabling TTS over MCP left the current utterance + the
    //      whole backlog playing. Centralising the cancel here covers it.
    //
    // We snapshot the PREVIOUS persisted tts flags BEFORE overwriting the store,
    // then use the SHARED `shouldCancelNativeTtsOnSettingsChange` predicate (the
    // single source of truth, also imported by the renderer) to decide. The
    // predicate only returns true on the INTO-silence direction, so un-muting /
    // re-enabling never cancels (and never replays the muted backlog).
    const prevTts = (store.get('settings') as Settings | undefined)?.tts;
    store.set('settings', settings);
    if (prevTts && shouldCancelNativeTtsOnSettingsChange(prevTts, settings.tts)) {
      try {
        // cancel() SIGTERMs the speaking child + empties the pending FIFO queue,
        // so playback stops immediately and the backlog is dropped.
        nativeTts.cancel();
      } catch (err) {
        // Never let a cancel failure block the settings persist / update below.
        console.warn('[main] nativeTts.cancel on silence transition failed', err);
      }
    }
    try {
      nativeTts.updateSettings(ttsToNativeSettings(settings.tts));
    } catch (err) {
      console.warn('[main] nativeTts.updateSettings on saveSettings failed', err);
    }
    return settings;
  }
  ipcMain.handle(IPC.SETTINGS_GET, (): Settings => loadSettings());
  ipcMain.handle(IPC.SETTINGS_SET, (_evt, settings: Settings) => saveSettings(settings));

  // ----- IPC: GH-update status (pull-fetch on renderer mount) -----
  // The push channel (UPDATE_STATUS) only delivers updates; a renderer that
  // mounted AFTER the poller's 3s startup check completed would otherwise
  // never hear about an available update for the full hour until the next
  // poll. This handler returns the last broadcast UpdateInfo (or undefined
  // if no check has yet completed) so the renderer can sync on mount.
  ipcMain.handle(IPC.UPDATE_STATUS_GET, (): UpdateInfo | undefined => getLastUpdateInfo());

  // ----- IPC: force GH-update check (bypasses autoCheck setting) -----
  // Triggered by the "Check for Updates Now…" menu item AND optionally by a
  // future explicit-check button in Settings. Always runs regardless of
  // settings.update.autoCheck because it's an explicit user request.
  ipcMain.handle(IPC.UPDATE_CHECK_NOW, async (): Promise<UpdateInfo> => {
    return performGithubUpdateCheck(true);
  });

  // ----- IPC: open arbitrary URL in default browser -----
  // Retained for general use (About link in the help menu, future
  // settings deep-links, etc.). The UpdateBanner no longer routes
  // through this — see UPDATE_DOWNLOAD_START below. v0.1.32.
  //
  // Sanity-check that the URL is http(s) before forwarding to
  // `shell.openExternal` so a malicious renderer (XSS in a future feature)
  // can't trick the main process into opening a `file://` URL or a
  // custom-protocol handler.
  // ----- IPC: Squirrel restart-to-install (v0.1.25) -----
  // Bound to the renderer's UpdateBanner Restart button when the banner
  // is in `ready-to-install` state. Guarded so a stray call before
  // `update-downloaded` can't crash the app — see
  // `quitAndInstallStagedUpdate()`.
  ipcMain.handle(IPC.UPDATE_QUIT_AND_INSTALL, () => quitAndInstallStagedUpdate());

  // ----- IPC: kick Squirrel's in-app download (v0.1.32, fallback rewired v0.1.37) -----
  // Bound to the renderer's UpdateBanner "Install Update" button.
  // v0.1.32: button fires `autoUpdater.checkForUpdates()` so Squirrel's
  // download events drive the banner state machine through `downloading`
  // → `ready-to-install` → Restart click → `quitAndInstall()`.
  //
  // v0.1.37: on failure (unsigned build, dev mode, Linux, transient
  // error) we open the GitHub release page DIRECTLY in the user's
  // default browser. The v0.1.32 "info dialog with Reveal Release Page
  // button" added a confusing extra click (voice 3351 reported the
  // banner Download button as "does nothing"); jumping straight to the
  // release page makes the click always produce a visible next step.
  ipcMain.handle(IPC.UPDATE_DOWNLOAD_START, async (): Promise<StartDownloadResult> => {
    const result = triggerSquirrelDownload();
    if (result.ok) {
      // Signed packaged build: Squirrel pipeline kicked. The renderer
      // shows a "Starting download…" toast; the existing download-
      // progress forwarders then drive the banner.
      return result;
    }
    // v0.1.37 fallback: on unsigned / dev / Linux / transient errors,
    // open the GitHub release page in the user's default browser.
    // v0.1.39: surface the OUTCOME of that fallback to the renderer
    // (was silent before — voice 3369 "I clicked install update and I
    // don't see anything happening"). If openExternal succeeds, return
    // mode='browser' so the renderer toasts "Opening release page in
    // browser…". If openExternal throws too, return ok:false so the
    // renderer shows an error toast with a manual-fallback link.
    try {
      await shell.openExternal(result.releaseUrl);
      console.info(
        '[main] update-download fallback opened release page',
        result.reason,
      );
      return {
        ok: true,
        reason: 'opened-release-page',
        mode: 'browser',
        fallbackReason: result.reason,
      };
    } catch (err) {
      console.error('[main] update-download fallback openExternal failed', err);
      return {
        ok: false,
        reason: 'error',
        error: `Couldn't open browser: ${String((err as Error)?.message ?? err)}`,
        releaseUrl: result.releaseUrl,
      };
    }
  });

  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_evt, url: string): Promise<boolean> => {
    try {
      if (typeof url !== 'string') return false;
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        console.warn('[main] openExternal refused non-http(s) URL:', parsed.protocol);
        return false;
      }
      await shell.openExternal(url);
      return true;
    } catch (err) {
      console.error('[main] openExternal failed', err);
      return false;
    }
  });

  // ----- IPC: notifications (renderer asks main to fire native notif) -----
  // v0.1.76: the main-process ttsDispatcher now fires chat notifications
  // DIRECTLY (it owns the decision). This IPC handler stays for any remaining
  // renderer/MCP callers; `silent` is honoured when provided (defaults to
  // not-silent to preserve pre-v0.1.76 behaviour for callers that omit it).
  ipcMain.handle(
    IPC.NOTIFY,
    (_evt, payload: { title: string; body: string; silent?: boolean }) => {
      if (!Notification.isSupported()) return false;
      const n = new Notification({
        title: payload.title,
        body: payload.body,
        silent: payload.silent === true,
      });
      n.show();
      return true;
    },
  );

  // ----- IPC: connections (channels panel pull-fetch) -----
  ipcMain.handle(IPC.CONNECTIONS_GET, () => chat.getConnections());

  // ----- IPC: inline chat send via Restream's /client/reply endpoint -----
  // Direct fetch from main using the OAuth partition's chat-session cookies.
  // Reverse-engineered in v0.1.12; shipped behind an inline input bar in
  // v0.1.14. 1 msg/sec rate-limited so accidental rapid-fire (e.g. holding
  // Enter on a stuck key) can't hammer Restream's edge.
  //
  // v0.1.34: rewired from showId-only to the full chat context union
  // (`{showId, eventId, instant}`) matching what Restream's chat backend
  // actually accepts. The WS sniffs `eventId` (and any incidental showId
  // / instant) from `event` / `reply_created` frames, but those only flow
  // when chat is active. If the user opens the app cold and tries to send
  // before any frame arrives, we hit Restream's public REST API for
  // in-progress events and derive a context from there. The result is
  // cached per session — Restream's event id changes per stream session,
  // so a stale cache is acceptable until the user reconnects the WS.
  //
  // Stale-but-present invalidation: the cache could hold an event from a
  // show that ended hours ago — Restream returns 404 on /client/reply for
  // both "never had a show" AND "show ended" with the same status and
  // body, so we can't tell pre-send. Two layers defend against this:
  //   1. On a POST 404 the inline send path calls `refreshChatContextForce()`
  //      which clears both the REST cache + the WS sniff, re-hits the
  //      REST API, and feeds the result into a single retry POST.
  //   2. A 10-minute periodic poller (while WS connected) re-hydrates
  //      the cache so a stale context can't linger across multiple sends.
  let lastSendAt = 0;
  let chatContextRestCache: ChatContext | undefined;
  /**
   * Derive a ChatContext from one entry of `/v2/user/events/in-progress`.
   * Restream's docs document the response as:
   *   [{id, status, title, description, coverUrl, isRecordOnly,
   *     scheduledFor, startedAt, finishedAt, destinations:[...]}, ...]
   * `id` is the EVENT id (NOT a showId, despite v0.1.20-v0.1.33 naming).
   * For instant streams (RTMP/instant) the id is often the string
   * `"rtmp/instant"` or a UUID with no schedule — in either case
   * `{eventId: id}` is the right shape for the chat-send body.
   *
   * v0.1.34 split this off from `hydrateShowIdViaRest` so the chat-send
   * path can reason about the full context, not just a single string.
   */
  const buildChatContextFromInProgress = (
    entry: unknown,
  ): ChatContext | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    const e = entry as { id?: unknown };
    if (typeof e.id !== 'string' || !e.id) return undefined;
    return { eventId: e.id };
  };
  const hydrateChatContextViaRest = async (): Promise<ChatContext | undefined> => {
    // v0.1.38: async — chat-context hydration may run before the boot
    // decrypt settles (periodic refresh timer, manual retry). Awaiting
    // the deferred decrypt avoids a spurious 401 from Restream.
    const token = await oauth.getTokenAsync();
    if (!token) return undefined;
    try {
      const res = await fetch('https://api.restream.io/v2/user/events/in-progress', {
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          accept: 'application/json',
        },
      });
      if (!res.ok) {
        console.warn('[main] in-progress events fetch failed status=' + res.status);
        return undefined;
      }
      const json: unknown = await res.json();
      if (Array.isArray(json) && json.length > 0) {
        return buildChatContextFromInProgress(json[0]);
      }
      return undefined;
    } catch (err) {
      console.warn('[main] in-progress events fetch threw', err);
      return undefined;
    }
  };
  /**
   * Cache-coherent hydration used as `fetchContext` on the FIRST POST.
   * Returns the cached context if present; otherwise hits the REST API
   * and caches the result for subsequent sends within this WS session.
   *
   * v0.1.34: renamed from `fetchActiveShowIdFromApi`.
   */
  const fetchActiveChatContextFromApi = async (): Promise<ChatContext | undefined> => {
    if (chatContextRestCache) return chatContextRestCache;
    const fresh = await hydrateChatContextViaRest();
    if (fresh) chatContextRestCache = fresh;
    return fresh;
  };
  /**
   * Force-refresh used as `refreshContext` on the retry path AFTER a 404.
   * Invalidates BOTH the REST cache AND the WS-sniffed context (so
   * `chat.getChatContext()` returns `{}` until a new frame lands), then
   * re-hits the REST API. The returned context is cached as the new
   * authority. If the REST API also returns nothing (no active in-progress
   * event), we return undefined and the retry POSTs with an empty context
   * — Restream will 404 again and the user sees the "no active show" error.
   *
   * v0.1.34: renamed from `refreshShowIdForce`.
   */
  const refreshChatContextForce = async (): Promise<ChatContext | undefined> => {
    chatContextRestCache = undefined;
    try {
      chat.invalidateChatContext();
    } catch (err) {
      console.error('[main] chat.invalidateChatContext failed', err);
    }
    const fresh = await hydrateChatContextViaRest();
    if (fresh) chatContextRestCache = fresh;
    return fresh;
  };

  // Reset the REST cache whenever the WS reconnects — that value is
  // authoritative once seen, and a stale REST cache could smuggle the
  // wrong context across an account switch / reconnect.
  chat.on('state', (s) => {
    if (s.status === 'connecting' || s.status === 'reconnecting') {
      chatContextRestCache = undefined;
    }
  });

  // ---- Periodic chat-context refresh (10-minute interval) ------------
  // While the WS is connected, re-hit the REST API every 10 minutes and
  // overwrite the cache. Catches the "stream ended hours ago but the app
  // kept running" case before the user hits send and gets a 404. Only
  // armed while connected; torn down on disconnect / reconnect / app quit
  // so we don't waste API calls when the WS is down.
  const CHAT_CTX_REFRESH_INTERVAL_MS = 10 * 60_000; // 10 minutes
  let chatContextRefreshTimer: NodeJS.Timeout | undefined;
  const stopChatContextRefresh = (): void => {
    if (chatContextRefreshTimer) {
      clearInterval(chatContextRefreshTimer);
      chatContextRefreshTimer = undefined;
    }
  };
  const startChatContextRefresh = (): void => {
    stopChatContextRefresh();
    chatContextRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await hydrateChatContextViaRest();
          if (fresh) {
            // Overwrite cache unconditionally — the REST endpoint is the
            // authoritative "currently in-progress" signal for the user's
            // primary event. The WS-sniffed value stays untouched (it's
            // still the canonical "what arrived on the wire") but the
            // cache used by the send path is now fresh.
            chatContextRestCache = fresh;
          } else {
            // No in-progress event — invalidate cache so the next send
            // falls through to the 404 → no-show-id error rather than
            // POSTing with a stale context.
            chatContextRestCache = undefined;
          }
        } catch (err) {
          console.warn('[main] periodic chat-context refresh threw', err);
        }
      })();
    }, CHAT_CTX_REFRESH_INTERVAL_MS);
  };
  chat.on('state', (s) => {
    if (s.status === 'connected') {
      startChatContextRefresh();
    } else if (
      s.status === 'connecting' ||
      s.status === 'reconnecting' ||
      s.status === 'disconnected' ||
      s.status === 'error'
    ) {
      // Cancel on any transition out of connected. Re-armed on next connect.
      stopChatContextRefresh();
    }
  });
  app.on('before-quit', () => stopChatContextRefresh());

  // ---- v0.1.28: dedicated chat-send.jsonl log -------------------------
  // The Compose-window logger only captures requests originating from the
  // webview (used during reverse-engineering). The MAIN-process inline send
  // bypasses it entirely. Without this log, "v0.1.28 chat-send still 404s"
  // bug reports have no way to see the actual request shape, status codes,
  // or whether the retry path triggered. Redacts cookie/xsrf headers in
  // chat-send.ts before this callback ever sees them.
  const resolveChatSendLogPath = (): string | undefined => {
    try {
      const rawLogPath = chat.getRawLogPath();
      const dir = rawLogPath
        ? path.dirname(rawLogPath)
        : (() => {
            try {
              return app.getPath('logs');
            } catch {
              return undefined;
            }
          })();
      if (!dir) return undefined;
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, 'chat-send.jsonl');
    } catch {
      return undefined;
    }
  };
  const appendChatSendLog = (record: ChatSendLogRecord): void => {
    try {
      const p = resolveChatSendLogPath();
      if (!p) return;
      const line =
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
      fs.appendFileSync(p, line, 'utf8');
    } catch (err) {
      console.error('[main] chat-send log append failed', err);
    }
  };

  // v0.1.68 (voice 4013): install the WS-echo log sink on the ChatClient
  // now that `appendChatSendLog` exists. Every accepted `reply_created`
  // frame becomes a `ws-echo-received` row in chat-send.jsonl. We pair
  // this with the per-attempt + final-failure + optimistic-timeout rows
  // so log forensics can answer "did the user's send eventually echo
  // back?" without needing the renderer DevTools open.
  chat.setNormalizeLogSink({
    onWsEchoReceived: (info) => {
      appendChatSendLog({
        phase: 'ws-echo-received',
        clientReplyUuid: info.clientReplyUuid,
        replyUuid: info.replyUuid,
        eventSourceId: info.eventSourceId,
      });
    },
  });

  ipcMain.handle(IPC.CHAT_SEND_TEXT, async (_evt, rawText: string): Promise<SendTextResult> => {
    try {
      // v0.1.38: async auth check — covers the race where the user types a
      // message and hits Enter before the boot deferred decrypt has
      // resolved. After the first decrypt tick this is essentially free.
      if (!(await oauth.isAuthenticatedAsync())) {
        return { ok: false, reason: 'not-authenticated' };
      }
      const now = Date.now();
      const dt = now - lastSendAt;
      if (dt < 1000) {
        // Tiny client-side rate-limit. Surfaces as a soft error in the UI
        // so the user sees "wait a sec" rather than a silent drop.
        return {
          ok: false,
          reason: 'error',
          error: `Sending too fast — wait ${Math.ceil((1000 - dt) / 100) / 10}s`,
        };
      }
      lastSendAt = now;
      const result = await sendChatText({
        text: rawText,
        connections: chat.getConnections(),
        // v0.1.34: full chat-context union (showId | eventId | instant)
        // sniffed from the WS, merged with whatever the REST hydration
        // hook returns inside chat-send.ts.
        context: chat.getChatContext(),
        fetchContext: fetchActiveChatContextFromApi,
        refreshContext: refreshChatContextForce,
        log: appendChatSendLog,
        parentWindow: mainWindow,
      });
      return result;
    } catch (err) {
      console.error('[main] sendChatText failed', err);
      // v0.1.69 (voice 4015): top-level handler catch. sendChatText is
      // supposed to catch everything internally; if we end up here it's
      // a genuine programming bug (or an OOM mid-await) and needs to be
      // visible without DevTools open. Render-side sees `error` reason.
      appendErrorLog({
        subsystem: 'main',
        phase: 'main.send-chat-text-handler-threw',
        errorMessage: errorToString(err),
      });
      return {
        ok: false,
        reason: 'error',
        error: String((err as Error)?.message ?? err),
      };
    }
  });

  // ----- v0.1.43: non-blocking enqueue path ------------------------------
  // The renderer's inline chat-input bar uses `ipcRenderer.send` (NOT
  // `invoke`) so the input clears immediately on Enter — no awaiting the
  // POST. The FIFO queue below serialises the actual sends + broadcasts
  // status lifecycle events back over `CHAT_SEND_STATUS`.
  //
  // Behavioural contract:
  //   - Every enqueue is accepted (no "wait 0.x s" surface). The 1 msg/sec
  //     pacing lives inside the queue, not at the IPC boundary.
  //   - A failure on one send NEVER blocks subsequent sends.
  //   - The renderer renders the optimistic placeholder from the click
  //     handler immediately; the queue's `pending` status is a no-op
  //     confirmation. `sent` lets the renderer downgrade any "sending…"
  //     affordance (the WS echo, matched by clientReplyUuid → id, is
  //     what actually replaces the placeholder in the feed). `failed`
  //     keeps the placeholder + paints a small ⚠ with the error in
  //     a tooltip.
  const emitSendStatus = (status: ChatSendStatus): void => {
    try {
      mainWindow?.webContents.send(IPC.CHAT_SEND_STATUS, status);
    } catch (err) {
      console.error('[main] CHAT_SEND_STATUS emit failed', err);
    }
  };
  const sendQueue: ChatSendQueue = createChatSendQueue({
    runSend: async (item) => {
      // Per-send auth gate: chat.getConnections() / oauth state can drift
      // between enqueue and actual POST (sign-out, token expiry). Re-check
      // here so a stale enqueue doesn't 401 against Restream.
      if (!(await oauth.isAuthenticatedAsync())) {
        return { ok: false, reason: 'not-authenticated' };
      }
      return sendChatText({
        text: item.text,
        connections: chat.getConnections(),
        context: chat.getChatContext(),
        fetchContext: fetchActiveChatContextFromApi,
        refreshContext: refreshChatContextForce,
        log: appendChatSendLog,
        parentWindow: mainWindow,
        // v0.1.43: pin the Restream `clientReplyUuid` to the
        // renderer-minted `clientId`. The WS rebroadcasts a
        // `reply_created` echo whose `clientReplyUuid` becomes the
        // ChatMessage `id` (see `src/main/normalize.ts`). The renderer
        // matches the optimistic placeholder by that id and drops it in
        // favour of the echo, so the user sees their message exactly
        // once even though both code paths emit it.
        uuid: () => item.clientId,
      });
    },
    emitStatus: emitSendStatus,
    // Keep the 1 msg/sec spacing the v0.1.42 IPC gate enforced. This
    // protects against Restream's own throttle on rapid spam.
    minSpacingMs: 1000,
    log: (event, data) =>
      console.warn(`[main] chat-send-queue ${event}`, data ?? {}),
    // v0.1.68 (voice 4013): give the queue the same chat-send.jsonl
    // sink that the inline send path uses so `status-emit-failed`
    // diagnostics land in the same file as the per-POST rows. Same
    // log path, same redaction guarantees (preflight/post/final-failure
    // rows already redact via chat-send.ts).
    logChatSend: appendChatSendLog,
  });
  ipcMain.on(IPC.CHAT_SEND_ENQUEUE, (_evt, payload: ChatSendEnqueuePayload) => {
    try {
      if (
        !payload ||
        typeof payload.clientId !== 'string' ||
        !payload.clientId ||
        typeof payload.text !== 'string'
      ) {
        return;
      }
      const text = payload.text.trim();
      if (!text) return;
      sendQueue.enqueue({ clientId: payload.clientId, text });
    } catch (err) {
      console.error('[main] CHAT_SEND_ENQUEUE handler failed', err);
      // v0.1.69 (voice 4015): IPC handler crash — the enqueue never made
      // it to the queue. Renderer optimistically rendered a placeholder
      // that will now sit forever. Best-effort failed-status below
      // surfaces a ⚠, but the structured row tells us WHY (typically a
      // bad payload shape from a renderer regression).
      appendErrorLog({
        subsystem: 'main',
        phase: 'main.chat-send-enqueue-handler-failed',
        errorMessage: errorToString(err),
        context: {
          clientId: payload?.clientId,
          hasText: typeof payload?.text === 'string',
        },
      });
      // Best-effort: surface the failure as a failed status so the
      // renderer's ⚠ icon shows up rather than the message sitting in
      // "sending…" forever.
      if (payload?.clientId) {
        emitSendStatus({
          clientId: payload.clientId,
          status: 'failed',
          reason: 'error',
          error: String((err as Error)?.message ?? err),
        });
      }
    }
  });

  // ----- v0.1.68 (voice 4013): renderer → main jsonl log relay --------
  // The renderer-side optimistic-send timeout guard needs to land a row
  // in chat-send.jsonl when it fires (so log-only forensics can see "the
  // renderer gave up at 30s" alongside the main-process per-attempt
  // rows). Renderer has no fs access via preload; we relay through here.
  //
  // Defensive validation — `phase` and `clientReplyUuid` must be present
  // and string-typed. We do NOT trust arbitrary fields from the renderer
  // to extend the discriminated union; the schema here matches what
  // App.tsx sends (`phase:'optimistic-timeout'`) plus a permissive
  // forward path so future renderer-side rows don't need a main rebuild.
  ipcMain.on(IPC.CHAT_SEND_LOG_EVENT, (_evt, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const rec = payload as Record<string, unknown>;
      if (typeof rec.phase !== 'string') return;
      // Cast: appendChatSendLog accepts the discriminated union; the
      // renderer-side caller is responsible for sending a valid shape.
      appendChatSendLog(rec as unknown as ChatSendLogRecord);
    } catch (err) {
      console.error('[main] CHAT_SEND_LOG_EVENT handler failed', err);
      // v0.1.69 (voice 4015): renderer-relayed log row was malformed.
      // Worth knowing about but does NOT affect user-visible behavior.
      appendErrorLog({
        subsystem: 'main',
        phase: 'main.chat-send-log-event-handler-failed',
        errorMessage: errorToString(err),
      });
    }
  });

  // ----- v0.1.87 (send-warning auto-reconnect request 2026-06-07): renderer →
  // main "a send went unconfirmed, heal the connection" signal -------------
  //
  // When the renderer's 30s optimistic-send timeout fires with no WS echo, the
  // chat WS is almost certainly stale/replaced (the POST returned 200 but the
  // `reply_created` echo never round-tripped). Ethan confirmed clicking the
  // manual Reconnect button at that point fixes it, so we do the equivalent
  // automatically: ask the ChatClient to run the SAME managed reconnect
  // (`performFullReconnect` → OAuth refresh + `chat.reconnect()` → re-subscribe)
  // that the manual button + the v0.1.86 drain-to-zero recovery use.
  //
  // ALL the debounce / cooldown / replace-war coordination lives inside
  // `chat.requestUnconfirmedSendRecovery()` (shared with v0.1.86), so this
  // handler is a thin nudge: a burst of unconfirmed sends coalesces into ONE
  // reconnect, and a persistently-broken upstream is capped by the cooldown.
  // We deliberately do NOT re-send the message — the POST already succeeded.
  ipcMain.on(IPC.CHAT_SEND_UNCONFIRMED, () => {
    try {
      chat.requestUnconfirmedSendRecovery('send-unconfirmed');
    } catch (err) {
      console.error('[main] CHAT_SEND_UNCONFIRMED handler failed', err);
      // The recovery method is internally guarded and shouldn't throw; if it
      // does it's a programming bug worth surfacing without DevTools open. The
      // user-visible ⚠ on the message is unaffected — this is only the
      // self-healing nudge.
      appendErrorLog({
        subsystem: 'main',
        phase: 'main.chat-send-unconfirmed-handler-failed',
        errorMessage: errorToString(err),
      });
    }
  });

  // ----- IPC: pop native chat-feed context menu (right-click on feed) -----
  // Renderer's `.feed` element wires `onContextMenu` to call this handler.
  // We use a native popup (Menu.buildFromTemplate + popup) rather than a
  // CSS overlay so the context menu matches macOS dark-blur conventions and
  // gets full system keyboard navigation for free. v0.1.18.
  ipcMain.handle(IPC.CHAT_SHOW_CONTEXT_MENU, () => {
    try {
      // v0.1.83 — guard a DESTROYED window too, not just null. With the
      // `closed → mainWindow = null` fix this is normally covered, but a
      // stale non-null-yet-destroyed handle would make `menu.popup({ window
      // })` throw; the surrounding try/catch swallows it, but bailing early
      // is cleaner and matches the openSettingsFromMenu guard.
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const menu = Menu.buildFromTemplate([
        {
          label: 'Clear Chat',
          accelerator: 'CmdOrCtrl+K',
          click: () => broadcastChatClear(mainWindow),
        },
      ]);
      menu.popup({ window: mainWindow });
    } catch (err) {
      console.error('[main] chat:show-context-menu failed', err);
    }
  });

  // ----- Forward chat & state to renderer -----
  // Chat drives TWO things from main:
  //   1. CHAT_MESSAGE → renderer (so the visible feed renders the row).
  //   2. ttsDispatcher.handleMessage(m) → the background TTS + notification
  //      decision/dispatch. This is the never-miss path: it runs in MAIN, so
  //      even if the renderer is wedged/dead it still decides + speaks via the
  //      native OS voice engine (src/main/tts-native.ts). As of v0.1.81 ALL
  //      speech is native + in main — the renderer no longer speaks anything
  //      (the old browser-speak IPC path was removed). The renderer only
  //      renders the feed + computes display-only badge flags.
  // Order: forward to the feed FIRST (so the row appears), then dispatch TTS.
  // handleMessage is wrapped in its own try/catch internally so a dispatch
  // error can never break the feed forward.
  chat.on('message', (m) => {
    mainWindow?.webContents.send(IPC.CHAT_MESSAGE, m);
    ttsDispatcher.handleMessage(m);
  });
  chat.on('state', (s) => mainWindow?.webContents.send(IPC.CONN_STATE, s));
  chat.on('connections', (cs) =>
    mainWindow?.webContents.send(IPC.CONNECTIONS, cs),
  );
  // v0.1.88 (voice 4504): when an AUTOMATIC managed reconnect (v0.1.86
  // drain-to-zero recovery or v0.1.87 unconfirmed-send recovery) succeeds and
  // re-subscribes, forward the signal to the renderer so it sweeps + clears the
  // ⚠ on lingering HTTP-200 optimistic sends. (The MANUAL Reconnect button's
  // success is sent directly from the CONN_RECONNECT handler above, so this
  // listener only carries the automatic-recovery reasons — no double-emit.)
  chat.on('reconnect-succeeded', (reason: string) => {
    try {
      mainWindow?.webContents.send(IPC.CONN_RECONNECT_SUCCEEDED, reason);
    } catch (err) {
      console.error('[main] CONN_RECONNECT_SUCCEEDED emit failed', err);
    }
  });

  // Start the in-process HTTP MCP server (v0.1.36+). Listens on
  // 127.0.0.1:19852/mcp by default. Any MCP client can read/write
  // settings + drive live actions WITHOUT spawning a child process.
  // Best-effort — a port-bind failure or a userData lookup miss
  // doesn't block the rest of the app from booting.
  try {
    const started = await startInProcessMcpServer({
      loadSettings,
      saveSettings,
      getMainWindow: () => mainWindow,
      chat,
      oauth,
      checkForUpdatesNow: () => performGithubUpdateCheck(true),
      store,
    });
    if (started) {
      console.log(
        `[main] MCP HTTP server listening on http://127.0.0.1:${started.port}/mcp` +
          (started.portFilePath ? ` (port file: ${started.portFilePath})` : ''),
      );
    } else {
      console.warn('[main] MCP HTTP server did not start (see prior log lines)');
      // v0.1.69 (voice 4015): MCP server failed to bind. Some users
      // rely on the MCP path (Claude Code clients reading/writing
      // settings). The app keeps booting but those clients silently
      // can't connect — worth surfacing.
      appendErrorLog({
        subsystem: 'mcp',
        phase: 'mcp.startup-no-server',
        errorMessage: 'MCP HTTP server did not start (port bind / userData lookup failure)',
      });
    }
  } catch (err) {
    console.error('[main] MCP HTTP server start threw — continuing without MCP', err);
    // v0.1.69 (voice 4015): MCP startup threw — explicit row so a
    // chronic startup failure on a particular machine is grep-able.
    appendErrorLog({
      subsystem: 'mcp',
      phase: 'mcp.startup-threw',
      errorMessage: errorToString(err),
    });
  }

  // Resume session if a valid token already exists.
  //
  // v0.1.38 — DEFERRED, NON-BLOCKING RESUME PATH.
  //
  // The resume runs asynchronously via `void resumeAuth()` — the
  // `app.on('ready')` callback returns immediately so the BrowserWindow
  // is fully constructed and visible before we touch Keychain. This is
  // the fundamental fix for the v0.1.36-and-earlier "fresh install over
  // existing install blocks indefinitely on Allow Safe Storage prompt"
  // bug.
  //
  // Root cause (pre-v0.1.38): the encrypted token blob's macOS Keychain
  // ACL is bound to the binary's code signature. A newly-installed
  // version has a different (or no) signature, so SecurityAgent prompts
  // the user before allowing decrypt. The synchronous
  // `safeStorage.decryptString` call blocked the entire main thread on
  // that prompt — no window, no dock animation, no anything.
  //
  // The new flow:
  //   1. `app.on('ready')` returns → window paints, menu armed, MCP
  //      server starts, IPC handlers register.
  //   2. `resumeAuth()` fires in the background:
  //      a. Calls `getTokenAsync()` which yields to the event loop
  //         twice (setImmediate × 2) so the renderer can paint, then
  //         starts the decrypt with a 2-second timeout.
  //      b. On success → start WS + broadcast authenticated.
  //      c. On timeout / decrypt-failure → ACL drift assumed,
  //         tokenEnc wiped, user sees "Sign in" screen.
  //      d. On expired access-token → background refresh via
  //         refresh-token (if present), start WS, broadcast.
  //   3. Whichever leg runs, `pushAuthStatus()` + `resolveStartupAuth()`
  //      always fire so the renderer's `did-finish-load` handler stops
  //      waiting and pushes the initial AUTH_STATUS snapshot.
  //
  // This ALSO fixes the older "every update logs me out" symptom: a
  // successful background refresh of an expired access-token now races
  // the renderer's first paint instead of the dock-animation tick, but
  // the `startupAuthDone` Promise still gates the initial AUTH_STATUS
  // push so the user sees no "Sign in" flash before the refresh settles.
  const resumeAuth = async (): Promise<void> => {
    // v0.1.63: keep the resume state machine in a small helper so the
    // startup-cookie-repair ordering is pinned by unit tests. The real
    // dependencies stay here in `main.ts`: OAuth persistence, WS client,
    // BrowserWindow parentage, and the startup auth latch are all owned by
    // this `app.on('ready')` closure.
    await resumeAuthWithCookieRepair({
      oauth,
      chat,
      ensureRestreamChatCookies,
      parentWindow: mainWindow,
      pushAuthStatus,
      resolveStartupAuth,
      // v0.1.70 — boot-time transient-refresh recovery. If the very
      // first oauth.refresh() at launch fails with a transient class
      // (5xx / fetch threw — common after wake-from-sleep when the
      // VPN / Wi-Fi handshake hasn't completed yet), arm the watchdog
      // so the user gets the self-healing experience without manual
      // intervention. Closure-captures armTransientRefreshRetry which
      // is defined above in this same `app.on('ready')` callback.
      armTransientRefreshRetry: armTransientRefreshRetryFromStartup,
      logWarn: console.warn,
      logError: console.error,
    });
  };
  // Fire-and-forget — do NOT await. The `ready` callback completes
  // immediately so Electron finishes window construction and the user
  // sees a UI even if Keychain decides to prompt.
  void resumeAuth();

  // ----- v0.1.69 (voice 4015): 7-day jsonl log retention rotation -----
  //
  // Schedule the prune step ~5 seconds AFTER the window is shown so we
  // don't compete with the boot critical path (Keychain decrypt, OAuth
  // refresh, WS handshake, MCP server bind, GH update poll). Once that
  // initial sweep settles, fire every 24 h via setInterval so a long-
  // running session (Ethan streams for hours) also prunes — otherwise
  // a multi-day uptime would accumulate logs past the 7-day window.
  //
  // Wrapped in try/catch: a prune failure must NEVER kill the app. Errors
  // from the pruner itself are surfaced inside the jsonl (`log-prune.*`
  // phases in app-errors.jsonl), so even prune-of-prune-errors is
  // observable from disk.
  //
  // Why setTimeout-then-setInterval instead of just setInterval(0): boot
  // already has enough fs IO competing for the disk; the 5s defer lets
  // the user see chat messages before any log-rewrite IO kicks in.
  setTimeout(() => {
    void pruneJsonlLogs().catch((err) => {
      console.error('[main] initial log prune failed', err);
      appendErrorLog({
        subsystem: 'log-prune',
        phase: 'log-prune.initial-tick-threw',
        errorMessage: errorToString(err),
      });
    });
  }, 5_000);
  const pruneInterval = setInterval(() => {
    void pruneJsonlLogs().catch((err) => {
      console.error('[main] periodic log prune failed', err);
      appendErrorLog({
        subsystem: 'log-prune',
        phase: 'log-prune.periodic-tick-threw',
        errorMessage: errorToString(err),
      });
    });
  }, PRUNE_INTERVAL_MS);
  // Clear on quit so the timer doesn't keep the event loop alive past
  // shutdown (Node would otherwise wait the full 24 h before exiting).
  app.on('before-quit', () => {
    clearInterval(pruneInterval);
  });
});

// ----- v0.1.69 (voice 4015): catch-all process-level error listeners -----
//
// Pre-v0.1.69 any unhandled promise rejection or synchronous throw
// outside an Electron IPC handler vanished into Node's default warning
// stream. With these listeners installed every such event becomes a row
// in app-errors.jsonl so post-mortem can see "the renderer just stopped
// receiving messages — was there an uncaught exception on the main
// thread?".
//
// We deliberately do NOT call process.exit on either listener — Electron
// already has its own crash handling, and aborting the process would
// turn a recoverable async glitch into a hard quit the user has to
// restart from. The structured row is the value here, not a behavior
// change.
process.on('unhandledRejection', (reason) => {
  try {
    appendErrorLog({
      subsystem: 'main',
      phase: 'main.unhandled-rejection',
      errorMessage: errorToString(reason),
    });
  } catch {
    // logging must never escalate a process-wide event
  }
});
process.on('uncaughtException', (err) => {
  try {
    appendErrorLog({
      subsystem: 'main',
      phase: 'main.uncaught-exception',
      errorMessage: errorToString(err),
    });
  } catch {
    // see above
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // v0.1.84 — recreate the MAIN window on Dock re-activation whenever it's gone,
  // keyed off `mainWindow === null` rather than the old
  // `BrowserWindow.getAllWindows().length === 0`.
  //
  // Why the old check was wrong: since v0.1.83 the main window's `closed`
  // listener sets `mainWindow = null`. If the user closes the main window while
  // an OAuth helper window (see oauth.ts) is still open, `mainWindow` is null
  // but `getAllWindows().length` is still > 0 (the OAuth window counts). The old
  // length-based guard then short-circuits and Dock re-activation does NOTHING —
  // the user is left with no main window and no way to get it back without
  // quitting. Keying off `mainWindow` directly fixes that edge while preserving
  // the existing behaviour when a main window already exists (no double-spawn).
  // `createMainWindow()` reassigns `mainWindow`, so the next activate is a no-op.
  if (!mainWindow) createMainWindow();
});
