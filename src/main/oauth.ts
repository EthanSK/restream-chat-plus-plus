import { BrowserWindow, safeStorage, session } from 'electron';
import http from 'node:http';
import { URL } from 'node:url';
import { loadRestreamCreds } from './credentials';
import type { Store } from './store';
// v0.1.69 (voice 4015) — structured error logging. Every previously-volatile
// console.error in this file now ALSO lands in app-errors.jsonl so we can
// reconstruct OAuth failures from disk without DevTools open. Voice 4015:
// "It should have all the information needed to debug and diagnose every
// type of error." The console.error calls are KEPT alongside the structured
// rows so dev-mode tail-follow still works during local debugging.
import { appendErrorLog, errorToString } from './structured-log';

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
 * against this timeout. If the timeout fires we surface a signed-out state
 * temporarily so the user sees the UI, but we do NOT wipe the encrypted
 * blob — the next launch will retry. Only an actual decrypt throw means
 * real ACL drift.
 *
 * v0.1.52 raise from 2s → 30s: after a Sparkle in-place update, the first
 * decrypt on the new binary triggers a SecurityAgent prompt because the
 * Keychain ACL partition is tied to the previous binary's CDHash.
 * Even on the SAME Developer ID + bundle ID, the new binary's hash differs
 * so the partition_id check fails and the prompt appears. The user can
 * click "Always Allow" once and the prompt won't repeat for the same
 * binary, but a 2s timeout was wiping the token before the user could
 * react — exactly the "signed out every update" symptom.
 *
 * NOTE: Promise.race does NOT cancel the underlying sync `decryptString`
 * syscall — that's a Node/Electron limitation. What it DOES guarantee is
 * that the rest of the app (window paint, IPC handlers, network) keeps
 * running while the syscall is in flight, because we await on the race
 * result on a non-critical path. The first decrypt request happens AFTER
 * the window is visible, so even if the user gets a Keychain prompt they
 * see a UI behind it, not a hung dock icon.
 */
const SAFE_STORAGE_DECRYPT_TIMEOUT_MS = 30_000;

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
          // v0.1.69 (voice 4015): mirror deferred-decrypt throws into
          // app-errors.jsonl so post-mortem can spot Keychain crashes
          // that previously vanished into console-only stderr.
          console.error('[oauth] deferred decrypt threw', err);
          appendErrorLog({
            subsystem: 'oauth',
            phase: 'oauth.deferred-decrypt-threw',
            errorMessage: errorToString(err),
          });
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
        // v0.1.69 (voice 4015): persist the encrypt failure to disk so
        // we know when a user fell back to the plain-text path (which is
        // a security degradation worth flagging in post-mortem).
        appendErrorLog({
          subsystem: 'oauth',
          phase: 'oauth.safe-storage-encrypt-failed',
          errorMessage: errorToString(err),
          context: { fallbackToPlain: true },
        });
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

    // Distinguish "decrypt threw because user denied / ACL mismatch" from
    // "decrypt resolved to junk that we can't parse" — the first case
    // means the blob might still be valid on a subsequent launch (after
    // the user has clicked Always Allow); the second is a genuine
    // corrupt-data case where retrying would just fail the same way.
    // v0.1.52: only the genuinely-corrupt case triggers a wipe.
    type DecryptOutcome =
      | { kind: 'ok'; token: TokenSet }
      | { kind: 'threw' }
      | { kind: 'unparseable' };
    const decryptOnce = async (): Promise<DecryptOutcome> => {
      if (!this.encryptionAvailable()) return { kind: 'threw' };
      let json: string;
      try {
        const buf = Buffer.from(encBase64, 'base64');
        json = safeStorage.decryptString(buf);
      } catch (err) {
        console.error('[oauth] safeStorage.decryptString failed', err);
        // v0.1.69 (voice 4015): structured row for the Keychain-prompt-
        // denied / ACL-drift case. Critical signal — this is the most
        // common cause of "every update logs me out" symptom history.
        appendErrorLog({
          subsystem: 'oauth',
          phase: 'oauth.safe-storage-decrypt-failed',
          errorMessage: errorToString(err),
        });
        return { kind: 'threw' };
      }
      try {
        const parsed = JSON.parse(json) as TokenSet;
        if (!parsed || typeof parsed.accessToken !== 'string') {
          return { kind: 'unparseable' };
        }
        return { kind: 'ok', token: parsed };
      } catch (err) {
        console.error('[oauth] decrypted blob is not parseable JSON', err);
        // v0.1.69 (voice 4015): genuine ciphertext corruption — wipe + re-
        // auth is the recovery. Diagnostic row tells us if/when this is
        // happening in the wild (should be rare; previously invisible).
        appendErrorLog({
          subsystem: 'oauth',
          phase: 'oauth.decrypt-unparseable',
          errorMessage: errorToString(err),
        });
        return { kind: 'unparseable' };
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
        // v0.1.52: do NOT wipe on timeout. A timeout means the syscall is
        // STILL in flight (likely a SecurityAgent prompt the user hasn't
        // clicked yet). Wiping here was the cause of the "signed out
        // every update" bug — after a Sparkle update, the new binary's
        // ACL doesn't match the partition_id on the Keychain entry, so
        // the prompt fires; the user takes >2s to find and click "Always
        // Allow"; we wipe before they can react; the next time round
        // there's no tokenEnc to decrypt and they have to OAuth again.
        //
        // The right behaviour is to surface signed-out THIS launch (so
        // the UI doesn't hang) but preserve the blob — next launch the
        // ACL trust is in place from the first Allow click, decrypt
        // succeeds, and the user stays signed in.
        console.warn(
          `[oauth] safeStorage.decryptString timed out after ${SAFE_STORAGE_DECRYPT_TIMEOUT_MS}ms — surfacing signed-out for this launch (NOT wiping tokenEnc)`,
        );
        // v0.1.69 (voice 4015): timeout is operationally important — it
        // means the SecurityAgent prompt is still in flight and the user
        // hasn't clicked it yet. Persist so we can see if a user has a
        // chronically slow Keychain (e.g. heavy Time Machine I/O at boot).
        appendErrorLog({
          subsystem: 'oauth',
          phase: 'oauth.safe-storage-decrypt-timeout',
          errorMessage: `decrypt timed out after ${SAFE_STORAGE_DECRYPT_TIMEOUT_MS}ms`,
          context: { timeoutMs: SAFE_STORAGE_DECRYPT_TIMEOUT_MS },
        });
        this.decryptDisabled = true;
        return undefined;
      }
      if (result.kind === 'threw') {
        // v0.1.52: decrypt threw — user denied / ACL mismatch / Keychain
        // unavailable. PRESERVE the blob; the next launch may succeed
        // once the user clicks "Always Allow" or the underlying issue
        // clears. The user falls through to the sign-in screen for
        // THIS launch, but a successful OAuth re-auth will overwrite
        // the stale blob via persistToken. Wiping here is the second-
        // most-common cause of "signed out every update" — many
        // Sparkle in-place updates emit a one-shot SecurityAgent
        // "User canceled" error even when the user clicks Allow,
        // because the partition_id check fires before the prompt
        // resolves.
        console.warn(
          '[oauth] safeStorage.decryptString threw — surfacing signed-out for this launch (NOT wiping tokenEnc)',
        );
        this.decryptDisabled = true;
        return undefined;
      }
      if (result.kind === 'unparseable') {
        // Decrypt resolved but the plaintext isn't a valid TokenSet —
        // genuinely corrupt data, retrying would fail the same way.
        // Safe to wipe so the next OAuth attempt can start clean.
        console.warn(
          '[oauth] decrypted blob is unparseable — wiping tokenEnc',
        );
        this.handleAclDrift();
        return undefined;
      }
      this.cachedToken = result.token;
      return result.token;
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
      // v0.1.69 (voice 4015): store.delete failures are extremely rare
      // (electron-store wraps a synchronous JSON.write); when they DO
      // happen the user gets stuck with a permanently-broken tokenEnc.
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.wipe-token-enc-failed',
        errorMessage: errorToString(err),
      });
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

    // v0.1.65 — passkey support for Google sign-in (Ethan voice 3995, 2026-05-24).
    // v0.1.66 — Codex xhigh review fixes (Ethan voice 3995 follow-up).
    //
    // The Restream OAuth flow can redirect to accounts.google.com when Ethan
    // chooses "Sign in with Google", and Google's sign-in page wants to start
    // a WebAuthn ceremony so the user can authenticate with a macOS passkey.
    // Three things stop that ceremony from finishing in a vanilla Electron
    // BrowserWindow, and all three need a fix:
    //
    //   1. Until `app.configureWebAuthn({ touchID })` is called on macOS,
    //      Electron returns `false` from
    //      `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`,
    //      so Google's WebAuthn JS skips the platform-authenticator path
    //      entirely and the macOS passkey sheet never appears.
    //      Fixed in `src/main/main.ts` (`app.on('ready')` early-init).
    //   2. Google sniffs the User-Agent string and refuses to start the
    //      WebAuthn ceremony on any UA containing "Electron/<version>"
    //      (their allow-list of WebAuthn-capable browsers excludes embedded
    //      runtimes). Without the ceremony starting, the macOS passkey sheet
    //      is never invoked, so Ethan sees the Google page just hang.
    //      Fixed via `loadURL(url, { userAgent })` below.
    //   3. Even if Google DID try to start the ceremony, Electron's default
    //      permission handler silently denies the unknown
    //      `publickey-credentials-{get,create}` permissions, so the sheet
    //      would still never appear.
    //      Fixed via the scoped `setPermissionRequestHandler` below.
    //
    // IMPORTANT scope detail (v0.1.66, Codex review): the `persist:restream-oauth`
    // partition is REUSED by `src/main/chat-send.ts` for its hidden cookie
    // provisioner + interactive recovery windows. Electron returns the SAME
    // Session object for a given `persist:` partition string within a process,
    // so any handler we install here also fires for chat-send's BrowserWindows.
    //
    // We DON'T want chat-send's webContents to silently auto-approve passkey
    // requests (low-probability but real — Restream's chat page could redirect
    // through some embedded WebAuthn flow at any point). So the handler below
    // ALSO checks `webContents.id` and ONLY approves when the request is
    // coming from THIS specific OAuth window's webContents. Everything else
    // hits the `false` branch and gets denied like the default would.
    const oauthSession = session.fromPartition('persist:restream-oauth');

    // The BrowserWindow is created BEFORE the permission handler is wired so
    // we can capture `oauthWebContentsId` and use it inside the handler's
    // closure. Permission requests can't fire before `loadURL`, so wiring the
    // handler after window construction (but before loadURL) is safe.
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'Restream Chat++ — Sign in',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: oauthSession,
      },
    });

    // Scope guard — capture this window's webContents id at handler install
    // time so the closure can reject requests from any other webContents that
    // happens to share the `persist:restream-oauth` Session.
    const oauthWebContentsId = win.webContents.id;

    // Allow-list passkey permissions for THIS specific webContents only.
    // Default-deny everything else (matches Electron's default behaviour for
    // unknown permissions). `get` = existing-passkey sign-in, `create` =
    // first-time passkey registration. Google may try either depending on
    // whether Ethan has an existing passkey for his account.
    //
    // Note: `setPermissionRequestHandler` is a single-slot, last-writer-wins
    // hook on the Session. Re-installing on every `authenticate()` call is
    // intentional — captures the current OAuth window's id. We DON'T clear
    // it on window close (no `null` reset) because doing so would race the
    // next authenticate() call; a stale id just means "deny everything",
    // which is the same as the default.
    oauthSession.setPermissionRequestHandler((wc, permission, callback) => {
      const allowed = ['publickey-credentials-get', 'publickey-credentials-create'];
      const isOauthWindow = wc.id === oauthWebContentsId;
      callback(isOauthWindow && allowed.includes(permission));
    });

    // Strip the `Electron/<ver>` token from the UA so Google's WebAuthn
    // allow-list accepts us as a normal Chromium browser. The default
    // Electron 42 UA on this app is:
    //   Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
    //   (KHTML, like Gecko) Chrome/148.0.7778.97 Electron/42.1.0 Safari/537.36
    // — there's no `restream-chat-plus-plus/<ver>` product token (Codex
    // review confirmed via runtime probe), but we keep the alternation in
    // the regex as defence-in-depth in case a future Electron version or
    // a `setAppUserAgent()` call elsewhere adds one.
    //
    // We pass the clean UA via `loadURL`'s `userAgent` option so it's
    // scoped to THIS load only and doesn't bleed back into any cached
    // setUserAgent state on the shared Session. The leading `\s?` swallows
    // the separator space so we don't leave double spaces in the UA.
    const cleanUa = win.webContents
      .getUserAgent()
      .replace(/\s?(Electron|restream-chat-plus-plus)\/\S+/g, '');

    win.loadURL(authUrl.toString(), { userAgent: cleanUa });

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
   * In-flight refresh promise. Coalesces concurrent callers (boot-resume,
   * WS reconnect, IPC reconnect button) onto a single Restream token
   * round-trip so we never burn a one-time refresh token by trying it
   * in parallel. v0.1.52.
   */
  private refreshPromise?: Promise<TokenSet | undefined>;

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
   *
   * v0.1.52: two production fixes for Ethan voice 3720 (stuck on Idle;
   * `reconnect-events.jsonl` shows 11+ consecutive `refresh-failed`):
   *
   * 1. **Coalesce concurrent refreshes.** Pre-v0.1.52 the WS reconnect
   *    loop + the manual Reconnect button + the renderer mount could all
   *    fire `refresh()` in parallel. Restream rotates refresh tokens
   *    (every successful refresh returns a NEW `refresh_token` that
   *    invalidates the previous one) so two concurrent refreshes race:
   *    the "winner" gets the new pair, the loser tries to refresh with
   *    a now-invalidated token and gets `invalid_grant`. Coalesce via
   *    `refreshPromise`.
   *
   * 2. **Detect 4xx → force logout.** A 4xx refresh response (most
   *    commonly `invalid_grant`) means the persisted refresh token is
   *    permanently dead — keep retrying it forever and the user sits on
   *    "Idle" with no recovery (exactly the v0.1.51 bug). Wipe state via
   *    `logout()` so the next `AUTH_STATUS` push surfaces
   *    `authenticated: false` and the renderer flips to the sign-in
   *    screen. Anything 5xx is treated as transient.
   */
  async refresh(): Promise<TokenSet | undefined> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshInner().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async refreshInner(): Promise<TokenSet | undefined> {
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
      if (!res.ok) {
        // v0.1.52: a 4xx means the refresh token is permanently dead
        // (most commonly `invalid_grant` after a concurrent refresh
        // already rotated the pair, OR the user revoked the token in
        // Restream's settings, OR > 30 days idle). Wipe state so the
        // user sees the sign-in screen instead of looping on "Idle".
        // 5xx is transient — leave the token in place so the next
        // attempt can succeed.
        if (res.status >= 400 && res.status < 500) {
          let errCode: string | undefined;
          try {
            const errJson: any = await res.json();
            errCode = errJson?.error ?? undefined;
          } catch {
            // body wasn't JSON; still treat the 4xx as fatal
          }
          console.warn(
            `[oauth] refresh failed with ${res.status} (${
              errCode ?? 'no error code'
            }) — wiping persisted tokens, user must re-auth`,
          );
          // v0.1.69 (voice 4015): the fatal-refresh row is the single most
          // important OAuth diagnostic — it explains why a previously-
          // signed-in user is suddenly looking at the sign-in screen.
          // Captures both the HTTP status and Restream's error code so
          // post-mortem can distinguish invalid_grant (rotated token raced)
          // from access_denied (user revoked).
          appendErrorLog({
            subsystem: 'oauth',
            phase: 'oauth.refresh-fatal',
            errorMessage: `refresh-fatal status=${res.status} code=${errCode ?? 'unknown'}`,
            httpStatus: res.status,
            context: { errorCode: errCode ?? null, wipedTokens: true },
          });
          await this.logout();
        } else {
          console.warn(
            `[oauth] refresh returned ${res.status} — transient, leaving tokens in place`,
          );
          // v0.1.69 (voice 4015): 5xx is transient — but they still
          // matter (we keep the tokens, so the renderer stays "signed in"
          // but reconnect loops fail silently). Surfacing the row makes
          // these visible without the user noticing anything's wrong.
          appendErrorLog({
            subsystem: 'oauth',
            phase: 'oauth.refresh-transient',
            errorMessage: `refresh-transient status=${res.status}`,
            httpStatus: res.status,
          });
        }
        return undefined;
      }
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
    } catch (err) {
      // v0.1.69 (voice 4015): network / fetch-threw path was silently
      // returning undefined pre-v0.1.69 — refresh fires from multiple
      // call sites (WS reconnect loop, manual button, startup resume)
      // and a flaky network would just look like "auth failed" with
      // no signal on disk. Now every throw lands as a row so we can
      // see "5 refresh fetches in a row threw" → ISP issue.
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.refresh-fetch-threw',
        errorMessage: errorToString(err),
      });
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
      // v0.1.69 (voice 4015): structured row for failed code→token swap.
      // Pre-v0.1.69 this just threw into the IPC handler; the renderer
      // surfaced a generic error toast. Now post-mortem can see status +
      // first chunk of Restream's response body to spot misconfigured
      // client_id / expired auth code / Restream API outage.
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.exchange-code-failed',
        errorMessage: `exchange-code-failed status=${res.status}`,
        httpStatus: res.status,
        context: { bodyExcerpt: text?.slice(0, 240) },
      });
      throw new Error(`Token exchange failed: ${res.status} ${text}`);
    }
    const json: any = await res.json();
    if (!json.access_token) {
      // v0.1.69 (voice 4015): Restream returned 2xx but no access_token —
      // shape regression on their side. Critical signal because the IPC
      // handler will throw with the full JSON, but on disk we want a
      // concise row for grep.
      appendErrorLog({
        subsystem: 'oauth',
        phase: 'oauth.exchange-code-no-access-token',
        errorMessage: 'exchange returned 2xx without access_token',
        httpStatus: res.status,
        context: { responseKeys: Object.keys(json ?? {}) },
      });
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
