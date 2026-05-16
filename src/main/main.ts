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
      const win = new BrowserWindow({
        width: 420,
        height: 640,
        title: 'Restream Chat++ — Compose',
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
