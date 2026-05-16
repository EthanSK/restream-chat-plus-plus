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

  it('returns no-show-id when WS has not sniffed a showId yet', async () => {
    const result = await sendChatText({
      text: 'hello',
      connections: [makeConn('c1')],
      // showId intentionally omitted — the WS client hasn't seen an
      // event/reply frame yet so it cannot supply one.
      parentWindow: null,
      getSession: () => fakeSession([{ name: 'accessXsrfToken', value: 'x' }]),
      skipColdStart: true,
      fetchImpl: vi.fn() as any,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-show-id');
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
});
