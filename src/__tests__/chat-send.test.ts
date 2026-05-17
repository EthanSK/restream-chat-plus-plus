import { describe, it, expect, vi } from 'vitest';
import { sendChatText, __test_internals } from '../main/chat-send';
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
      showId: 'show-1',
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-active-connections');
  });

  it('v0.1.20: attempts the POST even when no showId is known (try-send-anyway)', async () => {
    // Previously this returned a pre-flight `no-show-id` reject so users
    // couldn't send before the first WS event flowed. The new contract is:
    // try the POST regardless. The body MUST omit `showId` (rather than
    // sending null/empty, which Restream's validator rejects).
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      // showId intentionally omitted — WS hasn't sniffed one yet.
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
    // Critical: showId is OMITTED from the body when unknown, not sent
    // as null / empty-string (Restream's backend validates it).
    expect('showId' in body).toBe(false);
  });

  it('v0.1.20: surfaces no-show-id only AFTER a 404 with no showId in body', async () => {
    // The 404 path is now the clear signal that the backend couldn't
    // resolve an active show. Render that as `no-show-id` with the
    // actionable message — not as a generic `send-failed (HTTP 404)`.
    const fakeFetch = async () =>
      new Response('show not found', { status: 404 });
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

  it('v0.1.20: a 404 WITH a showId in body still falls through to send-failed', async () => {
    // When the body DID contain a showId, a 404 isn't the "no active show"
    // case — surface the regular send-failed so the user can act on it.
    const fakeFetch = async () =>
      new Response('not found', { status: 404 });
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      showId: 'sid-abc',
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send-failed');
    expect(result.status).toBe(404);
  });

  it('v0.1.20: hydrates showId via fetchShowId hook when none was supplied', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    let hydrateCount = 0;
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      // showId undefined — main.ts threads in fetchShowId pointing at the
      // /v2/user/events/in-progress hydration helper.
      fetchShowId: async () => {
        hydrateCount += 1;
        return 'rest-hydrated-show-id';
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(hydrateCount).toBe(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.showId).toBe('rest-hydrated-show-id');
  });

  it('v0.1.20: skips fetchShowId hook when a showId is already known', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    let hydrateCount = 0;
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      showId: 'ws-sniffed-show-id',
      fetchShowId: async () => {
        hydrateCount += 1;
        return 'should-not-be-used';
      },
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(hydrateCount).toBe(0);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.showId).toBe('ws-sniffed-show-id');
  });

  it('v0.1.20: fetchShowId hook errors are swallowed, send proceeds without showId', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      fetchShowId: async () => {
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
  });

  it('returns no-session-cookies when partition has no chat cookies', async () => {
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      showId: 'show-1',
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
      showId: 'show-1',
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'someOther', value: 'v' }]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-session-cookies');
  });

  it('POSTs to the documented endpoint with the right body shape on success', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await sendChatText({
      text: 'hi chat',
      connections: [makeConn('user-twitch-x'), makeConn('user-youtube-y', 'error')],
      showId: 'd2c85b30-9523-476d-a50f-eac4b80490e4',
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
    expect(calls[0].url).toBe('https://backend.chat.restream.io/api/v2/client/reply');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-axsrf-token']).toBe('XSRF-1');
    expect(headers['cookie']).toContain('accessXsrfToken=XSRF-1');
    expect(headers['cookie']).toContain('session=s-1');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.text).toBe('hi chat');
    expect(body.connectionIdentifiers).toEqual(['user-twitch-x']);
    expect(body.clientReplyUuid).toBe('uuid-fixed');
    // v0.1.17: showId MUST be in the body — without it Restream's backend
    // returns 404 because it can't resolve the active show. Regression
    // guard so we never silently drop showId again.
    expect(body.showId).toBe('d2c85b30-9523-476d-a50f-eac4b80490e4');
  });

  it('returns send-failed with status code on non-2xx', async () => {
    const fakeFetch = async () =>
      new Response('rate limited', { status: 429 });
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      showId: 'show-1',
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
      showId: 'show-1',
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
  });

  // --------------------------------------------------------------------
  // v0.1.28: stale-but-present showId — 404 → invalidate → retry once
  // --------------------------------------------------------------------
  // The v0.1.20 path only hydrated showId when it was UNDEFINED. Real-world
  // case: WS sniffed `show-A` from a previous stream, that stream ended, WS
  // stayed up, user tries to send. opts.showId is set to the stale 'show-A',
  // Restream returns 404. v0.1.28 invalidates the cached value, re-hydrates
  // via the REST API, and retries the POST. Only after the retry also 404s
  // do we surface no-show-id.

  it('v0.1.28: retries with refreshed showId after first 404 (recovers cleanly)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      // First call: stale show-A → 404. Second call: fresh show-B → 200.
      if (calls.length === 1) return new Response('show not found', { status: 404 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    let refreshCalls = 0;
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      showId: 'stale-show-A',
      refreshShowId: async () => {
        refreshCalls += 1;
        return 'fresh-show-B';
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

  it('v0.1.28: returns no-show-id after retry also 404s', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('show not found', { status: 404 });
    };
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      showId: 'stale-show-A',
      refreshShowId: async () => undefined, // No active in-progress event.
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-show-id');
    expect(result.status).toBe(404);
    expect(result.error).toContain('No active show');
    expect(calls.length).toBe(2); // First attempt + retry, no third.
    const secondBody = JSON.parse(String(calls[1].init.body));
    // Retry POSTed without showId because refresh returned undefined.
    expect('showId' in secondBody).toBe(false);
  });

  it('v0.1.28: retry with refreshed id still 404 → no-show-id error', async () => {
    // Both attempts get 404 even though refresh returned a value (e.g. the
    // refreshed id was ALSO stale, or the user genuinely has no show despite
    // the REST API returning something). Same actionable error.
    const fakeFetch = async () => new Response('not found', { status: 404 });
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      showId: 'stale-A',
      refreshShowId: async () => 'still-stale-B',
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-show-id');
    expect(result.error).toContain('No active show');
  });

  it('v0.1.28: retry path is skipped when no refreshShowId hook is provided', async () => {
    // Back-compat: if main.ts doesn't wire refreshShowId, the v0.1.20 contract
    // (single attempt → no-show-id only when body lacked showId) must hold.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('not found', { status: 404 });
    };
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      showId: 'stale-A',
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send-failed'); // Stale showId → 404 → send-failed (v0.1.20 contract).
    expect(calls.length).toBe(1);
  });

  it('v0.1.28: log callback fires per POST attempt with redacted headers', async () => {
    const logRecords: Array<any> = [];
    const fakeFetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      showId: 'show-X',
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

  it('v0.1.28: log records both attempt:1 and attempt:2 on the retry path', async () => {
    const logRecords: Array<any> = [];
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      if (n === 1) return new Response('not found', { status: 404 });
      return new Response('{}', { status: 200 });
    };
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      showId: 'stale',
      refreshShowId: async () => 'fresh',
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

  it('v0.1.28: non-404 errors do NOT trigger the retry path', async () => {
    // 429, 500, etc are NOT the stale-showId signal — only 404 is. Retrying
    // would just waste a request. Guard against accidental retry-on-everything.
    const calls: number[] = [];
    const fakeFetch = async () => {
      calls.push(1);
      return new Response('rate limited', { status: 429 });
    };
    let refreshCalls = 0;
    const result = await sendChatText({
      text: 'hi',
      connections: [makeConn('c1')],
      showId: 'show-A',
      refreshShowId: async () => {
        refreshCalls += 1;
        return 'show-B';
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
