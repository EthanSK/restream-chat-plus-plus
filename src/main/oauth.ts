import { BrowserWindow, session } from 'electron';
import http from 'node:http';
import { URL } from 'node:url';
import { loadRestreamCreds } from './credentials';
import type { Store } from './store';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope: string;
  expiresAt: number; // epoch ms
}

const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth`;
const SCOPES = [
  'profile.read',
  'channels.read',
  'stream.read',
  'chat.read',
  'channels.write',
  'stream.write',
];
const AUTH_URL = 'https://api.restream.io/login';
const TOKEN_URL = 'https://api.restream.io/oauth/token';

export class OAuthCoordinator {
  private server?: http.Server;
  constructor(private store: Store) {}

  getToken(): TokenSet | undefined {
    return this.store.get('token') as TokenSet | undefined;
  }

  isAuthenticated(): boolean {
    const t = this.getToken();
    if (!t) return false;
    return t.expiresAt - Date.now() > 60_000;
  }

  async logout(): Promise<void> {
    this.store.delete('token');
  }

  /**
   * Run the full OAuth Authorization Code flow.
   * 1. Spin up a one-shot localhost HTTP listener on REDIRECT_PORT.
   * 2. Open a BrowserWindow at AUTH_URL?...redirect_uri=...
   * 3. When the user finishes login, Restream redirects to our local server with ?code=...
   * 4. POST to TOKEN_URL with client_id/secret/code to exchange for a token set.
   * 5. Persist token in electron-store and close the BrowserWindow.
   */
  async authenticate(): Promise<TokenSet> {
    const creds = loadRestreamCreds();
    if (!creds) {
      throw new Error(
        'Missing Restream credentials. Set RESTREAM_CLIENT_ID and RESTREAM_CLIENT_SECRET env vars, or store them in macOS Keychain under service "api.restream.io".',
      );
    }

    const codePromise = this.listenForCode();

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', creds.clientId);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', SCOPES.join(' '));

    const win = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'Restream Chat++ — Sign in',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: session.fromPartition('persist:restream-oauth'),
      },
    });
    win.loadURL(authUrl.toString());

    let code: string;
    try {
      code = await codePromise;
    } finally {
      this.stopListener();
      if (!win.isDestroyed()) win.close();
    }

    const tokenSet = await this.exchangeCode(creds, code);
    this.store.set('token', tokenSet);
    return tokenSet;
  }

  /**
   * If the access token is expired but a refresh token exists, refresh.
   * Returns the new token set or undefined if refresh failed / not possible.
   */
  async refresh(): Promise<TokenSet | undefined> {
    const existing = this.getToken();
    if (!existing?.refreshToken) return undefined;
    const creds = loadRestreamCreds();
    if (!creds) return undefined;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) return undefined;
      const json: any = await res.json();
      const tokenSet: TokenSet = {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? existing.refreshToken,
        tokenType: json.token_type ?? 'Bearer',
        scope: json.scope ?? existing.scope,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
      this.store.set('token', tokenSet);
      return tokenSet;
    } catch {
      return undefined;
    }
  }

  private async exchangeCode(
    creds: { clientId: string; clientSecret: string },
    code: string,
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed: ${res.status} ${text}`);
    }
    const json: any = await res.json();
    if (!json.access_token) {
      throw new Error(`Token exchange returned no access_token: ${JSON.stringify(json)}`);
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      tokenType: json.token_type ?? 'Bearer',
      scope: json.scope ?? SCOPES.join(' '),
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  }

  private listenForCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (!req.url) return;
        const url = new URL(req.url, REDIRECT_URI);
        if (url.pathname !== '/oauth') {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'content-type': 'text/html' });
          res.end(`<html><body><h2>OAuth error</h2><pre>${escape(error)}</pre></body></html>`);
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400).end('Missing code');
          reject(new Error('OAuth callback missing code'));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><body style="font-family:-apple-system,sans-serif;padding:32px"><h2>Signed in to Restream Chat++.</h2><p>You can close this window.</p></body></html>',
        );
        resolve(code);
      });
      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        // ready
      });
      server.on('error', reject);
      this.server = server;
    });
  }

  private stopListener() {
    try {
      this.server?.close();
    } catch {
      // ignore
    }
    this.server = undefined;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
