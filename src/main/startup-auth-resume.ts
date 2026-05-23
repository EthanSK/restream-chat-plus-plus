import type { TokenSet } from './oauth';
import type {
  EnsureRestreamChatCookiesOptions,
  EnsureRestreamChatCookiesResult,
} from './chat-send';

type StartupWindow = EnsureRestreamChatCookiesOptions['parentWindow'];

export interface StartupAuthResumeDeps {
  oauth: {
    isAuthenticatedAsync: () => Promise<boolean>;
    getTokenAsync: () => Promise<TokenSet | undefined>;
    refresh: () => Promise<TokenSet | undefined>;
  };
  chat: {
    setToken: (accessToken: string) => void;
    start: () => void;
  };
  ensureRestreamChatCookies: (
    opts: EnsureRestreamChatCookiesOptions,
  ) => Promise<EnsureRestreamChatCookiesResult>;
  parentWindow: StartupWindow;
  pushAuthStatus: () => void;
  resolveStartupAuth: () => void;
  logWarn?: (message?: unknown, ...optionalParams: unknown[]) => void;
  logError?: (message?: unknown, ...optionalParams: unknown[]) => void;
}

/**
 * v0.1.63 startup-auth resume helper.
 *
 * This is intentionally separated from `main.ts` so the startup state machine
 * can be unit-tested without booting Electron's `app.on('ready')` entrypoint.
 * The production `resumeAuth()` closure still owns the real dependencies; this
 * helper only expresses the ordering contract:
 *
 *   1. Restore a still-valid token OR refresh an expired token.
 *   2. Feed that access token into the WebSocket client and start it.
 *   3. Repair the chat.restream.io cookie jar for REST sends.
 *   4. Always broadcast the final auth state and unblock startup listeners.
 *
 * The bug fixed here was that v0.1.62 only repaired cookies after a fresh
 * `AUTH_START` sign-in. Users coming through the in-app updater kept their
 * OAuth token, so startup resumed auth here instead; their chat-session
 * cookies stayed wiped and every outgoing send bailed at `no-session-cookies`.
 */
export async function resumeAuthWithCookieRepair(
  deps: StartupAuthResumeDeps,
): Promise<void> {
  const warn = deps.logWarn ?? console.warn;
  const error = deps.logError ?? console.error;

  try {
    // First leg: a still-valid stored token means the user is already signed
    // in from the renderer's perspective. This is exactly the in-app-update
    // path v0.1.62 missed, so cookie repair must run here after the WS starts.
    if (await deps.oauth.isAuthenticatedAsync()) {
      const token = await deps.oauth.getTokenAsync();
      if (token) {
        deps.chat.setToken(token.accessToken);
        deps.chat.start();
        await repairStartupChatCookies(deps, warn, error);
      }
    } else {
      // Second leg: the access token was expired or unavailable, but a stored
      // refresh token may still recover the session without showing OAuth UI.
      // A successful refresh lands in the same "already authed at startup"
      // state as the first leg, so it needs the same chat-cookie repair.
      const refreshed = await deps.oauth.refresh();
      if (refreshed) {
        deps.chat.setToken(refreshed.accessToken);
        deps.chat.start();
        await repairStartupChatCookies(deps, warn, error);
      }
    }
  } catch (err) {
    error('[main] startup auth resume failed', err);
  } finally {
    // This finally is the startup latch for the renderer. Even if token
    // decrypt, refresh, WebSocket start, or cookie repair fails, the renderer
    // must receive a final auth snapshot and the did-finish-load waiter must
    // be released so the UI cannot sit in a boot-time limbo.
    deps.pushAuthStatus();
    deps.resolveStartupAuth();
  }
}

async function repairStartupChatCookies(
  deps: StartupAuthResumeDeps,
  warn: NonNullable<StartupAuthResumeDeps['logWarn']>,
  error: NonNullable<StartupAuthResumeDeps['logError']>,
): Promise<void> {
  // v0.1.63 — startup-side cookie repair for already-authenticated users.
  //
  // Why this exists:
  //   - The v0.1.59 ad-hoc -> v0.1.61 Developer ID signing change altered
  //     Electron's persistence scope for `persist:restream-oauth`, wiping the
  //     chat-session cookies (`accessXsrfToken`, `refreshToken`,
  //     `refreshXsrfToken`) that `chat-send.ts` needs for REST POSTs.
  //   - v0.1.62 repaired those cookies only inside the `AUTH_START` handler.
  //     Fresh sign-ins were fixed, but updated users with a preserved OAuth
  //     token never hit `AUTH_START`; startup resumed them here instead.
  //   - `AUTH_START` still performs its own hydration because a fresh sign-in
  //     also needs chat.restream.io cookies before the first outgoing send.
  //
  // Why this is after `chat.start()`:
  //   - The WebSocket handshake uses the OAuth access token, not the
  //     chat.restream.io cookie jar. Only `POST /api/client/reply` needs the
  //     cookie suite and `accessXsrfToken`, so we can start receiving chat
  //     immediately and then repair the REST-send credential layer.
  //
  // Why failures are non-fatal:
  //   - A cookie repair failure should not make the app appear logged out or
  //     keep startup unresolved. The send path logs `no-session-cookies`, the
  //     queue emits `failed`, and the renderer-side stuck-send guard surfaces
  //     a visible message instead of leaving Ethan with a silent spinner.
  try {
    const cookieState = await deps.ensureRestreamChatCookies({
      parentWindow: deps.parentWindow,
      interactiveFallback: true,
    });
    if (!cookieState.ok) {
      warn(
        '[main] ensureRestreamChatCookies during startup resume: ok=false reason=' +
          cookieState.reason +
          ' cookieCount=' +
          cookieState.cookieCount,
      );
    }
  } catch (cookieErr) {
    error('[main] ensureRestreamChatCookies during startup resume threw', cookieErr);
  }
}
