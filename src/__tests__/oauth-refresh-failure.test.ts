/**
 * v0.1.52 — refresh-failed handling.
 *
 * Ethan voice 3720 (stuck on Idle, `reconnect-events.jsonl` showed 11+
 * consecutive `refresh-failed`): the prior implementation swallowed any
 * non-OK refresh response as `undefined` AND left the (now-dead) refresh
 * token persisted, so the WS reconnect loop kept retrying the same dead
 * token forever and the user sat on "Idle" with no clear surfacing of
 * "session expired, sign in again".
 *
 * This file pins:
 *  1. Concurrent refresh calls coalesce onto ONE Restream round-trip.
 *  2. A 4xx response (invalid_grant / etc.) wipes persisted state so the
 *     next AUTH_STATUS push flips the UI to the sign-in screen.
 *  3. A 5xx response is treated as transient — token preserved.
 *  4. A 2xx success rotates the refresh-token correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Store, StoreSchema } from '../main/store';

const fakeSafeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from('CIPHER:' + s, 'utf8')),
  decryptString: vi.fn((buf: Buffer) => {
    const raw = buf.toString('utf8');
    if (!raw.startsWith('CIPHER:')) throw new Error('bad ciphertext');
    return raw.slice('CIPHER:'.length);
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
  safeStorage: fakeSafeStorage,
}));

// The OAuth coordinator pulls creds from this helper; stub it deterministic.
vi.mock('../main/credentials', () => ({
  loadRestreamCreds: () => ({
    clientId: 'test-client',
    clientSecret: 'test-secret',
  }),
}));

import { OAuthCoordinator } from '../main/oauth';

function makeStore(): { store: Store; data: Partial<StoreSchema> } {
  const data: Partial<StoreSchema> = {};
  const store: Store = {
    get: (k) => (data as any)[k],
    set: (k, v) => {
      (data as any)[k] = v;
    },
    delete: (k) => {
      delete (data as any)[k];
    },
  };
  return { store, data };
}

const SAMPLE_TOKEN = {
  accessToken: 'access-abc',
  refreshToken: 'refresh-xyz',
  tokenType: 'Bearer' as const,
  scope: 'profile.read chat.read',
  // Already expired so refresh() will be called by callers checking
  // `aboutToExpire`. The refresh() method itself doesn't gate on expiry
  // — it just runs the round-trip — so this is just a realistic value.
  expiresAt: Date.now() - 60 * 1000,
};

describe('OAuthCoordinator.refresh — v0.1.52 failure handling', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('coalesces concurrent refresh() calls onto a single fetch', async () => {
    const { store, data } = makeStore();
    // Seed with a valid encrypted token blob via persistToken — exercised
    // by calling authenticate normally would be hard in unit, so use the
    // public surface: persistToken is private, but the legacy `token` key
    // is a sync read.
    (data as any).token = { ...SAMPLE_TOKEN };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
        scope: SAMPLE_TOKEN.scope,
        expires_in: 3600,
      }),
    } as Response);
    globalThis.fetch = fetchSpy as any;

    const oauth = new OAuthCoordinator(store);
    const [a, b, c] = await Promise.all([
      oauth.refresh(),
      oauth.refresh(),
      oauth.refresh(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a?.accessToken).toBe('new-access');
    expect(b?.accessToken).toBe('new-access');
    expect(c?.accessToken).toBe('new-access');
  });

  it('on 400 invalid_grant: wipes persisted state and returns undefined', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'dead' }),
    } as Response) as any;

    const oauth = new OAuthCoordinator(store);
    const result = await oauth.refresh();
    expect(result).toBeUndefined();

    // logout() wipes both legacy + encrypted forms.
    expect((data as any).token).toBeUndefined();
    expect((data as any).tokenEnc).toBeUndefined();
    // Next refresh call has nothing to refresh.
    expect(await oauth.getTokenAsync()).toBeUndefined();
  });

  it('on 401: also wipes persisted state (4xx treated as fatal)', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_client' }),
    } as Response) as any;

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.refresh()).toBeUndefined();
    expect((data as any).token).toBeUndefined();
  });

  it('on 500: preserves persisted state (5xx is transient)', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'service_unavailable' }),
    } as Response) as any;

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.refresh()).toBeUndefined();
    // Token still on disk — a later retry can succeed.
    expect((data as any).token).toBeDefined();
    expect((data as any).token.refreshToken).toBe('refresh-xyz');
  });

  it('on network throw: preserves persisted state (transient)', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as any;

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.refresh()).toBeUndefined();
    expect((data as any).token).toBeDefined();
  });

  // -------------------------------------------------------------------
  // v0.1.70 (sign-out diagnosis 2026-05-25) — `getLastRefreshFailure()`
  // classification pin tests. The bug fixed in v0.1.70 was that callers
  // couldn't distinguish a transient refresh failure (token still on
  // disk, retry will recover) from a fatal one (token wiped, user must
  // re-auth) — both surfaced as `undefined`. These tests pin the four
  // post-refresh classifications so the watchdog + performFullReconnect
  // branch correctly.
  // -------------------------------------------------------------------

  it('v0.1.70: classifies 4xx as fatal via getLastRefreshFailure()', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    } as Response) as any;

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.refresh()).toBeUndefined();
    expect(oauth.getLastRefreshFailure()).toBe('fatal');
  });

  it('v0.1.70: classifies 5xx as transient via getLastRefreshFailure()', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'service_unavailable' }),
    } as Response) as any;

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.refresh()).toBeUndefined();
    expect(oauth.getLastRefreshFailure()).toBe('transient');
  });

  it('v0.1.70: classifies fetch-throw as transient via getLastRefreshFailure()', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };
    // Exact bug-of-the-week: fetch() threw mid-call (network sleep /
    // VPN handoff / DNS hiccup). Pre-v0.1.70 this looked identical to
    // an invalid_grant from the caller's perspective.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as any;

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.refresh()).toBeUndefined();
    expect(oauth.getLastRefreshFailure()).toBe('transient');
  });

  it('v0.1.70: classifies success as none via getLastRefreshFailure()', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'fresh',
        refresh_token: 'rotated',
        token_type: 'Bearer',
        scope: SAMPLE_TOKEN.scope,
        expires_in: 3600,
      }),
    } as Response) as any;

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.refresh()).toBeDefined();
    // Cleared just before the return so the next reader sees a clean
    // slate — important for the watchdog's recovery-success branch
    // which reads this AFTER awaiting refresh().
    expect(oauth.getLastRefreshFailure()).toBe('none');
  });

  it('v0.1.70: a transient failure followed by a success resets to none', async () => {
    // Pins the watchdog's recovery-success state machine: after the
    // initial transient failure (classification = 'transient'), the
    // periodic retry tick eventually gets a 2xx, and that success
    // path clears the classification to 'none' so subsequent reads
    // (e.g. another tick somehow firing) don't see stale state.
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };
    const oauth = new OAuthCoordinator(store);

    // First attempt: 5xx → transient.
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response) as any;
    await oauth.refresh();
    expect(oauth.getLastRefreshFailure()).toBe('transient');

    // Second attempt: 200 → none.
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'recovered',
        refresh_token: 'rotated',
        token_type: 'Bearer',
        scope: SAMPLE_TOKEN.scope,
        expires_in: 3600,
      }),
    } as Response) as any;
    await oauth.refresh();
    expect(oauth.getLastRefreshFailure()).toBe('none');
  });

  it('on 200 success: rotates refresh-token and persists new pair', async () => {
    const { store, data } = makeStore();
    (data as any).token = { ...SAMPLE_TOKEN };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        scope: SAMPLE_TOKEN.scope,
        expires_in: 3600,
      }),
    } as Response) as any;

    const oauth = new OAuthCoordinator(store);
    const result = await oauth.refresh();
    expect(result?.accessToken).toBe('rotated-access');
    expect(result?.refreshToken).toBe('rotated-refresh');

    // Persisted form is the new pair, encrypted.
    const enc = (data as any).tokenEnc as string;
    expect(enc).toBeDefined();
    const decoded = Buffer.from(enc, 'base64').toString('utf8');
    expect(decoded).toContain('rotated-access');
    expect(decoded).toContain('rotated-refresh');
  });
});
