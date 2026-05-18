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

/**
 * Default ceiling for any single `safeStorage.decryptString` call. macOS
 * Keychain blocks the entire main thread on the synchronous decrypt syscall
 * when the binary's code signature doesn't match the ACL on the stored
 * entry — SecurityAgent pops a "Restream Chat++ wants to use Confidential
 * Information stored in your keychain" prompt and the main process sits
 * frozen until the user clicks Allow or Deny.
 *
 * v0.1.38 fix: decrypt runs OFF the boot critical path (the window comes up
 * first regardless), AND every decrypt call is wrapped in a Promise.race
 * against this timeout. If the timeout fires we assume ACL drift, wipe the
 * encrypted blob from the store, and surface a signed-out state so the
 * user can re-auth — no synchronous Keychain prompt blocks boot.
 *
 * NOTE: Promise.race does NOT cancel the underlying sync `decryptString`
 * syscall — that's a Node/Electron limitation. What it DOES guarantee is
 * that the rest of the app (window paint, IPC handlers, network) keeps
 * running while the syscall is in flight, because we await on the race
 * result on a non-critical path. The first decrypt request happens AFTER
 * the window is visible, so even if the user gets a Keychain prompt they
 * see a UI behind it, not a hung dock icon.
 */
const SAFE_STORAGE_DECRYPT_TIMEOUT_MS = 2000;

export class OAuthCoordinator {
  private server?: http.Server;
  /**
   * Lazy decrypt cache. Set on the first successful decrypt (or after a
   * fresh authenticate / refresh). All subsequent `getToken()` callers hit
   * this in-memory copy — Keychain is touched at most once per app launch.
   */
  private cachedToken?: TokenSet;
  /**
   * In-flight decrypt promise — concurrent callers (renderer mount,
   * startup-resume, WS open, IPC handler) all await the same promise
   * instead of triggering N Keychain prompts.
   */
  private decryptPromise?: Promise<TokenSet | undefined>;
  /**
   * Whether we've already detected ACL drift / corrupt ciphertext on this
   * launch. Once true, we stop attempting to decrypt and short-circuit to
   * the signed-out state until the user re-auths.
   */
  private decryptDisabled = false;

  constructor(private store: Store) {}

  /**
   * Whether the OS-backed `safeStorage` is currently usable for encrypting
   * tokens at rest. macOS Keychain almost always returns true; some Linux
   * setups without a keyring (and some sandbox/CI environments) return
   * false, in which case we fall back to plain-JSON storage so the user is
   * still able to authenticate — just without the at-rest protection.
   *
   * On macOS this call is fast and does NOT trigger the SecurityAgent
   * prompt — only `encryptString` / `decryptString` against an
   * ACL-mismatched entry do. Safe to call on the boot path.
   */
  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Synchronous token read — returns the cached decrypted token if we
   * already decrypted once this launch, or undefined otherwise. Does NOT
   * touch Keychain. Callers that need to wait for the first decrypt to
   * settle (boot resume, IPC AUTH_STATUS pull, WS open) should call
   * `getTokenAsync()` instead.
   *
   * This is the post-boot fast path — once the deferred decrypt has run,
   * every subsequent caller (compose-window open, periodic refresh,
   * webchat link) gets the cached value with zero syscall cost.
   */
  getToken(): TokenSet | undefined {
    if (this.cachedToken) return this.cachedToken;
    // Legacy plain-JSON fallback: present iff (a) pre-v0.1.15 install
    // never migrated OR (b) safeStorage was unavailable when the token was
    // persisted. Both paths are sync-safe — no Keychain touch.
    //
    // When we find a legacy plain token we also migrate it forward into
    // the encrypted blob (sync-safe — `safeStorage.encryptString` doesn't
    // prompt; the SecurityAgent prompt only happens on decrypt of an
    // ACL-mismatched entry). Keeps the secret in one place going forward.
    const legacy = this.store.get('token') as TokenSet | undefined;
    if (legacy) {
      this.persistToken(legacy);
      return legacy;
    }
    return undefined;
  }

  /**
   * Async token read — kicks off (or joins) a deferred decrypt of the
   * encrypted blob with a timeout. The first call per app launch is what
   * actually touches Keychain; every subsequent call resolves from the
   * in-memory cache.
   *
   * Boot path: main.ts awaits this AFTER the window is shown, so a
   * SecurityAgent prompt (if any) appears with the UI already visible
   * rather than blocking on a black dock icon.
   *
   * On timeout / decrypt failure we treat the entry as stale ACL,
   * wipe it from the store, and resolve undefined → user re-auths.
   */
  async getTokenAsync(): Promise<TokenSet | undefined> {
    if (this.cachedToken) return this.cachedToken;

    // Legacy plain-JSON path doesn't need an async decrypt — answer
    // immediately so the boot path doesn't unnecessarily wait.
    const legacy = this.store.get('token') as TokenSet | undefined;
    if (legacy) {
      this.cachedToken = legacy;
      return legacy;
    }

    const enc = this.store.get('tokenEnc');
    if (!enc) return undefined;

    if (this.decryptDisabled) return undefined;

    // Coalesce concurrent callers onto a single in-flight decrypt.
    if (!this.decryptPromise) {
      this.decryptPromise = this.runDeferredDecrypt(enc as string)
        .catch((err) => {
          console.error('[oauth] deferred decrypt threw', err);
          return undefined;
        })
        .finally(() => {
          // Allow a fresh attempt later only if the prior attempt was a
          // hard failure with no cached value to show for it.
          if (!this.cachedToken) this.decryptPromise = undefined;
        });
    }

    return this.decryptPromise;
  }

  /**
   * Sync auth check — returns true iff a previously-decrypted token sits
   * in the in-memory cache AND is still within its access-token validity
   * window. Safe on the boot path; returns false until the deferred
   * decrypt settles.
   *
   * Production callers should generally prefer `isAuthenticatedAsync()`
   * on cold-boot paths so a slow Keychain prompt doesn't briefly flash
   * the "Sign in" screen.
   */
  isAuthenticated(): boolean {
    const t = this.getToken();
    if (!t) return false;
    return t.expiresAt - Date.now() > 60_000;
  }

  /**
   * Async auth check — awaits the deferred decrypt (if any) and then
   * applies the same 60-second validity buffer used by `isAuthenticated`.
   * Used by the startup resume path in main.ts so a renderer that mounts
   * before decrypt completes gets the correct truth.
   */
  async isAuthenticatedAsync(): Promise<boolean> {
    const t = await this.getTokenAsync();
    if (!t) return false;
    return t.expiresAt - Date.now() > 60_000;
  }

  async logout(): Promise<void> {
    this.cachedToken = undefined;
    this.decryptDisabled = false;
    this.decryptPromise = undefined;
    this.store.delete('token');
    this.store.delete('tokenEnc');
  }

  /**
   * Encrypt + store the token. If safeStorage is unavailable we fall back
   * to the legacy plain `token` key so the user can still sign in on
   * platforms / setups without a working OS keyring.
   *
   * Also updates the in-memory cache so subsequent `getToken()` calls
   * skip Keychain entirely until next launch.
   */
  private persistToken(token: TokenSet): void {
    this.cachedToken = token;
    this.decryptDisabled = false;
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
   * Run the actual decrypt with a hard timeout AND ACL-mismatch recovery.
   *
   * On the FIRST decrypt of an app launch we yield to the event loop
   * (`setImmediate`) so the window-paint tick fires before the
   * Keychain syscall. The user always sees a UI before any Keychain
   * prompt — that's the core anti-hang guarantee of v0.1.38.
   *
   * On timeout OR decrypt-throw we:
   *   1. Mark decryptDisabled so we never try again this launch.
   *   2. Delete the `tokenEnc` blob from the store. The OLD ciphertext was
   *      bound to a prior binary's code signature ACL — keeping it means
   *      every future launch hits the same prompt. Wipe it so the next
   *      successful OAuth completion writes a fresh blob under the
   *      current binary's ACL.
   *   3. Resolve undefined so the caller falls through to the sign-in
   *      screen.
   */
  private async runDeferredDecrypt(
    encBase64: string,
  ): Promise<TokenSet | undefined> {
    // Yield to the event loop so the renderer can paint at least one
    // frame before we hit Keychain. Two ticks of setImmediate is enough
    // on macOS for the first paint cycle to complete; this is empirical
    // (Electron paints on a separate thread but the IPC + renderer-mount
    // round-trip still needs the main thread to drain its queue).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const decryptOnce = async (): Promise<TokenSet | undefined> => {
      if (!this.encryptionAvailable()) return undefined;
      try {
        const buf = Buffer.from(encBase64, 'base64');
        const json = safeStorage.decryptString(buf);
        const parsed = JSON.parse(json) as TokenSet;
        if (!parsed || typeof parsed.accessToken !== 'string') return undefined;
        return parsed;
      } catch (err) {
        console.error('[oauth] safeStorage.decryptString failed', err);
        return undefined;
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(
        () => resolve('__timeout__'),
        SAFE_STORAGE_DECRYPT_TIMEOUT_MS,
      );
    });

    try {
      const result = await Promise.race([decryptOnce(), timeout]);
      if (result === '__timeout__') {
        console.warn(
          `[oauth] safeStorage.decryptString timed out after ${SAFE_STORAGE_DECRYPT_TIMEOUT_MS}ms — assuming stale Keychain ACL, wiping tokenEnc`,
        );
        this.handleAclDrift();
        return undefined;
      }
      if (!result) {
        // Decrypt returned undefined (encryption-unavailable / bad
        // ciphertext / JSON parse error / missing accessToken). Same
        // treatment as a timeout — wipe and force re-auth.
        console.warn(
          '[oauth] safeStorage.decryptString returned no usable token — wiping tokenEnc',
        );
        this.handleAclDrift();
        return undefined;
      }
      this.cachedToken = result;
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Wipe the encrypted-token blob from the store after a decrypt failure
   * / timeout. Marks the coordinator as decrypt-disabled for this launch
   * so we don't loop on the same broken blob across multiple callers.
   */
  private handleAclDrift(): void {
    this.decryptDisabled = true;
    try {
      this.store.delete('tokenEnc');
    } catch (err) {
      console.error('[oauth] failed to wipe tokenEnc after ACL drift', err);
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
   *
   * v0.1.38: awaits the deferred decrypt so a refresh kicked before the
   * first cache hydration still finds the refresh-token correctly.
   */
  async refresh(): Promise<TokenSet | undefined> {
    const existing = await this.getTokenAsync();
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
