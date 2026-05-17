import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  screen,
  session,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import { OAuthCoordinator } from './oauth';
import { ChatClient } from './ws-client';
import { createStore, type ComposeWindowBounds } from './store';
import { sendChatText, type ChatSendLogRecord } from './chat-send';
import {
  clampComposeBounds,
  COMPOSE_MIN_WIDTH,
  COMPOSE_MIN_HEIGHT,
} from './compose-bounds';
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
import {
  DEFAULT_SETTINGS,
  IPC,
  Settings,
  AuthStatus,
  ConnectionState,
  SendTextResult,
  UpdateInfo,
} from '../shared/types';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// ---------------------------------------------------------------------------
// `--mcp-stdio` MCP server entrypoint. v0.1.29.
// ---------------------------------------------------------------------------
//
// When invoked with `--mcp-stdio`, the binary runs as a Model Context
// Protocol (MCP) server over stdin/stdout instead of launching the GUI.
// Agents can then configure the app (TTS prefs, notification prefs, regex
// ignore lists, etc.) without the user touching the Settings drawer.
//
// Architecture: this process never calls `app.whenReady()` or creates a
// BrowserWindow. The MCP layer reads/writes the electron-store JSON file
// directly via `src/mcp/store-io.ts` — the running GUI (if any) re-fetches
// settings on each renderer `IPC.SETTINGS_GET` pull, so MCP mutations flow
// through naturally. Runtime-only state (live WS connections, recent-
// message buffer) is not introspectable from this process; those tools
// return a `guiNotIntrospectable: true` hint payload so agents get clear
// feedback rather than a silent no-op.
//
// We MUST detect the flag before the `if (started) app.quit()` line so a
// fresh-install Squirrel hook doesn't yank the process out from under the
// MCP loop.
if (process.argv.includes('--mcp-stdio')) {
  // Lazy require so the GUI launch path doesn't pull the MCP module
  // (and its `tools.ts` electron-app reference) at startup time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startStdioServer } = require('../mcp/stdio') as typeof import('../mcp/stdio');
  startStdioServer();
  // Don't fall through to the normal Electron boot. We intentionally do
  // NOT call `app.quit()` — that would tear down stdin before our handler
  // can drain the queue on EOF. Instead the stdio server calls
  // `process.exit(0)` on stdin EOF.
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
                // Two checks fire on click:
                //   1. The GH-Releases poller — always works because no
                //      signature check is involved. Surfaces the banner if
                //      a newer release is published. This is the primary
                //      signal for unsigned builds where Squirrel can't
                //      auto-install.
                //   2. The Squirrel/update-electron-app path — only useful
                //      on signed builds; in dev / unsigned it shows an
                //      info dialog pointing at the releases page. We keep
                //      it because once signing lands it'll surface the
                //      restart-to-update dialog.
                //
                // The click handler MUST NOT throw synchronously — Electron
                // surfaces a sync throw as the macOS system alert "this
                // command is disabled and cannot be executed". Wrap defensively.
                click: () => {
                  try {
                    void performGithubUpdateCheck(true).catch((err) =>
                      console.error('[menu] gh-check-for-updates failed', err),
                    );
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
                click: () => {
                  try {
                    void performGithubUpdateCheck(true).catch((err) =>
                      console.error('[menu] gh-check-for-updates failed', err),
                    );
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

  ipcMain.handle(IPC.AUTH_STATUS, () => {
    const t = oauth.getToken();
    const status: AuthStatus = {
      authenticated: oauth.isAuthenticated(),
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

  // ----- IPC: force reconnect (renderer "Reconnect" toolbar button) -----
  // Tears down the live WebSocket, resets attempt counters, and immediately
  // opens a fresh connection. If the stored access token is within 60s of
  // expiry (matches OAuthCoordinator.isAuthenticated), we transparently
  // refresh first so the new socket boots with a fresh bearer. If refresh
  // fails or no token is present, we surface the error via the connection
  // state stream — the renderer already displays state.lastError.
  ipcMain.handle(IPC.CONN_RECONNECT, async () => {
    try {
      let token = oauth.getToken();
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
          return { ok: false, reason: 'not-authenticated' as const };
        }
      }
      if (!token) {
        return { ok: false, reason: 'not-authenticated' as const };
      }
      chat.setToken(token.accessToken);
      chat.reconnect();
      return { ok: true as const };
    } catch (err) {
      console.error('[main] reconnect failed', err);
      return { ok: false, reason: 'error' as const, error: String((err as Error)?.message ?? err) };
    }
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
    if (!stored) return DEFAULT_SETTINGS;
    return {
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
  }
  ipcMain.handle(IPC.SETTINGS_GET, (): Settings => loadSettings());
  ipcMain.handle(IPC.SETTINGS_SET, (_evt, settings: Settings) => {
    store.set('settings', settings);
    return settings;
  });

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

  // ----- IPC: kick Squirrel's in-app download (v0.1.32) -----
  // Bound to the renderer's UpdateBanner "Download" button. Pre-v0.1.32
  // that button opened the GitHub release page in the user's default
  // browser via `shell.openExternal`, which side-stepped the entire
  // in-app pipeline (progress bar → restart-to-install) we'd already
  // wired in v0.1.25. v0.1.32 wires the button to
  // `autoUpdater.checkForUpdates()` so Squirrel's download events drive
  // the banner state machine through `downloading` → `ready-to-install`
  // → Restart click → `quitAndInstall()`.
  //
  // On failure (unsigned build, dev mode, Linux, transient error) we
  // pop a NATIVE info dialog explaining the situation rather than
  // silently bouncing the user to a browser tab. The dialog offers a
  // "Reveal Release Page" button as an explicit escape hatch — that
  // click IS allowed to open the browser because the user asked for it.
  ipcMain.handle(IPC.UPDATE_DOWNLOAD_START, async (): Promise<StartDownloadResult> => {
    const result = triggerSquirrelDownload();
    if (!result.ok) {
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      let message = 'In-app update is unavailable for this build.';
      let detail = '';
      switch (result.reason) {
        case 'not-packaged':
          message = 'Auto-update is only available in installed builds.';
          detail = `You're running a development build of Restream Chat++ ${app.getVersion()}.`;
          break;
        case 'unsupported-platform':
          message = 'Linux updates are delivered via .deb / .rpm packages.';
          detail =
            'Grab the latest release from https://github.com/EthanSK/restream-chat-plus-plus/releases';
          break;
        case 'feed-unavailable':
          message = 'Update service unavailable.';
          detail =
            `This build of Restream Chat++ ${app.getVersion()} is not connected to the update feed ` +
            `(typically an unsigned build — Squirrel.Mac refuses to apply unsigned updates). ` +
            `You can still reach the release page manually if you want to install by hand.`;
          break;
        case 'error':
          message = 'Update download failed to start.';
          detail = result.error ?? 'Unknown error.';
          break;
      }
      try {
        const opts: Electron.MessageBoxOptions = {
          type: 'info',
          message,
          detail,
          buttons: ['Reveal Release Page', 'OK'],
          defaultId: 1,
          cancelId: 1,
        };
        const choice = owner
          ? await dialog.showMessageBox(owner, opts)
          : await dialog.showMessageBox(opts);
        if (choice.response === 0) {
          // The user explicitly asked for the release page; that's a
          // deliberate click on a secondary action, not the silent
          // browser-bounce we removed in v0.1.32.
          await shell.openExternal(
            'https://github.com/EthanSK/restream-chat-plus-plus/releases',
          );
        }
      } catch (err) {
        console.error('[main] update-download-start dialog failed', err);
      }
    }
    return result;
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

  // ----- IPC: open the native Compose window (v0.1.32+) -----
  //
  // The Compose button next to the inline send arrow opens this window. Pre-
  // v0.1.32 it loaded chat.restream.io at 720×720 because Restream's embed
  // had intrinsic min-widths that broke at smaller sizes. v0.1.32 replaces
  // that with a small native React UI (~520×280) that posts through the
  // same CHAT_SEND_TEXT IPC as the inline input bar — so we reuse the same
  // /client/reply path, showId refresh, and 404 retry logic from v0.1.30.
  //
  // Window properties:
  //   - 520×280 default content size (Messages/Slack-thread-reply scale)
  //   - 360×200 minimums, no maximize, resizable
  //   - parent: mainWindow so it groups in the macOS window switcher
  //   - bounds persisted to electron-store `composeWindow`; clamped to the
  //     work area on restore via `clampComposeBounds`
  //   - alwaysOnTop persisted; toggle exposed in the Compose UI
  //   - loads the same renderer bundle with `?compose=1` query param
  //
  // Singleton: clicking Compose while one is open focuses the existing
  // window instead of spawning a duplicate.
  let composeWindow: BrowserWindow | null = null;
  let composeBoundsSaveTimer: NodeJS.Timeout | undefined;

  /**
   * Persist the Compose window's current bounds (size + position). The
   * alwaysOnTop flag is preserved unchanged — it's mutated separately
   * via the COMPOSE_SET_ALWAYS_ON_TOP handler. Called on resize/move
   * (debounced via composeBoundsSaveTimer) and on window close.
   */
  const saveComposeBounds = (win: BrowserWindow): void => {
    try {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      const prev = store.get('composeWindow') as ComposeWindowBounds | undefined;
      const next: ComposeWindowBounds = {
        width: b.width,
        height: b.height,
        x: b.x,
        y: b.y,
        alwaysOnTop: prev?.alwaysOnTop ?? false,
      };
      store.set('composeWindow', next);
    } catch (err) {
      console.error('[main] save compose bounds failed', err);
    }
  };

  const scheduleSaveComposeBounds = (win: BrowserWindow): void => {
    if (composeBoundsSaveTimer) clearTimeout(composeBoundsSaveTimer);
    composeBoundsSaveTimer = setTimeout(() => saveComposeBounds(win), 400);
  };

  ipcMain.handle(IPC.CHAT_OPEN_COMPOSE, async () => {
    try {
      if (!oauth.isAuthenticated()) {
        return { ok: false as const, reason: 'not-authenticated' as const };
      }
      // Singleton: focus the existing window if one is already open.
      if (composeWindow && !composeWindow.isDestroyed()) {
        if (composeWindow.isMinimized()) composeWindow.restore();
        composeWindow.focus();
        return { ok: true as const };
      }

      // Resolve work area for the display the parent window lives on so
      // bounds clamping is multi-monitor-aware.
      let workArea: Electron.Rectangle = { x: 0, y: 0, width: 1440, height: 900 };
      try {
        const display = mainWindow
          ? screen.getDisplayMatching(mainWindow.getBounds())
          : screen.getPrimaryDisplay();
        workArea = display.workArea;
      } catch (err) {
        console.warn('[main] compose: failed to resolve display work area', err);
      }
      const saved = store.get('composeWindow') as ComposeWindowBounds | undefined;
      const clamped = clampComposeBounds(saved, workArea);
      const alwaysOnTop = saved?.alwaysOnTop === true;

      composeWindow = new BrowserWindow({
        width: clamped.width,
        height: clamped.height,
        ...(clamped.x !== undefined && clamped.y !== undefined
          ? { x: clamped.x, y: clamped.y }
          : {}),
        minWidth: COMPOSE_MIN_WIDTH,
        minHeight: COMPOSE_MIN_HEIGHT,
        useContentSize: true,
        resizable: true,
        maximizable: false,
        minimizable: true,
        fullscreenable: false,
        title: 'Compose',
        backgroundColor: '#0d1117',
        parent: mainWindow ?? undefined,
        // Centre on parent on first ever open (no saved position). After
        // that the saved x/y wins.
        ...(clamped.x === undefined ? { center: true } : {}),
        alwaysOnTop,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          zoomFactor: 1.0,
        },
      });

      // Re-arm zoom guard — same rationale as the v0.1.17 webchat path.
      composeWindow.webContents.on('did-finish-load', () => {
        try {
          composeWindow?.webContents.setZoomFactor(1.0);
          composeWindow?.webContents.setVisualZoomLevelLimits(1, 1);
        } catch (err) {
          console.error('[main] compose zoom reset failed', err);
        }
      });

      // Persist bounds on resize / move. Debounced.
      composeWindow.on('resize', () => {
        if (composeWindow) scheduleSaveComposeBounds(composeWindow);
      });
      composeWindow.on('move', () => {
        if (composeWindow) scheduleSaveComposeBounds(composeWindow);
      });
      composeWindow.on('close', () => {
        if (composeWindow) {
          if (composeBoundsSaveTimer) {
            clearTimeout(composeBoundsSaveTimer);
            composeBoundsSaveTimer = undefined;
          }
          saveComposeBounds(composeWindow);
        }
      });
      composeWindow.on('closed', () => {
        composeWindow = null;
      });

      // Load the SAME renderer bundle as the main window, but with
      // `?compose=1` so `src/renderer/main.tsx` routes to `<ComposeApp>`
      // instead of the full `<App>`. This sidesteps a separate Vite
      // renderer entry while keeping all the React + preload wiring.
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void composeWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?compose=1`);
      } else {
        void composeWindow.loadFile(
          path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
          { query: { compose: '1' } },
        );
      }

      if (process.env.RC_DEVTOOLS === '1') composeWindow.webContents.openDevTools();

      return { ok: true as const };
    } catch (err) {
      console.error('[main] open compose failed', err);
      return {
        ok: false as const,
        reason: 'error' as const,
        error: String((err as Error)?.message ?? err),
      };
    }
  });

  // ----- IPC: COMPOSE_GET_INIT — initial state for the Compose renderer -----
  ipcMain.handle(IPC.COMPOSE_GET_INIT, () => {
    const saved = store.get('composeWindow') as ComposeWindowBounds | undefined;
    return {
      alwaysOnTop: saved?.alwaysOnTop === true,
      connected: chat.getState().status === 'connected',
      authenticated: oauth.isAuthenticated(),
    };
  });

  // ----- IPC: COMPOSE_SET_ALWAYS_ON_TOP -----
  ipcMain.handle(IPC.COMPOSE_SET_ALWAYS_ON_TOP, (_evt, alwaysOnTop: boolean) => {
    const flag = alwaysOnTop === true;
    try {
      if (composeWindow && !composeWindow.isDestroyed()) {
        composeWindow.setAlwaysOnTop(flag);
      }
      const prev = store.get('composeWindow') as ComposeWindowBounds | undefined;
      const next: ComposeWindowBounds = prev
        ? { ...prev, alwaysOnTop: flag }
        : { width: 520, height: 280, alwaysOnTop: flag };
      store.set('composeWindow', next);
    } catch (err) {
      console.error('[main] compose set-always-on-top failed', err);
    }
    return { alwaysOnTop: flag };
  });

  // ----- IPC: open Restream's official webchat (escape hatch) -----
  //
  // Pre-v0.1.32 this was the default Compose window. As of v0.1.32 the
  // Compose button opens the native React UI above; this handler stays as
  // the escape hatch for: (a) users who need Restream's full reply UI
  // (emoji picker, per-platform channel targeting), (b) recovering from
  // an expired session cookie. Exposed via a button INSIDE the Compose
  // window now.
  ipcMain.handle(IPC.CHAT_OPEN_RESTREAM_WEBCHAT, async () => {
    try {
      const token = oauth.getToken();
      if (!token) return { ok: false as const, reason: 'not-authenticated' as const };
      let url = '';
      try {
        const res = await fetch('https://api.restream.io/v2/user/webchat/url', {
          headers: { authorization: `Bearer ${token.accessToken}` },
        });
        if (res.ok) {
          const json: any = await res.json();
          if (typeof json?.webchatUrl === 'string') url = json.webchatUrl;
        } else {
          console.warn(
            '[main] webchat-url fetch failed status=' + res.status + ', falling back to chat.restream.io',
          );
        }
      } catch (err) {
        console.warn('[main] webchat-url fetch threw, falling back to chat.restream.io', err);
      }
      if (!url) url = 'https://chat.restream.io';
      const win = new BrowserWindow({
        // Restream's /embed needs the bigger frame to render without
        // min-width clipping — keep the pre-v0.1.32 dimensions for this
        // escape hatch only.
        width: 720,
        height: 720,
        minWidth: 480,
        minHeight: 420,
        useContentSize: true,
        resizable: true,
        title: 'Restream Webchat',
        backgroundColor: '#0d1117',
        parent: mainWindow ?? undefined,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          session: session.fromPartition('persist:restream-oauth'),
          zoomFactor: 1.0,
        },
      });
      win.webContents.on('did-finish-load', () => {
        try {
          win.webContents.setZoomFactor(1.0);
          win.webContents.setVisualZoomLevelLimits(1, 1);
        } catch (err) {
          console.error('[main] webchat zoom reset failed', err);
        }
      });
      try {
        attachComposeRequestLogger(win, chat.getRawLogPath());
      } catch (err) {
        console.error('[main] failed to attach webchat request logger', err);
      }
      void win.loadURL(url);
      return { ok: true as const };
    } catch (err) {
      console.error('[main] open restream webchat failed', err);
      return {
        ok: false as const,
        reason: 'error' as const,
        error: String((err as Error)?.message ?? err),
      };
    }
  });

  // ----- IPC: inline chat send via Restream's /client/reply endpoint -----
  // Direct fetch from main using the OAuth partition's chat-session cookies.
  // Reverse-engineered in v0.1.12; shipped behind an inline input bar in
  // v0.1.14. 1 msg/sec rate-limited so accidental rapid-fire (e.g. holding
  // Enter on a stuck key) can't hammer Restream's edge.
  //
  // showId hydration (v0.1.20): the WS sniffs showId from `event` /
  // `reply_created` frames, but those only flow when chat is active.
  // If the user opens the app cold and tries to send before any frame
  // arrives, we hit Restream's public REST API for in-progress events
  // and use that event id as a candidate showId. The result is cached
  // per session (showIdRestCache) — Restream's event id changes per
  // stream session, so a stale cache is acceptable until the user
  // reconnects the WS.
  //
  // v0.1.28: stale-but-present invalidation. The cache could ALSO hold a
  // showId from a show that ended hours ago — Restream returns 404 on
  // /client/reply for both "never had a show" AND "show ended" with the
  // same status code and body, so we can't tell pre-send. Two layers
  // defend against this:
  //   1. On a POST 404 the inline send path calls `refreshShowIdForce()`
  //      which clears both the REST cache + the WS sniff, re-hits the
  //      REST API, and feeds the result into a single retry POST.
  //   2. A 10-minute periodic poller (while WS connected) re-hydrates
  //      the cache so a stale show id can't linger across multiple sends.
  let lastSendAt = 0;
  let showIdRestCache: string | undefined;
  const hydrateShowIdViaRest = async (): Promise<string | undefined> => {
    const token = oauth.getToken();
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
        const first = json[0] as { id?: unknown };
        if (typeof first?.id === 'string' && first.id) {
          return first.id;
        }
      }
      return undefined;
    } catch (err) {
      console.warn('[main] in-progress events fetch threw', err);
      return undefined;
    }
  };
  /**
   * Cache-coherent hydration used as `fetchShowId` on the FIRST POST.
   * Returns the cached value if present; otherwise hits the REST API and
   * caches the result for subsequent sends within this WS session.
   */
  const fetchActiveShowIdFromApi = async (): Promise<string | undefined> => {
    if (showIdRestCache) return showIdRestCache;
    const fresh = await hydrateShowIdViaRest();
    if (fresh) showIdRestCache = fresh;
    return fresh;
  };
  /**
   * v0.1.28: force-refresh used as `refreshShowId` on the retry path AFTER
   * a 404. Invalidates BOTH the REST cache AND the WS-sniffed value (so
   * `chat.getShowId()` returns undefined until a new frame lands), then
   * re-hits the REST API. The returned value is cached as the new
   * authority. If the REST API also returns nothing (no active in-progress
   * event), we return undefined and the retry POSTs without showId —
   * Restream will 404 again and the user sees the "no active show" error.
   */
  const refreshShowIdForce = async (): Promise<string | undefined> => {
    showIdRestCache = undefined;
    try {
      chat.invalidateShowId();
    } catch (err) {
      console.error('[main] chat.invalidateShowId failed', err);
    }
    const fresh = await hydrateShowIdViaRest();
    if (fresh) showIdRestCache = fresh;
    return fresh;
  };

  // Reset the REST cache whenever the WS reconnects — that value is
  // authoritative once seen, and a stale REST cache could smuggle the
  // wrong show across an account switch / reconnect.
  chat.on('state', (s) => {
    if (s.status === 'connecting' || s.status === 'reconnecting') {
      showIdRestCache = undefined;
    }
  });

  // ---- v0.1.28: periodic showId refresh (10-minute interval) ----------
  // While the WS is connected, re-hit the REST API every 10 minutes and
  // overwrite the cache. Catches the "stream ended hours ago but the app
  // kept running" case before the user hits send and gets a 404. Only
  // armed while connected; torn down on disconnect / reconnect / app quit
  // so we don't waste API calls when the WS is down.
  const SHOW_ID_REFRESH_INTERVAL_MS = 10 * 60_000; // 10 minutes
  let showIdRefreshTimer: NodeJS.Timeout | undefined;
  const stopShowIdRefresh = (): void => {
    if (showIdRefreshTimer) {
      clearInterval(showIdRefreshTimer);
      showIdRefreshTimer = undefined;
    }
  };
  const startShowIdRefresh = (): void => {
    stopShowIdRefresh();
    showIdRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await hydrateShowIdViaRest();
          if (fresh) {
            // Overwrite cache unconditionally — the REST endpoint is the
            // authoritative "currently in-progress" signal for the user's
            // primary event. The WS-sniffed value stays untouched (it's
            // still the canonical "what arrived on the wire") but the
            // cache used by the send path is now fresh.
            showIdRestCache = fresh;
          } else {
            // No in-progress event — invalidate cache so the next send
            // falls through to the 404 → no-show-id error rather than
            // POSTing with a stale id.
            showIdRestCache = undefined;
          }
        } catch (err) {
          console.warn('[main] periodic showId refresh threw', err);
        }
      })();
    }, SHOW_ID_REFRESH_INTERVAL_MS);
  };
  chat.on('state', (s) => {
    if (s.status === 'connected') {
      startShowIdRefresh();
    } else if (
      s.status === 'connecting' ||
      s.status === 'reconnecting' ||
      s.status === 'disconnected' ||
      s.status === 'error'
    ) {
      // Cancel on any transition out of connected. Re-armed on next connect.
      stopShowIdRefresh();
    }
  });
  app.on('before-quit', () => stopShowIdRefresh());

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
      if (!oauth.isAuthenticated()) {
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
        showId: chat.getShowId(),
        fetchShowId: fetchActiveShowIdFromApi,
        refreshShowId: refreshShowIdForce,
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

  // Resume session if a valid token already exists.
  //
  // Resume order:
  //   1. If stored access token is still valid → start the WS immediately.
  //   2. Otherwise attempt `oauth.refresh()` using the stored refresh token.
  //      On success, persist the new token + start the WS + broadcast.
  //      On failure, leave the user signed-out so the renderer's "Sign in"
  //      button is the next action.
  //
  // Whichever leg runs, we ALWAYS:
  //   - call `pushAuthStatus()` so the renderer's AUTH_STATUS reflects truth
  //     (the auth subscription set up on `did-finish-load` consumes this);
  //   - resolve `startupAuthDone` so the `did-finish-load` handler stops
  //     waiting and pushes the initial AUTH_STATUS snapshot.
  //
  // This fixes the "every update logs me out" symptom: Squirrel restarts
  // the app after replacing the bundle; the access token is usually past
  // its 1h expiresAt by then; a synchronous check would mark the user
  // signed-out, the refresh would silently succeed in the background, but
  // the renderer would never hear about it.
  try {
    if (oauth.isAuthenticated()) {
      const t = oauth.getToken()!;
      chat.setToken(t.accessToken);
      chat.start();
    } else {
      const refreshed = await oauth.refresh();
      if (refreshed) {
        chat.setToken(refreshed.accessToken);
        chat.start();
      }
    }
  } catch (err) {
    console.error('[main] startup auth resume failed', err);
  } finally {
    // Broadcast the final auth state and unblock did-finish-load.
    pushAuthStatus();
    resolveStartupAuth();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
