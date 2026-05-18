// In-process HTTP MCP server lifecycle wiring for the main Electron process.
//
// Spec: when the Restream Chat++ GUI is running, an HTTP MCP server lives
// inside the main process on `127.0.0.1:19852`. ANY MCP client (Claude
// Code via `type: http`, the MCP Inspector, raw curl) can hit
// `POST /mcp` to read/write settings + drive live actions WITHOUT
// spawning a child process. v0.1.36+.
//
// This module owns:
//   1. Building the `LiveSettingsBridge` over the running app's store
//      + chat client + OAuth coordinator so MCP mutations affect the
//      live UI immediately (no restart).
//   2. Starting the HTTP server on `app.whenReady()`.
//   3. Writing the port-discovery file (`mcp-port.json` in userData).
//   4. Stopping the server cleanly on `before-quit`.
//
// Failure mode: the entire MCP layer is best-effort. If port binding
// fails, log + skip — the rest of the app keeps running. We never let
// a transient MCP failure block the GUI from starting.

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import {
  startHttpMcpServer,
  resolvePortFilePath,
  DEFAULT_MCP_PORT,
  type HttpMcpServer,
} from '../mcp/http';
import type { LiveSettingsBridge, ToolContext } from '../mcp/tools';
import { IPC, type Settings } from '../shared/types';
import type { Store } from './store';
import type { ChatClient } from './ws-client';
import type { OAuthCoordinator } from './oauth';

export interface McpServerDeps {
  /** Reads + writes the LIVE Settings (the same path the renderer IPC uses). */
  loadSettings: () => Settings;
  saveSettings: (next: Settings) => Settings;
  /** Main BrowserWindow — used to push settings updates to the renderer. */
  getMainWindow: () => BrowserWindow | null;
  /** WS chat client — exposes connection state + per-platform list. */
  chat: ChatClient;
  /** OAuth coordinator — used by `sign_out` to clear the in-memory token. */
  oauth: OAuthCoordinator;
  /** Force a GH-Releases update check; resolves with the resulting info. */
  checkForUpdatesNow: () => Promise<unknown>;
  /** Plain store handle for `signOut` to clear `token` / `tokenEnc`. */
  store: Store;
}

export interface StartedMcpServer {
  port: number;
  portFilePath: string | null;
  stop: () => Promise<void>;
}

/**
 * Wire + start the in-process HTTP MCP server. Idempotent — calling
 * twice without an intervening stop returns the existing instance.
 */
export async function startInProcessMcpServer(
  deps: McpServerDeps,
): Promise<StartedMcpServer | null> {
  const userData = safeUserData();
  if (!userData) {
    console.error('[mcp] userData path unavailable — skipping MCP server');
    return null;
  }
  const storePath = path.join(userData, 'restream-chat-plus-plus.json');
  const portFilePath = resolvePortFilePath(userData);

  const live: LiveSettingsBridge = {
    readSettings: () => deps.loadSettings(),
    writeSettings: (next: Settings) => {
      const saved = deps.saveSettings(next);
      // Broadcast to the renderer so the Settings drawer + TTS pipeline
      // see the change immediately. We reuse the IPC channel the
      // renderer already pulls from on `getSettings()` so no new
      // contract is needed — the renderer just gets an unsolicited
      // push it can apply on next render tick.
      try {
        const win = deps.getMainWindow();
        // Use a dedicated "settings pushed" event name (distinct from
        // the SETTINGS_GET/SET pull/save pair) so the renderer can
        // subscribe without crossing wires with its own save flow.
        win?.webContents.send(IPC.SETTINGS_PUSH, saved);
      } catch (err) {
        console.error('[mcp] settings push to renderer failed', err);
      }
      return saved;
    },
    signOut: async () => {
      try {
        deps.chat.stop();
      } catch (err) {
        console.error('[mcp] chat.stop during sign_out failed', err);
      }
      try {
        await deps.oauth.logout();
      } catch (err) {
        console.error('[mcp] oauth.logout during sign_out failed', err);
      }
      // Also nuke disk keys belt-and-braces (covers any legacy `token`
      // that the OAuthCoordinator wouldn't touch).
      try {
        deps.store.delete('token');
      } catch {
        // ignore
      }
      try {
        deps.store.delete('tokenEnc');
      } catch {
        // ignore
      }
      // Push refreshed auth status so the renderer flips to the
      // sign-in screen without a restart.
      try {
        const win = deps.getMainWindow();
        win?.webContents.send(IPC.AUTH_STATUS, { authenticated: false });
      } catch (err) {
        console.error('[mcp] AUTH_STATUS push during sign_out failed', err);
      }
    },
    getRuntimeStatus: () => ({
      connectionStatus: deps.chat.getState(),
      connections: deps.chat.getConnections(),
      // `latestUpdateInfo` + `voices` would need an extra round-trip via
      // `executeJavaScript` (voices live in the renderer); leave null
      // for now so we don't block on that.
      latestUpdateInfo: null,
      voices: null,
    }),
    clearChat: () => {
      try {
        const win = deps.getMainWindow();
        win?.webContents.send(IPC.CHAT_CLEAR);
      } catch (err) {
        console.error('[mcp] CHAT_CLEAR push failed', err);
      }
    },
    checkForUpdatesNow: () => deps.checkForUpdatesNow(),
  };

  const ctx: ToolContext = {
    storePath,
    appVersion: tryGetAppVersion(),
    live,
  };

  let server: HttpMcpServer;
  try {
    server = await startHttpMcpServer({
      ctx,
      port: DEFAULT_MCP_PORT,
      portFilePath,
      log: (msg: string) => console.log(`[mcp-http] ${msg}`),
    });
  } catch (err) {
    console.error('[mcp] HTTP server failed to start', err);
    return null;
  }

  // Stop on app exit so the next launch can re-bind the port + we
  // don't leave a stale port-file behind. `before-quit` fires before
  // window-all-closed → app.quit on macOS, which is what we want.
  app.once('before-quit', () => {
    server.close().catch((err) => {
      console.error('[mcp] server close on before-quit failed', err);
    });
  });

  return {
    port: server.port,
    portFilePath: server.portFilePath,
    stop: () => server.close(),
  };
}

function safeUserData(): string | null {
  try {
    return app.getPath('userData');
  } catch {
    return null;
  }
}

function tryGetAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}
