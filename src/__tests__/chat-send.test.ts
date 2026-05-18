import { describe, it, expect, vi } from 'vitest';
import { sendChatText, __test_internals, type ChatContext } from '../main/chat-send';
import type { ChatConnection } from '../shared/types';

// We can't import electron's `session` in node-context tests, so we provide
// a fake Session via the `getSession` injection point.

function makeConn(id: string, status: ChatConnection['status'] = 'connected'): ChatConnection {
  return {
    connectionIdentifier: id,
    connectionUuid: `${id}-uuid`,
    eventSourceId: 2,
    platform: 'twitch',
    status,
    updatedAt: Date.now(),
  };
}

function fakeSession(cookies: Array<{ name: string; value: string }>): any {
  return {
    cookies: {
      get: async () => cookies,
    },
  };
}

describe('chat-send', () => {
  it('selects only connected identifiers when at least one is connected', () => {
    const ids = __test_internals.selectConnectionIdentifiers([
      makeConn('a', 'connected'),
      makeConn('b', 'error'),
      makeConn('c', 'connected'),
    ]);
    expect(ids).toEqual(['a', 'c']);
  });

  it('falls back to all known connections when none are connected', () => {
    const ids = __test_internals.selectConnectionIdentifiers([
      makeConn('a', 'error'),
      makeConn('b', 'connecting'),
    ]);
    expect(ids).toEqual(['a', 'b']);
  });

  it('builds the headers Restream requires (x-axsrf-token + origin + cookie)', () => {
    const headers = __test_internals.buildHeaders('a=1; b=2', 'xsrf-abc');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-axsrf-token']).toBe('xsrf-abc');
    expect(headers['cookie']).toBe('a=1; b=2');
    expect(headers['origin']).toBe('https://chat.restream.io');
    expect(headers['referer']).toBe('https://chat.restream.io/');
  });

  it('returns no-active-connections when channels list is empty', async () => {
    const result = await sendChatText({
      text: 'hello',
      connections: [],
      context: { showId: 'show-1' },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-active-connections');
  });

  it('try-send-anyway when context is empty: POSTs WITHOUT identifier field', async () => {
    // v0.1.20 contract preserved through v0.1.34. If neither WS nor REST
    // hydrate any identifier, attempt the POST anyway with just
    // `{connectionIdentifiers, clientReplyUuid, text}` — the backend may
    // still resolve from session state. Only after a 404 do we surface
    // the actionable error.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      // context intentionally omitted — WS hasn't sniffed anything yet
      // and the REST hook isn't wired.
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.text).toBe('hello');
    expect(body.connectionIdentifiers).toEqual(['c1']);
    // Critical: NONE of the three identifiers leak into the body when
    // they're all undefined. Restream's validator rejects null/empty/false
    // for these fields (the live webchat omits them entirely in this case).
    expect('showId' in body).toBe(false);
    expect('eventId' in body).toBe(false);
    expect('instant' in body).toBe(false);
  });

  it('surfaces no-show-id only AFTER a 404 with no identifier in body', async () => {
    // The 404 path is the clear signal that the backend couldn't resolve
    // an active show / event / instant stream. Render that as
    // `no-show-id` with the actionable message — not as a generic
    // `send-failed (HTTP 404)`. (Route-not-found 404s are tested below.)
    const fakeFetch = async () =>
      new Response('{"error":"show not found"}', { status: 404 });
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-show-id');
    expect(result.status).toBe(404);
  });

  it('a 404 WITH a context identifier still falls through to send-failed', async () => {
    // When the body DID carry an identifier, a 404 isn't the "no active
    // show" case for this single-attempt code path — surface the regular
    // send-failed so the user can act on it.
    const fakeFetch = async () =>
      new Response('{"error":"not found"}', { status: 404 });
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'sid-abc' },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send-failed');
    expect(result.status).toBe(404);
  });

  it('hydrates chat context via fetchContext hook when none was supplied', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    let hydrateCount = 0;
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      // context undefined — main.ts threads in fetchContext pointing at
      // /v2/user/events/in-progress hydration helper.
      fetchContext: async () => {
        hydrateCount += 1;
        return { eventId: 'rest-hydrated-event-id' };
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(hydrateCount).toBe(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.eventId).toBe('rest-hydrated-event-id');
    expect('showId' in body).toBe(false);
    expect('instant' in body).toBe(false);
  });

  it('skips fetchContext hook when a context identifier is already known', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    let hydrateCount = 0;
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      context: { eventId: 'ws-sniffed-event-id' },
      fetchContext: async () => {
        hydrateCount += 1;
        return { eventId: 'should-not-be-used' };
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(hydrateCount).toBe(0);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.eventId).toBe('ws-sniffed-event-id');
  });

  it('fetchContext hook errors are swallowed, send proceeds without context', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      fetchContext: async () => {
        throw new Error('network down');
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(calls[0].init.body));
    expect('showId' in body).toBe(false);
    expect('eventId' in body).toBe(false);
    expect('instant' in body).toBe(false);
  });

  it('returns no-session-cookies when partition has no chat cookies', async () => {
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'show-1' },
      parentWindow: null,
      getSession: () => fakeSession([]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-session-cookies');
  });

  it('returns no-session-cookies when accessXsrfToken cookie is missing', async () => {
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'show-1' },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'someOther', value: 'v' }]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-session-cookies');
  });

  // --------------------------------------------------------------------
  // v0.1.34: endpoint URL + body shape (showId | eventId | instant)
  // --------------------------------------------------------------------

  it('v0.1.34: POSTs to /api/client/reply (NOT /api/v2/client/reply)', async () => {
    // The previous URL was a 404 ghost route on Restream's backend. Live
    // probe at the time of v0.1.34 cut: POST /api/v2/client/reply → 404
    // "page not found" plain text; POST /api/client/reply → 401 JSON
    // (i.e. the v1 path is the real one, the v2 was never deployed).
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      context: { showId: 'show-1' },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(calls[0].url).toBe('https://backend.chat.restream.io/api/client/reply');
    expect(calls[0].url).not.toContain('/v2/');
  });

  it('v0.1.34: showId in context → body carries {showId} (priority #1)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      // All three set — showId wins per the live webchat priority order.
      context: { showId: 'show-1', eventId: 'event-1', instant: true },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.showId).toBe('show-1');
    expect('eventId' in body).toBe(false);
    expect('instant' in body).toBe(false);
  });

  it('v0.1.34: eventId in context (no showId) → body carries {eventId} (priority #2)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      context: { eventId: 'evt-abc', instant: true },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.eventId).toBe('evt-abc');
    expect('showId' in body).toBe(false);
    expect('instant' in body).toBe(false);
  });

  it('v0.1.34: instant=true only → body carries {instant: true} (priority #3)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      context: { instant: true },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.instant).toBe(true);
    expect('showId' in body).toBe(false);
    expect('eventId' in body).toBe(false);
  });

  it('v0.1.34: route-not-found 404 ("404 page not found") → send-failed, NOT no-show-id', async () => {
    // Critical: the v0.1.32-v0.1.33 retry-on-404 path was mistranslating
    // route-misconfiguration 404s (from the dead /api/v2/client/reply
    // route) as "no active show". v0.1.34 distinguishes the plain-text
    // "404 page not found" body (gateway-level) from JSON-bodied 404s
    // (chat-backend-level) and surfaces the former as `send-failed`.
    const calls: number[] = [];
    const fakeFetch = async () => {
      calls.push(1);
      return new Response('404 page not found\n', { status: 404 });
    };
    let refreshCount = 0;
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'show-X' },
      refreshContext: async () => {
        refreshCount += 1;
        return { showId: 'fresh' };
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send-failed');
    expect(result.status).toBe(404);
    expect(result.error).toContain('404 page not found');
    // Crucially: NO retry was attempted — the route is gone, retrying
    // the same dead URL is pointless.
    expect(calls.length).toBe(1);
    expect(refreshCount).toBe(0);
  });

  it('POSTs to the corrected endpoint with the right body shape on success', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await sendChatText({
      text: 'hi chat',
      connections: [makeConn('user-twitch-x'), makeConn('user-youtube-y', 'error')],
      context: { showId: 'd2c85b30-9523-476d-a50f-eac4b80490e4' },
      parentWindow: null,
      getSession: () =>
        fakeSession([
          { name: 'accessXsrfToken', value: 'XSRF-1' },
          { name: 'session', value: 's-1' },
        ]),
      skipColdStart: true,
      uuid: () => 'uuid-fixed',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://backend.chat.restream.io/api/client/reply');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-axsrf-token']).toBe('XSRF-1');
    expect(headers['cookie']).toContain('accessXsrfToken=XSRF-1');
    expect(headers['cookie']).toContain('session=s-1');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.text).toBe('hi chat');
    expect(body.connectionIdentifiers).toEqual(['user-twitch-x']);
    expect(body.clientReplyUuid).toBe('uuid-fixed');
    // v0.1.17 → v0.1.34: identifier MUST be in the body so Restream can
    // resolve the active show/event. Regression guard so we never silently
    // drop the identifier again.
    expect(body.showId).toBe('d2c85b30-9523-476d-a50f-eac4b80490e4');
  });

  it('returns send-failed with status code on non-2xx', async () => {
    const fakeFetch = async () =>
      new Response('rate limited', { status: 429 });
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      context: { showId: 'show-1' },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send-failed');
    expect(result.status).toBe(429);
  });

  it('trims whitespace and rejects empty text', async () => {
    const result = await sendChatText({
      text: '   ',
      connections: [makeConn('c1')],
      context: { showId: 'show-1' },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
  });

  // --------------------------------------------------------------------
  // v0.1.28: stale-but-present context — 404 → invalidate → retry once
  // (v0.1.34 carries the same semantics over to the new context API)
  // --------------------------------------------------------------------

  it('retries with refreshed context after first chat-backend 404 (recovers cleanly)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      // First call: stale show-A → 404 JSON. Second call: fresh show-B → 200.
      if (calls.length === 1) {
        return new Response('{"error":"show not found"}', { status: 404 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    let refreshCalls = 0;
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'stale-show-A' },
      refreshContext: async () => {
        refreshCalls += 1;
        return { showId: 'fresh-show-B' };
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect(refreshCalls).toBe(1);
    const firstBody = JSON.parse(String(calls[0].init.body));
    const secondBody = JSON.parse(String(calls[1].init.body));
    expect(firstBody.showId).toBe('stale-show-A');
    expect(secondBody.showId).toBe('fresh-show-B');
    // Same UUID across both attempts — Restream sees one logical reply.
    expect(secondBody.clientReplyUuid).toBe(firstBody.clientReplyUuid);
  });

  it('returns no-show-id after retry also chat-backend 404s', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"error":"show not found"}', { status: 404 });
    };
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'stale-show-A' },
      refreshContext: async () => undefined, // No active in-progress event.
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-show-id');
    expect(result.status).toBe(404);
    expect(result.error).toContain('No active show');
    expect(calls.length).toBe(2);
    const secondBody = JSON.parse(String(calls[1].init.body));
    // Retry POSTed without identifier because refresh returned undefined.
    expect('showId' in secondBody).toBe(false);
    expect('eventId' in secondBody).toBe(false);
    expect('instant' in secondBody).toBe(false);
  });

  it('retry with refreshed context still 404 → no-show-id error', async () => {
    const fakeFetch = async () =>
      new Response('{"error":"not found"}', { status: 404 });
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'stale-A' },
      refreshContext: async () => ({ showId: 'still-stale-B' }),
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-show-id');
    expect(result.error).toContain('No active show');
  });

  it('retry path is skipped when no refreshContext hook is provided', async () => {
    // Back-compat: if main.ts doesn't wire refreshContext, a single
    // attempt → send-failed (not no-show-id) for a context-bearing body.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"error":"not found"}', { status: 404 });
    };
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'stale-A' },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send-failed');
    expect(calls.length).toBe(1);
  });

  it('log callback fires per POST attempt with redacted headers', async () => {
    const logRecords: Array<any> = [];
    const fakeFetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      context: { showId: 'show-X' },
      parentWindow: null,
      getSession: () =>
        fakeSession([
          { name: 'accessXsrfToken', value: 'XSRF-SUPER-SECRET' },
          { name: 'session', value: 'SESS-COOKIE-VALUE-DO-NOT-LEAK' },
        ]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      log: (r) => logRecords.push(r),
    });
    expect(logRecords.length).toBe(1);
    expect(logRecords[0].attempt).toBe(1);
    expect(logRecords[0].response.status).toBe(200);
    expect(logRecords[0].body.showId).toBe('show-X');
    expect(logRecords[0].showIdRefreshed).toBe(false);
    // Cookie + xsrf MUST be redacted — log goes to disk.
    expect(logRecords[0].headers.cookie).toMatch(/^<redacted len=\d+>$/);
    expect(logRecords[0].headers.cookie).not.toContain('SUPER-SECRET');
    expect(logRecords[0].headers.cookie).not.toContain('SESS-COOKIE-VALUE');
    expect(logRecords[0].headers['x-axsrf-token']).toMatch(/^sha256:/);
    expect(logRecords[0].headers['x-axsrf-token']).not.toContain('XSRF-SUPER-SECRET');
    // Non-sensitive headers stay verbatim.
    expect(logRecords[0].headers.origin).toBe('https://chat.restream.io');
  });

  it('log records both attempt:1 and attempt:2 on the retry path', async () => {
    const logRecords: Array<any> = [];
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      if (n === 1) return new Response('{"error":"not found"}', { status: 404 });
      return new Response('{}', { status: 200 });
    };
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      context: { showId: 'stale' },
      refreshContext: async () => ({ showId: 'fresh' }),
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      log: (r) => logRecords.push(r),
    });
    expect(result.ok).toBe(true);
    expect(logRecords.length).toBe(2);
    expect(logRecords[0].attempt).toBe(1);
    expect(logRecords[0].response.status).toBe(404);
    expect(logRecords[0].showIdRefreshed).toBe(false);
    expect(logRecords[0].body.showId).toBe('stale');
    expect(logRecords[1].attempt).toBe(2);
    expect(logRecords[1].response.status).toBe(200);
    expect(logRecords[1].showIdRefreshed).toBe(true);
    expect(logRecords[1].body.showId).toBe('fresh');
  });

  it('non-404 errors do NOT trigger the retry path', async () => {
    // 429, 500, etc are NOT the stale-context signal — only chat-backend
    // 404 is. Retrying would just waste a request.
    const calls: number[] = [];
    const fakeFetch = async () => {
      calls.push(1);
      return new Response('rate limited', { status: 429 });
    };
    let refreshCalls = 0;
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      context: { showId: 'show-A' },
      refreshContext: async () => {
        refreshCalls += 1;
        return { showId: 'show-B' };
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send-failed');
    expect(result.status).toBe(429);
    expect(calls.length).toBe(1);
    expect(refreshCalls).toBe(0);
  });
});
