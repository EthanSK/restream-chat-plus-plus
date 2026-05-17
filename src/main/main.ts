import {
  app,
  BrowserWindow,
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
import { sendChatText } from './chat-send';
import { configureAutoUpdater, checkForUpdatesInteractive } from './updater';
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
  // Used by the UpdateBanner's Download button to navigate to the GH release
  // page. We intentionally don't try to apply the update in-place because
  // unsigned macOS builds can't auto-install — opening the release page in
  // the browser is the only viable path until signing lands.
  //
  // Sanity-check that the URL is http(s) before forwarding to
  // `shell.openExternal` so a malicious renderer (XSS in a future feature)
  // can't trick the main process into opening a `file://` URL or a
  // custom-protocol handler.
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

  // ----- IPC: open Restream's official webchat compose window -----
  // Restream's public Chat API is RECEIVE-ONLY for third-party clients —
  // see https://developers.restream.io/chat/getting-started: "This API
  // works one way — from the server to the client. The server will ignore
  // any incoming messages." So to actually let the user TYPE a reply we
  // delegate to Restream's first-party webchat URL (the same one used by
  // the official Restream Chat app), which uses an internal API. The
  // reply ends up echoed back to us as a `reply_created` WS frame, and
  // we surface it as a `self: true` ChatMessage in our feed — closing the
  // round-trip so Ethan sees his own messages here too.
  ipcMain.handle(IPC.CHAT_OPEN_COMPOSE, async () => {
    try {
      const token = oauth.getToken();
      if (!token) return { ok: false as const, reason: 'not-authenticated' as const };
      // The official documented endpoint for fetching a one-shot webchat
      // URL: GET /v2/user/webchat/url. This has been intermittently
      // returning 4xx/5xx for Ethan's account (v0.1.13 — "could not fetch
      // web chat URL"). Per v0.1.14 the failure path is no longer a
      // hard error: we fall back to opening https://chat.restream.io
      // directly. The same persistent partition still carries the
      // user's session cookies, so the webchat trips on the existing
      // login. If the partition is cold the webchat will redirect to
      // login → user signs in once → cookies provisioned for next time.
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
      if (!url) {
        // Fall back to the canonical chat URL; user's session cookies in
        // `persist:restream-oauth` will be sent automatically.
        url = 'https://chat.restream.io';
      }
      // Open in a dedicated BrowserWindow rather than the system browser so
      // Ethan can leave it docked next to our app and the OAuth session
      // stays separate from his daily-driver browser.
      //
      // Sized as a narrow chat-input pane (content size, not window chrome),
      // resizable so the user can stretch it if Restream's webchat layout
      // wants more room. Minimums prevent the user from accidentally
      // collapsing it to unusable.
      const win = new BrowserWindow({
        // v0.1.17: the previous 380x320 default was too small for Restream's
        // /embed webchat — at that size the chat layout's min-widths kick in
        // and the page renders at what looks like 200%+ zoom (clipped text,
        // huge buttons). 720x720 with a more permissive minWidth gives the
        // embed enough room to render at its natural size. `useContentSize`
        // ensures the dimensions are the WEB content area, not including the
        // titlebar / chrome.
        width: 720,
        height: 720,
        minWidth: 480,
        minHeight: 420,
        useContentSize: true,
        resizable: true,
        title: 'Restream Compose',
        backgroundColor: '#0d1117',
        parent: mainWindow ?? undefined,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          // Re-use the same persistent partition the OAuth flow uses
          // (`persist:restream-oauth`) so the webchat URL trips on the
          // already-authenticated session and skips the sign-in redirect.
          session: session.fromPartition('persist:restream-oauth'),
          // Disable Chromium's per-origin zoom-factor persistence. Without
          // this, a zoom level applied in a previous Compose session (or a
          // mis-tuned default from Restream's site CSS) is restored across
          // BrowserWindow lifetimes — Ethan saw the Compose window pop up at
          // ~150% zoom after each restart. v0.1.17 fix.
          zoomFactor: 1.0,
        },
      });

      // Force-reset zoom on load AND when the user accidentally triggers a
      // zoom shortcut. `webPreferences.zoomFactor` is the INITIAL value but
      // Chromium can drift if Restream's page or a pinch-zoom event fires.
      // We hard-reset on did-finish-load to neutralise any per-origin
      // persisted zoom and prevent the "tiny window + huge text" symptom.
      win.webContents.on('did-finish-load', () => {
        try {
          win.webContents.setZoomFactor(1.0);
          win.webContents.setVisualZoomLevelLimits(1, 1);
        } catch (err) {
          console.error('[main] compose zoom reset failed', err);
        }
      });

      // ----------------------------------------------------------------
      // v0.1.12 reverse-engineering hook
      // ----------------------------------------------------------------
      // Restream's webchat is a black box: it POSTs the user's typed
      // message to some endpoint, the WS then broadcasts back a
      // `reply_created` frame which we already render as a `self`
      // message in the feed. We don't yet KNOW the endpoint shape —
      // public docs don't document one ("This API works one way" —
      // https://developers.restream.io/chat/getting-started).
      //
      // We have strong leads from the chat-frontend bundle though:
      //   POST https://backend.chat.restream.io/api/v2/client/reply
      //   body: { connectionIdentifiers, clientReplyUuid, text,
      //           showId? | eventId? | instant? }
      //   auth: cookies (.restream.io session) + header
      //         x-axsrf-token = value of cookie "accessXsrfToken"
      //
      // To confirm and capture the exact request shape, instrument the
      // Compose webContents' session-level webRequest listeners. Every
      // outbound HTTP request gets its URL + method + headers + body
      // appended to a JSONL debug log next to raw-frames.jsonl. Ethan
      // opens Compose, sends a message, and the log contains the truth.
      // No GUI launches needed on the dev side.
      try {
        attachComposeRequestLogger(win, chat.getRawLogPath());
      } catch (err) {
        console.error('[main] failed to attach compose request logger', err);
      }
      void win.loadURL(url);
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
  let lastSendAt = 0;
  let showIdRestCache: string | undefined;
  const fetchActiveShowIdFromApi = async (): Promise<string | undefined> => {
    if (showIdRestCache) return showIdRestCache;
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
          showIdRestCache = first.id;
          return showIdRestCache;
        }
      }
      return undefined;
    } catch (err) {
      console.warn('[main] in-progress events fetch threw', err);
      return undefined;
    }
  };
  // Reset the REST cache whenever the WS sniffs a fresh showId — that
  // value is authoritative once seen, and a stale REST cache could
  // smuggle the wrong show across an account switch / reconnect.
  chat.on('state', (s) => {
    if (s.status === 'connecting' || s.status === 'reconnecting') {
      showIdRestCache = undefined;
    }
  });
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
