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
  /**
   * v0.1.28: optional async hook called AFTER a 404 on the first POST. The
   * cached showId (whether from `opts.showId` or `fetchShowId`) is treated
   * as stale-but-present and invalidated; this hook is then called to force
   * a fresh hydration (bypassing any in-process cache and re-hitting the
   * REST API). The returned showId is used for a single retry POST. If the
   * retry also 404s, we surface `no-show-id` to the user with the "No
   * active show — start streaming" message.
   *
   * Implementation in main.ts:
   *   1. Clear `showIdRestCache` so the next REST hit isn't served stale.
   *   2. Invalidate the WS-sniffed showId via `chat.invalidateShowId()`.
   *   3. Re-hit `/v2/user/events/in-progress` and return the fresh value.
   *
   * Tests can pass a stub. When omitted, no retry is attempted (v0.1.20
   * behaviour preserved).
   */
  refreshShowId?: () => Promise<string | undefined>;
  /**
   * v0.1.28: optional callback fired with the full request/response record
   * for EVERY POST attempt (including retries). Main.ts wires this to a
   * dedicated `chat-send.jsonl` log file with redacted headers. Tests can
   * pass a spy. Errors thrown from the logger are swallowed.
   */
  log?: (record: ChatSendLogRecord) => void;
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
 * Record passed to the optional `log` callback. Captures the salient
 * shape of one `POST /client/reply` round-trip. Headers are redacted
 * before this record is built (cookies → length only, x-axsrf-token →
 * SHA-256 hash) so the record can be flushed to disk without leaking
 * auth material.
 */
export interface ChatSendLogRecord {
  /** `attempt:1` for the first send, `attempt:2` for the post-404 retry. */
  attempt: 1 | 2;
  url: string;
  method: 'POST';
  /** Header values with cookie/xsrf redacted by the producer. */
  headers: Record<string, string>;
  /** Parsed body object — the raw send payload (not stringified). */
  body: Record<string, unknown>;
  /** Set when the POST returned a response. */
  response?: {
    status: number;
    /** First 240 chars of the response body (best-effort). */
    bodyExcerpt?: string;
  };
  /** Set when fetch itself threw (network error, abort, etc). */
  error?: string;
  /**
   * Whether this attempt was preceded by an in-flight showId invalidate +
   * refresh. False for `attempt:1`, true for `attempt:2`.
   */
  showIdRefreshed: boolean;
}

/**
 * Build a SHA-256 hash (hex, first 12 chars) of `value` for log redaction.
 * The full token must never appear in `chat-send.jsonl` — we only need
 * "the xsrf token rotated" to be detectable across log lines.
 */
function redactToken(value: string | undefined): string {
  if (!value) return '<missing>';
  try {
    // crypto.createHash is available in node main process
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return `sha256:${createHash('sha256')
      .update(value)
      .digest('hex')
      .slice(0, 12)}…(${value.length})`;
  } catch {
    return `<len=${value.length}>`;
  }
}

/**
 * Build the redacted header record for a chat-send log line. Cookies are
 * reduced to a byte-length so log readers can confirm "cookies present" /
 * "cookies absent" without leaking session material. x-axsrf-token is
 * SHA-256 hashed so token-rotation events are still observable. Everything
 * else (origin, referer, content-type, accept, user-agent) is preserved
 * verbatim because it's non-sensitive.
 */
function buildLogHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'cookie' || lower === 'authorization') {
      safe[k] = `<redacted len=${v?.length ?? 0}>`;
    } else if (lower === 'x-axsrf-token' || lower === 'x-rxsrf-token') {
      safe[k] = redactToken(v);
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

/**
 * Issue one POST /client/reply attempt and return the parsed result + the
 * raw response status/body so the caller can decide whether to retry on a
 * 404. The `log` callback (if any) is invoked exactly once per attempt with
 * the redacted request + response shape.
 *
 * Separated from sendChatText so the retry-on-404 path can re-use it with
 * a freshly-resolved showId.
 */
async function performSend(args: {
  url: string;
  bodyObj: Record<string, unknown>;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  attempt: 1 | 2;
  showIdRefreshed: boolean;
  log?: (record: ChatSendLogRecord) => void;
}): Promise<{ res?: Response; bodyText?: string; thrown?: unknown }> {
  const { url, bodyObj, headers, fetchImpl, attempt, showIdRefreshed, log } = args;
  const body = JSON.stringify(bodyObj);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body });
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      // best-effort; some non-2xx responses may have empty bodies
    }
    if (log) {
      try {
        log({
          attempt,
          url,
          method: 'POST',
          headers: buildLogHeaders(headers),
          body: bodyObj,
          response: {
            status: res.status,
            bodyExcerpt: bodyText ? bodyText.slice(0, 240) : undefined,
          },
          showIdRefreshed,
        });
      } catch {
        // logging must never break the send path
      }
    }
    return { res, bodyText };
  } catch (err) {
    if (log) {
      try {
        log({
          attempt,
          url,
          method: 'POST',
          headers: buildLogHeaders(headers),
          body: bodyObj,
          error: String((err as Error)?.message ?? err),
          showIdRefreshed,
        });
      } catch {
        // ignore
      }
    }
    return { thrown: err };
  }
}

/**
 * Send a chat reply via Restream's internal endpoint. Pure with respect
 * to the WebSocket client — the reply will come back as a `reply_created`
 * frame which the existing normaliser surfaces as a self message.
 *
 * v0.1.28: on a 404 response we now treat the cached showId as STALE-but-
 * present, invalidate it via `refreshShowId`, and retry the POST once with
 * the fresh value. If the retry also 404s, return `no-show-id` with the
 * actionable "no active show" error.
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

  // Per-send UUID. Re-used for the retry POST so Restream's idempotency
  // (if any) treats them as the same logical reply — the user only ever
  // sees one outbound message regardless of attempt count.
  const clientReplyUuid = (opts.uuid ?? randomUUID)();

  // Only include showId in the body when we actually have one. Restream's
  // backend tolerates the field being absent (it then attempts to resolve
  // the show from session state); omitting it is preferable to sending
  // an explicit `null` or empty string, both of which can fail validation.
  const buildBody = (showId: string | undefined): Record<string, unknown> => {
    const obj: Record<string, unknown> = {
      connectionIdentifiers: ids,
      clientReplyUuid,
      text,
    };
    if (showId) obj.showId = showId;
    return obj;
  };

  const headers = buildHeaders(cookies.cookieHeader, cookies.xsrf);
  const fetchImpl = opts.fetchImpl ?? fetch;

  // ---- Attempt #1 -------------------------------------------------------
  const first = await performSend({
    url: SEND_URL,
    bodyObj: buildBody(resolvedShowId),
    headers,
    fetchImpl,
    attempt: 1,
    showIdRefreshed: false,
    log: opts.log,
  });
  if (first.thrown) {
    return {
      ok: false,
      reason: 'error',
      error: String((first.thrown as Error)?.message ?? first.thrown),
    };
  }
  const firstRes = first.res!;
  if (firstRes.ok) return { ok: true };

  // ---- Retry-on-404 with refreshed showId -------------------------------
  // v0.1.28: if the first attempt 404'd, treat the showId we used as
  // stale-but-present (Restream returns 404 both when there's NO show and
  // when the show has ended — same status code, same body shape). Force a
  // fresh REST hydration via opts.refreshShowId, then retry ONCE. If the
  // fresh value differs from what we just sent, this recovers cleanly. If
  // the fresh value is also missing or matches the stale one, the retry
  // will 404 again and we surface `no-show-id` with the actionable error.
  if (firstRes.status === 404 && opts.refreshShowId) {
    let refreshedShowId: string | undefined;
    try {
      refreshedShowId = await opts.refreshShowId();
    } catch {
      refreshedShowId = undefined;
    }
    const second = await performSend({
      url: SEND_URL,
      bodyObj: buildBody(refreshedShowId),
      headers,
      fetchImpl,
      attempt: 2,
      showIdRefreshed: true,
      log: opts.log,
    });
    if (second.thrown) {
      return {
        ok: false,
        reason: 'error',
        error: String((second.thrown as Error)?.message ?? second.thrown),
      };
    }
    const secondRes = second.res!;
    if (secondRes.ok) return { ok: true };
    // Retry failed too. If it's another 404, the user genuinely has no
    // active show — surface the actionable error. Anything else falls
    // through to send-failed using the SECOND response.
    if (secondRes.status === 404) {
      return {
        ok: false,
        reason: 'no-show-id',
        status: 404,
        error:
          'No active show — start streaming on Restream and try again.',
      };
    }
    return {
      ok: false,
      reason: 'send-failed',
      status: secondRes.status,
      error: second.bodyText ? second.bodyText.slice(0, 240) : undefined,
    };
  }

  // ---- No retry available (or non-404 first response) -------------------
  // v0.1.20 compatibility: a 404 with no showId AND no refresh hook still
  // surfaces as `no-show-id` so the v0.1.20 contract isn't regressed.
  if (firstRes.status === 404 && !resolvedShowId) {
    return {
      ok: false,
      reason: 'no-show-id',
      status: 404,
      error: first.bodyText ? first.bodyText.slice(0, 240) : undefined,
    };
  }
  return {
    ok: false,
    reason: 'send-failed',
    status: firstRes.status,
    error: first.bodyText ? first.bodyText.slice(0, 240) : undefined,
  };
}

// Re-exports for unit tests
export const __test_internals = {
  readRestreamCookies,
  selectConnectionIdentifiers,
  buildHeaders,
};
