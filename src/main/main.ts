import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  session,
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
  type ChatSendLogRecord,
  type ChatContext,
} from './chat-send';
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
  // Persist Settings + return the saved value. Pulled out as a named
  // helper so the in-process HTTP MCP server (`mcp-server.ts`,
  // v0.1.36+) can write through the same path — that guarantees the
  // store + the on-disk JSON + the IPC contract all stay aligned.
  function saveSettings(settings: Settings): Settings {
    store.set('settings', settings);
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

  // ----- IPC: open Restream's official webchat (escape hatch) -----
  //
  // v0.1.34: the native React Compose window (v0.1.32-v0.1.33) was removed
  // — it duplicated the inline send path with no functional value beyond
  // what inline + this webchat escape-hatch provide together. This handler
  // remains as the single button for: (a) users who need Restream's full
  // reply UI (emoji picker, per-platform channel targeting), (b)
  // recovering from an expired session cookie. Exposed via the "Webchat"
  // ghost button next to the inline send arrow.
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
