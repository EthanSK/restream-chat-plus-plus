import { BrowserWindow, safeStorage, session } from 'electron';
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

  /**
   * Whether the OS-backed `safeStorage` is currently usable for encrypting
   * tokens at rest. macOS Keychain almost always returns true; some Linux
   * setups without a keyring (and some sandbox/CI environments) return
   * false, in which case we fall back to plain-JSON storage so the user is
   * still able to authenticate — just without the at-rest protection.
   */
  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Read the token from store. Prefers the encrypted `tokenEnc` field
   * introduced in v0.1.15; transparently migrates a legacy plain `token`
   * value to the encrypted form on first read so the secret only lives
   * on disk in one place going forward.
   */
  getToken(): TokenSet | undefined {
    // Encrypted path first.
    const enc = this.store.get('tokenEnc');
    if (enc) {
      const decrypted = this.tryDecrypt(enc);
      if (decrypted) return decrypted;
      // Decryption failed (corrupt blob, OS keyring rotated). Fall through
      // to the legacy plain key — if neither succeeds we return undefined
      // and the next launch path is a clean sign-in prompt.
    }

    const legacy = this.store.get('token') as TokenSet | undefined;
    if (legacy) {
      // Migrate forward: re-encrypt under `tokenEnc` (if possible), then
      // delete the legacy plain key.
      this.persistToken(legacy);
      return legacy;
    }

    return undefined;
  }

  isAuthenticated(): boolean {
    const t = this.getToken();
    if (!t) return false;
    return t.expiresAt - Date.now() > 60_000;
  }

  async logout(): Promise<void> {
    this.store.delete('token');
    this.store.delete('tokenEnc');
  }

  /**
   * Encrypt + store the token. If safeStorage is unavailable we fall back
   * to the legacy plain `token` key so the user can still sign in on
   * platforms / setups without a working OS keyring.
   */
  private persistToken(token: TokenSet): void {
    if (this.encryptionAvailable()) {
      try {
        const cipher = safeStorage.encryptString(JSON.stringify(token));
        // electron-store serialises to JSON, so the binary buffer must be
        // base64-encoded for round-tripping.
        this.store.set('tokenEnc', cipher.toString('base64'));
        this.store.delete('token');
        return;
      } catch (err) {
        // Encryption blew up despite isEncryptionAvailable returning true
        // — fall through to the plain path so we don't lose the session.
        console.error('[oauth] safeStorage.encryptString failed', err);
      }
    }
    // Plain fallback.
    this.store.set('token', token);
    this.store.delete('tokenEnc');
  }

  /**
   * Decrypt a base64-encoded safeStorage ciphertext back into a TokenSet.
   * Returns undefined on any failure (corrupt blob, key not available,
   * JSON parse error) so the caller can fall through to the legacy path
   * or trigger re-auth.
   */
  private tryDecrypt(b64: unknown): TokenSet | undefined {
    if (typeof b64 !== 'string' || b64.length === 0) return undefined;
    if (!this.encryptionAvailable()) return undefined;
    try {
      const buf = Buffer.from(b64, 'base64');
      const json = safeStorage.decryptString(buf);
      const parsed = JSON.parse(json) as TokenSet;
      if (!parsed || typeof parsed.accessToken !== 'string') return undefined;
      return parsed;
    } catch (err) {
      console.error('[oauth] safeStorage.decryptString failed', err);
      return undefined;
    }
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
    this.persistToken(tokenSet);
    return tokenSet;
  }

  /**
   * If the access token is expired but a refresh token exists, refresh.
   * Returns the new token set or undefined if refresh failed / not possible.
   *
   * Per Restream docs (https://developers.restream.io/authentication/refreshing-tokens)
   * Basic Auth is the recommended method (keeps the client_secret out of any
   * query-string-style logging). We send credentials via the Authorization
   * header and only the grant params in the body.
   */
  async refresh(): Promise<TokenSet | undefined> {
    const existing = this.getToken();
    if (!existing?.refreshToken) return undefined;
    const creds = loadRestreamCreds();
    if (!creds) return undefined;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken,
    });
    const basicAuth = Buffer.from(
      `${creds.clientId}:${creds.clientSecret}`,
      'utf8',
    ).toString('base64');
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basicAuth}`,
        },
        body: body.toString(),
      });
      if (!res.ok) return undefined;
      const json: any = await res.json();
      if (!json.access_token) return undefined;
      const tokenSet: TokenSet = {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? existing.refreshToken,
        tokenType: json.token_type ?? 'Bearer',
        scope: json.scope ?? existing.scope,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
      this.persistToken(tokenSet);
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
