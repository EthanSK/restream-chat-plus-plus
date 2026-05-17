import { randomUUID } from 'node:crypto';
import type { ChatConnection, SendTextResult } from '../shared/types';

// `electron` is resolved lazily so this module can be unit-tested under a
// plain Node vitest environment. The runtime types are aliased to `any` to
// avoid pulling Electron's full type surface into the test build.
type Cookie = { name: string; value: string };
type Session = { cookies: { get: (filter: any) => Promise<Cookie[]> } };
type BrowserWindow = any;

function getElectron(): {
  BrowserWindow: any;
  session: { fromPartition: (p: string) => Session };
} | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    if (electron && electron.session && electron.BrowserWindow) return electron;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Inline chat send for v0.1.14 — POSTs a reply to Restream's internal
 * `POST /api/v2/client/reply` endpoint using the chat-session cookies
 * provisioned in the `persist:restream-oauth` Electron partition (the
 * same partition that hosts the Compose window).
 *
 * Reverse-engineering notes (lifted from the v0.1.12 chat-frontend
 * bundle and the v0.1.13 compose-requests.jsonl capture):
 *
 *   URL:     https://backend.chat.restream.io/api/v2/client/reply
 *   Method:  POST
 *   Headers:
 *     content-type:   application/json
 *     x-axsrf-token:  <value of cookie `accessXsrfToken` on .restream.io>
 *     origin:         https://chat.restream.io
 *     referer:        https://chat.restream.io/
 *     accept:         application/json, text/plain, * / *
 *     cookie:         <serialized .restream.io session cookies>
 *   Body (JSON):
 *     { connectionIdentifiers: string[], clientReplyUuid: string,
 *       text: string, showId: string }
 *
 *   v0.1.17 fix: previously we omitted `showId` and the endpoint returned
 *   404 ("send failed (HTTP 404)"). The Restream backend uses showId to
 *   resolve the active show whose connections the reply should fan out to
 *   — without it there is no show context and the request 404s. The
 *   `ws-client` sniffs the showId from every incoming `event` /
 *   `reply_created` frame and exposes it via `chat.getShowId()`; the IPC
 *   handler in `main.ts` threads that into `sendChatText`.
 *
 * The successful send is echoed back via the WebSocket as a `reply_created`
 * frame — our `normalize.ts` already surfaces those as `self: true`
 * ChatMessages, so the renderer does NOT optimistically render anything.
 *
 * Cold-start path: when the partition has no chat-session cookies yet,
 * we spawn an invisible Compose window (`show: false`) pointing at
 * `https://chat.restream.io` and wait up to 8 seconds for cookies to
 * appear. Once they do, we close the helper window and retry the send.
 * If the cold-start probe times out (e.g. user isn't logged into chat
 * yet) we surface `no-session-cookies` so the renderer can prompt the
 * user to click Compose manually.
 */

const PARTITION = 'persist:restream-oauth';
const RESTREAM_DOMAIN = '.restream.io';
const SEND_URL = 'https://backend.chat.restream.io/api/v2/client/reply';
const COLD_START_TIMEOUT_MS = 8000;
const COLD_START_POLL_MS = 250;

/**
 * Get the Electron session for the persistent OAuth partition. Returns
 * undefined when called outside an Electron main-process context (e.g.
 * a node-environment unit test); tests should pass `getSession` directly.
 */
function getRestreamSession(): Session {
  const electron = getElectron();
  if (!electron) {
    throw new Error('chat-send: electron module unavailable; provide getSession in tests');
  }
  return electron.session.fromPartition(PARTITION);
}

/**
 * Read all .restream.io cookies and return:
 *   - `cookieHeader`: a header-ready `name1=value1; name2=value2; ...` string
 *   - `xsrf`: the value of the `accessXsrfToken` cookie (used as
 *     `x-axsrf-token` request header), or undefined if missing
 *
 * Returns undefined for the whole record when there are no cookies at all
 * (cold-start signal).
 */
async function readRestreamCookies(
  sess: Session,
): Promise<{ cookieHeader: string; xsrf?: string; raw: Cookie[] } | undefined> {
  let cookies: Cookie[];
  try {
    cookies = await sess.cookies.get({ domain: RESTREAM_DOMAIN });
  } catch (err) {
    console.error('[chat-send] cookie read failed', err);
    return undefined;
  }
  if (!cookies || cookies.length === 0) return undefined;
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const xsrf = cookies.find((c) => c.name === 'accessXsrfToken')?.value;
  return { cookieHeader, xsrf, raw: cookies };
}

/**
 * Spawn an invisible Compose window pointed at https://chat.restream.io
 * so Restream's webchat boots in the partition and writes its chat-session
 * cookies (`accessXsrfToken`, session, etc) to the `.restream.io` jar.
 *
 * Resolves with the freshly-read cookie record when both the cookie jar
 * is non-empty AND the `accessXsrfToken` is present, OR resolves with
 * `undefined` after the timeout.
 *
 * The helper window is destroyed before this function returns regardless
 * of outcome.
 */
async function provisionCookiesHeadless(
  sess: Session,
  parent: BrowserWindow | null,
): Promise<{ cookieHeader: string; xsrf?: string; raw: Cookie[] } | undefined> {
  const electron = getElectron();
  if (!electron) return undefined;
  const win = new electron.BrowserWindow({
    show: false,
    width: 380,
    height: 320,
    parent: parent ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      session: sess,
    },
  });
  try {
    // Don't await the load — Restream's chat page may sit on a long-lived
    // websocket / refresh loop; cookies are written before that finishes.
    void win.loadURL('https://chat.restream.io');
    const deadline = Date.now() + COLD_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, COLD_START_POLL_MS));
      const next = await readRestreamCookies(sess);
      if (next && next.xsrf) return next;
    }
    // One last read — partition may have non-xsrf cookies that are still
    // usable for the request (we'll surface no-session-cookies if not).
    return await readRestreamCookies(sess);
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * Active connection identifiers — Restream's reply endpoint requires the
 * full list of connection identifiers the reply should fan out to. We
 * default to every CURRENTLY-CONNECTED connection (matching what the
 * official Compose window does when the user doesn't pick a specific
 * platform). If none are connected we still try every known connection
 * — better than silently dropping.
 */
function selectConnectionIdentifiers(connections: ChatConnection[]): string[] {
  const connected = connections.filter((c) => c.status === 'connected');
  const source = connected.length > 0 ? connected : connections;
  return source.map((c) => c.connectionIdentifier).filter((s) => !!s);
}

/**
 * Build the headers used for the POST. Mirrors what Restream's own
 * chat.restream.io webapp sends (the Origin/Referer matters — Restream's
 * backend rejects cross-origin POSTs without them).
 */
function buildHeaders(cookieHeader: string, xsrf: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    origin: 'https://chat.restream.io',
    referer: 'https://chat.restream.io/',
    'x-axsrf-token': xsrf,
    cookie: cookieHeader,
    // User-Agent mirrors a desktop Chrome string — main process `fetch`
    // would otherwise send a Node-ish UA which some Restream edges reject.
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };
}

export interface ChatSendOptions {
  text: string;
  connections: ChatConnection[];
  /**
   * The current Restream `showId` — included in the POST body when known.
   *
   * The WS client sniffs it from any incoming `event` / `reply_created`
   * frame (those carry `payload.showId`). Heartbeat + `connection_info` +
   * `connection_closed` frames do NOT, so a freshly-connected session
   * with no chat activity has `showId === undefined`.
   *
   * v0.1.20 fix: previously this was a hard gate — undefined → instant
   * `no-show-id` reject so the user could never send before the first
   * event flowed. Now we try the POST anyway; Restream's backend can
   * sometimes resolve the show implicitly. Only after a 404 do we
   * surface `no-show-id` with a clearer error message.
   */
  showId?: string;
  parentWindow: BrowserWindow | null;
  /**
   * Optional async hook called when `showId` is undefined, BEFORE the POST.
   * Lets the main process try to hydrate the showId from the public REST
   * API (`/v2/user/events/in-progress`). Returns a string to use as the
   * showId for this send, or undefined to proceed without one. Called at
   * most once per send. Injected by main.ts; unit tests pass a stub.
   */
  fetchShowId?: () => Promise<string | undefined>;
  /** Injected for unit tests. */
  fetchImpl?: typeof fetch;
  /** Injected for unit tests. */
  getSession?: () => Session;
  /** Injected for unit tests — skip the cold-start helper-window probe. */
  skipColdStart?: boolean;
  /** Injected for unit tests. */
  uuid?: () => string;
}

/**
 * Send a chat reply via Restream's internal endpoint. Pure with respect
 * to the WebSocket client — the reply will come back as a `reply_created`
 * frame which the existing normaliser surfaces as a self message.
 */
export async function sendChatText(opts: ChatSendOptions): Promise<SendTextResult> {
  const text = (opts.text ?? '').trim();
  if (!text) return { ok: false, reason: 'error', error: 'empty text' };

  const ids = selectConnectionIdentifiers(opts.connections);
  if (ids.length === 0) {
    return { ok: false, reason: 'no-active-connections' };
  }

  // v0.1.20: showId is no longer a hard gate. If the WS hasn't sniffed
  // one yet (just-connected, no event/reply frames received), give the
  // REST API a chance to hydrate it from `/v2/user/events/in-progress`,
  // then POST regardless. The backend may still 404 if there's no
  // active show — we translate that into a friendlier `no-show-id`
  // error AFTER the attempt rather than blocking pre-send.
  let resolvedShowId: string | undefined = opts.showId;
  if (!resolvedShowId && opts.fetchShowId) {
    try {
      resolvedShowId = await opts.fetchShowId();
    } catch {
      // Fall through — try-send-anyway is the fallback.
    }
  }

  const sess = (opts.getSession ?? getRestreamSession)();
  let cookies = await readRestreamCookies(sess);
  if (!cookies || !cookies.xsrf) {
    if (opts.skipColdStart) {
      return { ok: false, reason: 'no-session-cookies' };
    }
    cookies = await provisionCookiesHeadless(sess, opts.parentWindow);
    if (!cookies || !cookies.xsrf) {
      return { ok: false, reason: 'no-session-cookies' };
    }
  }

  // Only include showId in the body when we actually have one. Restream's
  // backend tolerates the field being absent (it then attempts to resolve
  // the show from session state); omitting it is preferable to sending
  // an explicit `null` or empty string, both of which can fail validation.
  const bodyObj: Record<string, unknown> = {
    connectionIdentifiers: ids,
    clientReplyUuid: (opts.uuid ?? randomUUID)(),
    text,
  };
  if (resolvedShowId) bodyObj.showId = resolvedShowId;
  const body = JSON.stringify(bodyObj);

  const headers = buildHeaders(cookies.cookieHeader, cookies.xsrf);

  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      // v0.1.20: if we 404'd specifically because we had no showId, give
      // the user a clearer message than "send failed (HTTP 404)" — this is
      // the documented Restream behaviour when the backend can't resolve
      // an active show for the user. The chat WS gate ("waiting for first
      // chat frame") is gone, replaced by an actionable error after the
      // actual attempt.
      if (res.status === 404 && !resolvedShowId) {
        return {
          ok: false,
          reason: 'no-show-id',
          status: 404,
          error: detail ? detail.slice(0, 240) : undefined,
        };
      }
      return {
        ok: false,
        reason: 'send-failed',
        status: res.status,
        error: detail ? detail.slice(0, 240) : undefined,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      error: String((err as Error)?.message ?? err),
    };
  }
}

// Re-exports for unit tests
export const __test_internals = {
  readRestreamCookies,
  selectConnectionIdentifiers,
  buildHeaders,
};
