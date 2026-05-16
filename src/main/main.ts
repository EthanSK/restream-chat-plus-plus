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
import { configureAutoUpdater, checkForUpdatesInteractive } from './updater';
import {
  DEFAULT_SETTINGS,
  IPC,
  Settings,
  AuthStatus,
  ConnectionState,
} from '../shared/types';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

if (started) app.quit();

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
                id: 'check-for-updates',
                label: 'Check for Updates…',
                enabled: true,
                // The click handler MUST NOT throw synchronously — Electron
                // surfaces a sync throw as the macOS system alert "this
                // command is disabled and cannot be executed". Wrap defensively.
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
                label: 'Check for Updates…',
                enabled: true,
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

  // When the renderer finishes loading, push the CURRENT connection state +
  // current auth status so the renderer doesn't sit on its initial 'idle'
  // placeholder. The push-only IPC channel (CONN_STATE) only delivers
  // updates; if chat.start() ran before the renderer mounted (auth resume
  // path), the renderer would otherwise never receive the initial state.
  mainWindow?.webContents.on('did-finish-load', () => {
    try {
      mainWindow?.webContents.send(IPC.CONN_STATE, chat.getState());
      mainWindow?.webContents.send(IPC.CONNECTIONS, chat.getConnections());
      const t = oauth.getToken();
      mainWindow?.webContents.send(IPC.AUTH_STATUS, {
        authenticated: oauth.isAuthenticated(),
        scope: t?.scope,
        expiresAt: t?.expiresAt,
      } satisfies AuthStatus);
    } catch (err) {
      console.error('[main] failed to send initial state on did-finish-load', err);
    }
  });

  // Wire auto-update polling (update.electronjs.org → GitHub Releases).
  // Skipped automatically in dev / when not packaged / when running unsigned.
  configureAutoUpdater();

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
    };
  }
  ipcMain.handle(IPC.SETTINGS_GET, (): Settings => loadSettings());
  ipcMain.handle(IPC.SETTINGS_SET, (_evt, settings: Settings) => {
    store.set('settings', settings);
    return settings;
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
      const res = await fetch('https://api.restream.io/v2/user/webchat/url', {
        headers: { authorization: `Bearer ${token.accessToken}` },
      });
      if (!res.ok) {
        return {
          ok: false as const,
          reason: 'webchat-fetch-failed' as const,
          status: res.status,
        };
      }
      const json: any = await res.json();
      const url = typeof json?.webchatUrl === 'string' ? json.webchatUrl : '';
      if (!url) return { ok: false as const, reason: 'no-webchat-url' as const };
      // Open in a dedicated BrowserWindow rather than the system browser so
      // Ethan can leave it docked next to our app and the OAuth session
      // stays separate from his daily-driver browser.
      //
      // Sized as a narrow chat-input pane (content size, not window chrome),
      // resizable so the user can stretch it if Restream's webchat layout
      // wants more room. Minimums prevent the user from accidentally
      // collapsing it to unusable.
      const win = new BrowserWindow({
        width: 380,
        height: 320,
        minWidth: 320,
        minHeight: 240,
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
        },
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

  // ----- Forward chat & state to renderer -----
  chat.on('message', (m) => mainWindow?.webContents.send(IPC.CHAT_MESSAGE, m));
  chat.on('state', (s) => mainWindow?.webContents.send(IPC.CONN_STATE, s));
  chat.on('connections', (cs) =>
    mainWindow?.webContents.send(IPC.CONNECTIONS, cs),
  );

  // Resume session if a valid token already exists.
  if (oauth.isAuthenticated()) {
    const t = oauth.getToken()!;
    chat.setToken(t.accessToken);
    chat.start();
  } else {
    // Try refresh in the background.
    const refreshed = await oauth.refresh();
    if (refreshed) {
      chat.setToken(refreshed.accessToken);
      chat.start();
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
