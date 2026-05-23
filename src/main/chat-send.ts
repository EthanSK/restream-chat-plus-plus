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
 * Inline chat send — POSTs a reply to Restream's internal `/client/reply`
 * endpoint using the chat-session cookies provisioned in the
 * `persist:restream-oauth` Electron partition.
 *
 * v0.1.34 — endpoint + body-shape rewrite. The previous reverse-engineering
 * (v0.1.12 → v0.1.33) had two errors that compounded into the
 * "no active Restream show" send failure Ethan saw while actively streaming:
 *
 *   1. WRONG ENDPOINT. We were POSTing to `/api/v2/client/reply` — that
 *      route does not exist on Restream's backend. A live probe returns
 *      "404 page not found" (plain text) regardless of body. The correct
 *      path the live `chat.restream.io` webchat uses TODAY is
 *      `/api/client/reply` (no `/v2/` prefix). Confirmed by inspecting
 *      https://chat.restream.io/static/js/main.5700cb99.js and probing
 *      both routes directly (v1 returns 401 unauthorized — i.e. route
 *      exists, just needs auth — while v2 returns 404 plain text).
 *
 *   2. NARROW BODY SHAPE. The live webchat sends ONE of three identifiers
 *      depending on the chat context, in priority order:
 *        showId  > eventId  > instant
 *      The webchat reads them from URL query params (`?show-id=`,
 *      `?event-id=`, `?instant=true`) on the chat embed. Restream's own
 *      bundle priority order (lifted verbatim from main.5700cb99.js):
 *        postClientReplyMessage({connectionIdentifiers, clientReplyUuid,
 *                                text, showId, eventId, instant}) =>
 *          showId  ? {...base, showId}  :
 *          eventId ? {...base, eventId} :
 *          instant ? {...base, instant} :
 *          base
 *      RC++ only ever sent `showId` (with the wrong VALUE — see (3)). When
 *      the user has an instant stream (RTMP/instant), the chat needs
 *      `eventId: <event-id>` OR `instant: true` — the showId branch never
 *      matches.
 *
 *   3. WRONG IDENTIFIER NAME. The `/v2/user/events/in-progress` REST
 *      endpoint returns objects whose `id` is the **event ID**, per
 *      Restream's public docs. v0.1.20-v0.1.33 fed that id into the body
 *      as `showId`. Even on the (hypothetical) correct endpoint that
 *      would still fail validation because the chat backend would expect
 *      a real showId, not an event id.
 *
 *   URL:     https://backend.chat.restream.io/api/client/reply
 *   Method:  POST
 *   Headers:
 *     content-type:   application/json
 *     x-axsrf-token:  <value of cookie `accessXsrfToken` on .restream.io>
 *     origin:         https://chat.restream.io
 *     referer:        https://chat.restream.io/
 *     accept:         application/json, text/plain, * / *
 *     cookie:         <serialized .restream.io session cookies>
 *   Body (JSON):
 *     base = { connectionIdentifiers: string[], clientReplyUuid: string,
 *              text: string }
 *     // exactly one of these, in priority order showId > eventId > instant:
 *     + { showId: string }   OR
 *     + { eventId: string }  OR
 *     + { instant: true }    OR
 *     + (none — backend may still accept and resolve from session)
 *
 * The successful send is echoed back via the WebSocket as a `reply_created`
 * frame — our `normalize.ts` already surfaces those as `self: true`
 * ChatMessages, so the renderer does NOT optimistically render anything.
 *
 * Cold-start path: when the partition has no chat-session cookies yet,
 * we spawn an invisible helper window pointing at `https://chat.restream.io`
 * and wait up to 8 seconds for cookies to appear. The helper window is
 * destroyed before the function returns.
 */

const PARTITION = 'persist:restream-oauth';
const RESTREAM_DOMAIN = '.restream.io';
export const CHAT_PARTITION = PARTITION;
export const CHAT_COOKIE_DOMAIN = RESTREAM_DOMAIN;
/**
 * v0.1.34: corrected from `/api/v2/client/reply` (404 ghost route) to
 * `/api/client/reply` (the real path on Restream's chat backend, matching
 * what the live chat.restream.io webchat bundle posts to). Keep in sync
 * with `src/__tests__/chat-send.test.ts` if you change this.
 */
const SEND_URL = 'https://backend.chat.restream.io/api/client/reply';
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
 * Spawn a VISIBLE Compose-style window pointed at https://chat.restream.io
 * so the user can complete the chat-session cookie handshake interactively
 * when the hidden provisioner failed to harvest an `accessXsrfToken`.
 *
 * v0.1.62 recovery path for the "v0.1.59 ad-hoc → v0.1.61 signed Developer ID"
 * transition: signing the rebuild flipped the Electron bundle ID's identity,
 * which wiped the `persist:restream-oauth` partition's chat-session cookies
 * (the OAuth token was repaired by sign-in, but the chat partition's
 * accessXsrfToken / refreshToken / refreshXsrfToken were not re-issued).
 * From that point on every send returned `no-session-cookies` and nothing
 * landed in chat-send.jsonl because the cookie check fires BEFORE the
 * `performSend()` log-emitter.
 *
 * The window auto-closes once the cookie jar contains an `accessXsrfToken`,
 * OR after `timeoutMs`, OR when the user closes it.
 *
 * Implementation notes:
 *   - Title + size chosen so a user who minimised the main window still
 *     notices the prompt (380×640 is taller than the headless provisioner
 *     because the user actually needs to interact with the page).
 *   - Polled rather than cookie-event-subscribed because Electron's
 *     `session.cookies.on('changed')` only fires on writes from inside an
 *     Electron BrowserWindow context — the rest of the chat-cookie suite
 *     can be written by an XHR redirect chain too.
 *   - Always destroys the window in `finally`; otherwise a Restream
 *     server-side redirect loop could leave it open if Ethan dismissed
 *     the parent app.
 */
async function provisionCookiesInteractive(
  sess: Session,
  parent: BrowserWindow | null,
  timeoutMs: number,
): Promise<{ cookieHeader: string; xsrf?: string; raw: Cookie[] } | undefined> {
  const electron = getElectron();
  if (!electron) return undefined;
  const win = new electron.BrowserWindow({
    show: true,
    width: 460,
    height: 640,
    parent: parent ?? undefined,
    title: 'Restream Chat++ — finish sign-in',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      session: sess,
    },
  });
  // Surface a quick description in the dock so a user with multiple
  // Restream windows can tell this one apart from the OAuth window.
  let userClosed = false;
  try {
    win.on('closed', () => {
      userClosed = true;
    });
  } catch {
    // ignore
  }
  try {
    void win.loadURL('https://chat.restream.io');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !userClosed) {
      await new Promise((r) => setTimeout(r, COLD_START_POLL_MS));
      const next = await readRestreamCookies(sess);
      if (next && next.xsrf) return next;
    }
    return await readRestreamCookies(sess);
  } finally {
    try {
      if (!userClosed && !win.isDestroyed()) win.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * v0.1.62 — ensure the `persist:restream-oauth` Electron partition has a
 * complete chat-session cookie handshake (specifically `accessXsrfToken`,
 * which is the only chat cookie we read at send time — `refreshToken` /
 * `refreshXsrfToken` are written alongside it by Restream's chat backend).
 *
 * Codex xhigh diagnosis (verbatim, 2026-05-23): the v0.1.59 ad-hoc → v0.1.61
 * signed Developer ID transition split the app's auth state. OAuth token
 * was repaired by the post-install sign-in (because the OAuth flow runs
 * through a BrowserWindow with that partition and the token is persisted
 * via `safeStorage`). The chat partition's session cookies — written by
 * the chat.restream.io webchat itself — were wiped (codesigning a
 * different identity flipped the partition's identity scope), and the
 * fresh OAuth callback only wrote analytics cookies. Result: every send
 * returned `no-session-cookies` at `chat-send.ts:529` and no log row was
 * emitted (the JSONL writer lives inside `performSend()` at `:422`).
 *
 * Strategy:
 *   1. Read the partition's `.restream.io` cookies. If an `accessXsrfToken`
 *      is already present, we're done — no UI surfaced.
 *   2. Otherwise run the existing headless provisioner (hidden BrowserWindow
 *      → chat.restream.io). Most users hit this path on first sign-in or
 *      after a session-cookie expiry.
 *   3. If headless still didn't harvest an XSRF cookie AND
 *      `interactiveFallback: true`, surface a visible window so the user
 *      can complete the cookie handshake (e.g. re-accept a third-party
 *      cookie permission prompt, dismiss a chat sidebar, etc).
 *   4. Return the final state. Callers should treat `{ ok: false,
 *      reason: ... }` as a "tell the user to sign in / restart" cue.
 */
export interface EnsureRestreamChatCookiesOptions {
  /** Parent BrowserWindow for hidden / interactive helpers. Optional in tests. */
  parentWindow?: BrowserWindow | null;
  /**
   * When `true`, surface a visible chat.restream.io window if the hidden
   * provisioner can't harvest an XSRF cookie. When `false` (the default),
   * give up after the hidden attempt and report `still-no-cookies`.
   */
  interactiveFallback?: boolean;
  /**
   * Total budget (ms) for the interactive fallback window to wait for an
   * XSRF cookie before destroying itself. Default 60_000 (60s) — long
   * enough for a user to click through a single Restream sign-in
   * affordance but short enough that a forgotten window doesn't sit open
   * forever.
   */
  interactiveTimeoutMs?: number;
  /** Injected for unit tests. */
  getSession?: () => Session;
}

export interface EnsureRestreamChatCookiesResult {
  /** True iff the partition has `accessXsrfToken` after this call. */
  ok: boolean;
  /**
   * Why ensuring failed (or `'already-present'` / `'headless'` /
   * `'interactive'` on success).
   *   - `already-present`: partition already had the XSRF cookie.
   *   - `headless`: hidden provisioner harvested it.
   *   - `interactive`: visible window harvested it.
   *   - `still-no-cookies`: neither path harvested it; callers should
   *     surface this to the user.
   *   - `no-electron`: called outside an Electron main-process context.
   */
  reason:
    | 'already-present'
    | 'headless'
    | 'interactive'
    | 'still-no-cookies'
    | 'no-electron';
  cookieCount: number;
  hasXsrf: boolean;
}

export async function ensureRestreamChatCookies(
  opts: EnsureRestreamChatCookiesOptions = {},
): Promise<EnsureRestreamChatCookiesResult> {
  let sess: Session;
  try {
    sess = (opts.getSession ?? getRestreamSession)();
  } catch {
    return {
      ok: false,
      reason: 'no-electron',
      cookieCount: 0,
      hasXsrf: false,
    };
  }

  const initial = await readRestreamCookies(sess);
  if (initial && initial.xsrf) {
    return {
      ok: true,
      reason: 'already-present',
      cookieCount: initial.raw.length,
      hasXsrf: true,
    };
  }

  // Stage 2: hidden provisioner (same as the cold-start path inside
  // sendChatText).
  const headless = await provisionCookiesHeadless(
    sess,
    opts.parentWindow ?? null,
  );
  if (headless && headless.xsrf) {
    return {
      ok: true,
      reason: 'headless',
      cookieCount: headless.raw.length,
      hasXsrf: true,
    };
  }

  // Stage 3: interactive fallback (caller-opt-in).
  if (opts.interactiveFallback) {
    const interactive = await provisionCookiesInteractive(
      sess,
      opts.parentWindow ?? null,
      opts.interactiveTimeoutMs ?? 60_000,
    );
    if (interactive && interactive.xsrf) {
      return {
        ok: true,
        reason: 'interactive',
        cookieCount: interactive.raw.length,
        hasXsrf: true,
      };
    }
  }

  // Final read so the result reflects whatever IS present (analytics
  // cookies, etc.) for diagnostics.
  const final = await readRestreamCookies(sess);
  return {
    ok: false,
    reason: 'still-no-cookies',
    cookieCount: final?.raw.length ?? 0,
    hasXsrf: false,
  };
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

/**
 * The triple-tagged union Restream's chat backend accepts as the
 * authoritative "which show / event / instant stream is this reply
 * for" identifier. Exactly ONE field is sent in the POST body in the
 * priority order showId > eventId > instant (matching the live
 * chat.restream.io webchat). All three may be undefined — in which
 * case the body omits the identifier entirely and lets Restream try to
 * resolve from session state.
 *
 * v0.1.34: replaced the showId-only contract from v0.1.20-v0.1.33. The
 * /v2/user/events/in-progress REST endpoint returns objects whose `id`
 * is the EVENT id, not a showId — so the old code was sending an event
 * id under the `showId` key, which Restream's validator rejects.
 */
export interface ChatContext {
  /** Scheduled-event "show" identifier. Rarely populated for RC++ users today. */
  showId?: string;
  /** Event identifier — what `/v2/user/events/in-progress[0].id` actually is. */
  eventId?: string;
  /** True when the current stream is an instant (RTMP/instant) stream. */
  instant?: boolean;
}

export interface ChatSendOptions {
  text: string;
  connections: ChatConnection[];
  /**
   * v0.1.34: the full chat context — exactly one of `showId`, `eventId`,
   * `instant` is appended to the POST body in priority order. Any field
   * may be undefined; if ALL are absent the POST is still attempted (the
   * body omits the identifier entirely) and Restream may resolve from
   * session state. Previously this was a single `showId?: string` field
   * that conflated event-ids and show-ids.
   *
   * The WS client sniffs `eventId` from incoming frames; for now `showId`
   * and `instant` come only from the REST hydration path
   * (`/v2/user/events/in-progress` → `{id, status, ...}` — the `id` is
   * an event id, and `status==="in-progress"` with no scheduling info
   * implies an instant stream).
   */
  context?: ChatContext;
  parentWindow: BrowserWindow | null;
  /**
   * Optional async hook called when `context` is missing all three fields,
   * BEFORE the POST. Lets the main process try to hydrate the context from
   * the public REST API (`/v2/user/events/in-progress`). Returns a context
   * object to merge for this send, or undefined to proceed with the empty
   * context. Called at most once per send. Injected by main.ts; unit tests
   * pass a stub.
   *
   * v0.1.34: renamed from `fetchShowId` and now returns the full
   * ChatContext union (eventId / showId / instant) instead of a bare string.
   */
  fetchContext?: () => Promise<ChatContext | undefined>;
  /**
   * Optional async hook called AFTER a 404 on the first POST whose body
   * already included a context. The cached context is treated as
   * stale-but-present and invalidated; this hook is then called to force a
   * fresh hydration (bypassing any in-process cache and re-hitting the REST
   * API). The returned context is used for a single retry POST. If the
   * retry also 404s, we surface `no-show-id` to the user with the "No
   * active show" message.
   *
   * Implementation in main.ts:
   *   1. Clear `chatContextRestCache` so the next REST hit isn't served stale.
   *   2. Invalidate the WS-sniffed eventId via `chat.invalidateChatContext()`.
   *   3. Re-hit `/v2/user/events/in-progress` and return the fresh context.
   *
   * Tests can pass a stub. When omitted, no retry is attempted.
   *
   * v0.1.34: renamed from `refreshShowId`.
   */
  refreshContext?: () => Promise<ChatContext | undefined>;
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
 *
 * v0.1.62: extended to a discriminated union — `phase:"send"` records
 * (the original shape) document POST round-trips, and `phase:"preflight"`
 * records document failures BEFORE `performSend()` runs (e.g. cookie
 * jar missing the `accessXsrfToken` after sign-in). Without preflight
 * rows the v0.1.61 "send broken post-install" bug was invisible —
 * `chat-send.jsonl` was empty because no POST ever fired.
 */
export type ChatSendLogRecord = ChatSendPostLogRecord | ChatSendPreflightLogRecord;

export interface ChatSendPostLogRecord {
  /** Discriminator. `'send'` for legacy / POST-round-trip rows. */
  phase?: 'send';
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
 * v0.1.62 diagnostic — written to `chat-send.jsonl` when `sendChatText`
 * bails out BEFORE `performSend()`. The pre-v0.1.62 send path returned
 * `{ ok:false, reason:"no-session-cookies" }` silently with no log row,
 * making the "v0.1.61 broke sends" failure mode (split auth state:
 * OAuth token present, chat partition cookies wiped) entirely
 * unobservable from disk.
 */
export interface ChatSendPreflightLogRecord {
  phase: 'preflight';
  /**
   * Why the send is aborting. Mirrors the `SendTextResult.reason`
   * union we return to the renderer (`no-session-cookies` is the
   * v0.1.62 split-auth case; `no-active-connections` and others may
   * surface here in future refactors).
   */
  reason:
    | 'no-session-cookies'
    | 'no-active-connections'
    | 'empty-text'
    | string;
  /**
   * Whether the headless cookie-provisioning helper ran before bailing.
   * `false` when callers pass `skipColdStart`. Helps distinguish
   * "partition truly empty" from "helper ran and still couldn't harvest
   * an XSRF cookie" (the v0.1.62 split-auth signature).
   */
  coldStartAttempted: boolean;
  /** Total number of `.restream.io` cookies the partition reported. */
  cookieCount: number;
  /**
   * Names (not values) of every cookie present. Helpful for spotting the
   * v0.1.62 signature ("only analytics cookies, no XSRF tokens"). Cookie
   * VALUES are never logged.
   */
  cookieNames: string[];
  /** Whether `accessXsrfToken` was present (the v0.1.62 split-auth signal). */
  hasXsrf: boolean;
  /** Number of channels the renderer thinks are live. */
  connectionCount: number;
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
          phase: 'send',
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
          phase: 'send',
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
 * v0.1.34: detect "404 page not found" — Restream's backend returns this
 * plain-text body when the URL ROUTE is missing (e.g. the old
 * `/api/v2/client/reply` path that doesn't exist). The "no active show"
 * 404 path returns a JSON body instead. We use this to distinguish a
 * route-misconfiguration 404 (treat as `send-failed` so the user sees an
 * actionable HTTP error code, not the misleading "no active show" copy)
 * from a real chat-backend 404 (the show genuinely isn't resolvable).
 */
function isRouteNotFound(bodyText: string | undefined): boolean {
  if (!bodyText) return false;
  // Restream's Go/Fiber gateway returns this exact string on unknown routes.
  return /^404 page not found/i.test(bodyText.trim());
}

/**
 * Send a chat reply via Restream's internal endpoint. Pure with respect
 * to the WebSocket client — the reply will come back as a `reply_created`
 * frame which the existing normaliser surfaces as a self message.
 *
 * v0.1.34: corrects the endpoint URL (`/api/client/reply`, no `/v2/`),
 * broadens the body shape to support the full `showId | eventId | instant`
 * triple-tagged union the live chat.restream.io webchat sends, and
 * tightens 404 handling so a route-misconfiguration 404 ("404 page not
 * found" plain-text body) surfaces as `send-failed` instead of being
 * misdiagnosed as `no-show-id`.
 *
 * Retry semantics: on a chat-backend 404 (i.e. NOT a route-not-found
 * 404) we treat the cached context as STALE-but-present, invalidate it
 * via `refreshContext`, and retry the POST once with the fresh value.
 * If the retry also 404s, return `no-show-id` with the actionable
 * "no active show" error.
 */
export async function sendChatText(opts: ChatSendOptions): Promise<SendTextResult> {
  // v0.1.62: helper that emits a preflight diagnostic row to
  // `chat-send.jsonl` before we bail out of the send path. Mirrors the
  // shape of POST-attempt records so log readers can `jq -s` over both.
  // Errors thrown by `opts.log` are swallowed (logging must never break
  // the send path).
  const emitPreflight = (
    reason: ChatSendPreflightLogRecord['reason'],
    extras: {
      coldStartAttempted: boolean;
      cookieCount: number;
      cookieNames: string[];
      hasXsrf: boolean;
    },
  ): void => {
    if (!opts.log) return;
    try {
      opts.log({
        phase: 'preflight',
        reason,
        coldStartAttempted: extras.coldStartAttempted,
        cookieCount: extras.cookieCount,
        cookieNames: extras.cookieNames,
        hasXsrf: extras.hasXsrf,
        connectionCount: opts.connections.length,
      });
    } catch {
      // ignore
    }
  };

  const text = (opts.text ?? '').trim();
  if (!text) {
    emitPreflight('empty-text', {
      coldStartAttempted: false,
      cookieCount: 0,
      cookieNames: [],
      hasXsrf: false,
    });
    return { ok: false, reason: 'error', error: 'empty text' };
  }

  const ids = selectConnectionIdentifiers(opts.connections);
  if (ids.length === 0) {
    emitPreflight('no-active-connections', {
      coldStartAttempted: false,
      cookieCount: 0,
      cookieNames: [],
      hasXsrf: false,
    });
    return { ok: false, reason: 'no-active-connections' };
  }

  // Context is no longer a hard gate. If the WS hasn't sniffed an eventId
  // yet (just-connected, no event/reply frames received), give the REST
  // API a chance to hydrate via `/v2/user/events/in-progress`, then POST
  // regardless. The backend may still 404 if there's no active show — we
  // translate that into a friendlier `no-show-id` error AFTER the attempt
  // rather than blocking pre-send.
  let context: ChatContext = { ...(opts.context ?? {}) };
  const contextIsEmpty = (c: ChatContext): boolean =>
    !c.showId && !c.eventId && !c.instant;
  if (contextIsEmpty(context) && opts.fetchContext) {
    try {
      const hydrated = await opts.fetchContext();
      if (hydrated) context = { ...context, ...hydrated };
    } catch {
      // Fall through — try-send-anyway is the fallback.
    }
  }

  const sess = (opts.getSession ?? getRestreamSession)();
  let cookies = await readRestreamCookies(sess);
  if (!cookies || !cookies.xsrf) {
    if (opts.skipColdStart) {
      // v0.1.62 diagnostic: pre-`performSend` failure, document the
      // cookie-jar state so chat-send.jsonl can show the split-auth
      // signature (analytics cookies present, no XSRF). Without this
      // the v0.1.61 "send broken post-install" bug was invisible.
      emitPreflight('no-session-cookies', {
        coldStartAttempted: false,
        cookieCount: cookies?.raw.length ?? 0,
        cookieNames: cookies?.raw.map((c) => c.name) ?? [],
        hasXsrf: false,
      });
      return { ok: false, reason: 'no-session-cookies' };
    }
    cookies = await provisionCookiesHeadless(sess, opts.parentWindow);
    if (!cookies || !cookies.xsrf) {
      // v0.1.62 diagnostic — see comment above. Hit specifically when
      // the hidden cookie-provisioner couldn't harvest an XSRF cookie
      // either, which is the v0.1.62 split-auth signature.
      emitPreflight('no-session-cookies', {
        coldStartAttempted: true,
        cookieCount: cookies?.raw.length ?? 0,
        cookieNames: cookies?.raw.map((c) => c.name) ?? [],
        hasXsrf: false,
      });
      return { ok: false, reason: 'no-session-cookies' };
    }
  }

  // Per-send UUID. Re-used for the retry POST so Restream's idempotency
  // (if any) treats them as the same logical reply — the user only ever
  // sees one outbound message regardless of attempt count.
  const clientReplyUuid = (opts.uuid ?? randomUUID)();

  // Build the body per the live chat.restream.io webchat priority order:
  //   showId  > eventId  > instant  > none
  // Exactly one identifier (or zero) is emitted into the body. `instant`
  // is serialised as a boolean (the webchat sends `instant: true`).
  const buildBody = (ctx: ChatContext): Record<string, unknown> => {
    const obj: Record<string, unknown> = {
      connectionIdentifiers: ids,
      clientReplyUuid,
      text,
    };
    if (ctx.showId) {
      obj.showId = ctx.showId;
    } else if (ctx.eventId) {
      obj.eventId = ctx.eventId;
    } else if (ctx.instant) {
      obj.instant = true;
    }
    return obj;
  };

  const headers = buildHeaders(cookies.cookieHeader, cookies.xsrf);
  const fetchImpl = opts.fetchImpl ?? fetch;

  // ---- Attempt #1 -------------------------------------------------------
  const first = await performSend({
    url: SEND_URL,
    bodyObj: buildBody(context),
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

  // v0.1.34: route-not-found 404s ("404 page not found" plain text) are
  // a deployment / version-skew failure — NOT a missing show. Surface
  // them as `send-failed` so the user sees the HTTP code + body excerpt
  // rather than the misleading "no active show" copy. The retry path
  // below would also 404 against the same dead route, so short-circuit.
  if (firstRes.status === 404 && isRouteNotFound(first.bodyText)) {
    return {
      ok: false,
      reason: 'send-failed',
      status: 404,
      error: first.bodyText ? first.bodyText.slice(0, 240) : undefined,
    };
  }

  // ---- Retry-on-404 with refreshed context -----------------------------
  // If the first attempt 404'd at the chat backend (i.e. not a
  // route-not-found 404), treat the context we used as stale-but-present
  // (Restream returns 404 both when there's NO show and when the show has
  // ended — same status, same body shape). Force a fresh REST hydration
  // via opts.refreshContext, then retry ONCE. If the fresh context differs
  // from what we just sent, this recovers cleanly. If the fresh context
  // is also missing or matches the stale one, the retry will 404 again
  // and we surface `no-show-id` with the actionable error.
  if (firstRes.status === 404 && opts.refreshContext) {
    let refreshedContext: ChatContext | undefined;
    try {
      refreshedContext = await opts.refreshContext();
    } catch {
      refreshedContext = undefined;
    }
    const second = await performSend({
      url: SEND_URL,
      bodyObj: buildBody(refreshedContext ?? {}),
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
    // Route-not-found on the retry is also `send-failed`.
    if (secondRes.status === 404 && isRouteNotFound(second.bodyText)) {
      return {
        ok: false,
        reason: 'send-failed',
        status: 404,
        error: second.bodyText ? second.bodyText.slice(0, 240) : undefined,
      };
    }
    // Retry failed too. If it's another (chat-backend) 404, the user
    // genuinely has no active show — surface the actionable error.
    // Anything else falls through to send-failed using the SECOND response.
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
  // Back-compat: a chat-backend 404 with no context AND no refresh hook
  // still surfaces as `no-show-id` so the v0.1.20 contract isn't
  // regressed for code paths that don't wire a refresh hook.
  if (firstRes.status === 404 && contextIsEmpty(context)) {
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
