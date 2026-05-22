import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import log from 'electron-log/main';
import { OAuthCoordinator } from './oauth';
import { ChatClient } from './ws-client';
import { createStore } from './store';
import {
  sendChatText,
  type ChatSendLogRecord,
  type ChatContext,
} from './chat-send';
import { createChatSendQueue, type ChatSendQueue } from './chat-send-queue';
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
    },
  });

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
                click: () => mainWindow?.webContents.send('menu:open-settings'),
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
  // SIGTERM the in-flight `say` subprocess on quit so we don't leak
  // a half-spoken utterance into the user's audio output after the
  // window closes.
  app.on('before-quit', () => {
    try {
      nativeTts.cancel();
    } catch (err) {
      console.warn('[main] nativeTts.cancel on quit failed', err);
    }
  });

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
  // v0.1.50: `opts.preserveInitialBudget` controls whether the resulting
  // `chat.reconnect()` resets the one-shot initial-connect retry budget
  // (defined in ws-client.ts). The provider-triggered retry path
  // (`setReconnectProvider`) MUST pass `true` — otherwise a retry
  // handshake that also fails before `'open'` would reset both flags and
  // fire another 5s retry, producing an infinite 5s polling loop. The
  // manual Reconnect button (default — flag omitted) gets a fresh budget
  // because a user click is an explicit "try again from scratch" gesture.
  const performFullReconnect = async (
    opts?: { preserveInitialBudget?: boolean },
  ): Promise<{
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
          // Refresh failed AND the token was already expired/about-to-expire.
          // Reconnecting with this token would just produce a doomed handshake
          // and a noisy reconnect loop. Surface the auth failure instead so
          // the renderer can prompt re-auth via the existing AUTH_STATUS
          // channel. Codex review (v0.1.7) flagged this as MUST-FIX.
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
      chat.reconnect({ preserveInitialBudget: opts?.preserveInitialBudget });
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
    // v0.1.50: preserve the initial-connect retry budget across this
    // call. Without this, a retry handshake that ALSO fails pre-`open`
    // would reset both budget flags and fire another 5s retry, producing
    // an infinite 5s polling loop.
    const out = await performFullReconnect({ preserveInitialBudget: true });
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

  // ----- IPC: force reconnect (renderer "Reconnect" toolbar button) -----
  // Wires the manual button to the SAME performFullReconnect function
  // the auto-retry path uses. v0.1.45.
  ipcMain.handle(IPC.CONN_RECONNECT, async () => {
    const out = await performFullReconnect();
    if (out.ok) return { ok: true as const };
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
    chat.stop();
    await oauth.logout();
    const status: AuthStatus = { authenticated: false };
    mainWindow?.webContents.send(IPC.AUTH_STATUS, status);
    return status;
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
  const SEED_VIEWER_MIGRATION_KEY = 'seed-viewer-ignore-regex';

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
    store.set('settings', settings);
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
  ipcMain.handle(IPC.NOTIFY, (_evt, payload: { title: string; body: string }) => {
    if (!Notification.isSupported()) return false;
    const n = new Notification({
      title: payload.title,
      body: payload.body,
      silent: false,
    });
    n.show();
    return true;
  });

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

  // ----- IPC: pop native chat-feed context menu (right-click on feed) -----
  // Renderer's `.feed` element wires `onContextMenu` to call this handler.
  // We use a native popup (Menu.buildFromTemplate + popup) rather than a
  // CSS overlay so the context menu matches macOS dark-blur conventions and
  // gets full system keyboard navigation for free. v0.1.18.
  ipcMain.handle(IPC.CHAT_SHOW_CONTEXT_MENU, () => {
    try {
      if (!mainWindow) return;
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
  chat.on('message', (m) => mainWindow?.webContents.send(IPC.CHAT_MESSAGE, m));
  chat.on('state', (s) => mainWindow?.webContents.send(IPC.CONN_STATE, s));
  chat.on('connections', (cs) =>
    mainWindow?.webContents.send(IPC.CONNECTIONS, cs),
  );

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
    }
  } catch (err) {
    console.error('[main] MCP HTTP server start threw — continuing without MCP', err);
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
    // v0.1.51: structured boot-path logging so a future "stuck on idle" /
    // "still not connecting after update" session is diagnosable without
    // having to ship another build. Previously `main.log` only contained
    // updater chatter — there was no record of whether `chat.start()`
    // was ever called, which token leg ran, or where the boot path bailed.
    log.info('[main] resumeAuth: start');
    try {
      // First leg: see if the (possibly deferred) decrypted token is
      // still within its access-token validity window. After the first
      // tick this resolves to the cached value; the very first call per
      // launch waits up to 2s for the decrypt timeout.
      if (await oauth.isAuthenticatedAsync()) {
        const t = (await oauth.getTokenAsync())!;
        log.info('[main] resumeAuth: cached/decrypted token valid, calling chat.start()', {
          expiresAtMs: t.expiresAt,
          msUntilExpiry: t.expiresAt - Date.now(),
        });
        chat.setToken(t.accessToken);
        chat.start();
      } else {
        // Either no token on disk (fresh install / post-logout) OR the
        // access token expired OR ACL drift wiped the blob. Try a
        // refresh-token round-trip — succeeds for the second case,
        // returns undefined for the first/third (no refresh token to
        // present), leaving the user on the sign-in screen.
        log.info('[main] resumeAuth: no valid cached token, trying refresh');
        const refreshed = await oauth.refresh();
        if (refreshed) {
          log.info('[main] resumeAuth: refresh succeeded, calling chat.start()', {
            expiresAtMs: refreshed.expiresAt,
            msUntilExpiry: refreshed.expiresAt - Date.now(),
          });
          chat.setToken(refreshed.accessToken);
          chat.start();
        } else {
          log.warn('[main] resumeAuth: refresh failed/no refresh token — leaving user on sign-in');
        }
      }
    } catch (err) {
      log.error('[main] resumeAuth: threw', err);
      console.error('[main] startup auth resume failed', err);
    } finally {
      // Broadcast the final auth state and unblock did-finish-load.
      pushAuthStatus();
      resolveStartupAuth();
      log.info('[main] resumeAuth: done', { chatState: chat.getState() });
    }
  };
  // Fire-and-forget — do NOT await. The `ready` callback completes
  // immediately so Electron finishes window construction and the user
  // sees a UI even if Keychain decides to prompt.
  void resumeAuth();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
