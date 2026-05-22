import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Store, StoreSchema } from '../main/store';

// Mock the entire `electron` module. vitest hoists `vi.mock` calls above
// imports, which means the factory can't close over a regular `const` —
// hence `vi.hoisted` to create the fake-safeStorage object alongside the
// hoist. The fake uses a non-reversible-looking ASCII wrapper so the
// "encrypted" output is trivially distinguishable from the plaintext token
// JSON in assertions.
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

// Import AFTER the mock — vitest hoists `vi.mock` above imports per its docs,
// but importing OAuthCoordinator from the source guarantees we use the
// real production class with the mocked electron dep.
import { OAuthCoordinator } from '../main/oauth';

function makeStore(): { store: Store; data: Partial<StoreSchema> } {
  const data: Partial<StoreSchema> = {};
  const store: Store = {
    get: (k) => data[k] as any,
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
  tokenType: 'Bearer',
  scope: 'profile.read chat.read',
  expiresAt: Date.now() + 60 * 60 * 1000,
};

describe('OAuthCoordinator token persistence', () => {
  beforeEach(() => {
    fakeSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    fakeSafeStorage.encryptString.mockClear();
    fakeSafeStorage.decryptString.mockClear();
    fakeSafeStorage.decryptString.mockImplementation((buf: Buffer) => {
      const raw = buf.toString('utf8');
      if (!raw.startsWith('CIPHER:')) throw new Error('bad ciphertext');
      return raw.slice('CIPHER:'.length);
    });
  });

  it('migrates a legacy plain `token` into encrypted `tokenEnc` on first read', () => {
    const { store, data } = makeStore();
    // Simulate a v0.1.14-and-earlier on-disk layout.
    data.token = { ...SAMPLE_TOKEN };

    const oauth = new OAuthCoordinator(store);
    // v0.1.38: legacy plain-token path is still sync-safe — no Keychain
    // decrypt needed, so `getToken()` migrates it forward on first call.
    const got = oauth.getToken();

    expect(got).toEqual(SAMPLE_TOKEN);
    // Legacy key must be wiped — secret only lives in one place.
    expect(data.token).toBeUndefined();
    // Encrypted ciphertext (base64) must now be present.
    expect(typeof data.tokenEnc).toBe('string');
    expect(data.tokenEnc!.length).toBeGreaterThan(0);
    expect(fakeSafeStorage.encryptString).toHaveBeenCalledTimes(1);
  });

  it('round-trips a freshly-stored token through getTokenAsync()', async () => {
    const { store, data } = makeStore();
    const oauth = new OAuthCoordinator(store);
    // Use the private persistToken path via (oauth as any) — exercised in
    // production by exchangeCode / refresh.
    (oauth as any).persistToken(SAMPLE_TOKEN);

    expect(data.token).toBeUndefined();
    expect(typeof data.tokenEnc).toBe('string');

    // Fresh coordinator instance to prove decrypt happens via the async
    // path (the boot-safe entry point that the deferred resume uses).
    const oauth2 = new OAuthCoordinator(store);
    expect(await oauth2.getTokenAsync()).toEqual(SAMPLE_TOKEN);
    // After the async decrypt populates the in-memory cache, the sync
    // getter sees the cached value (zero Keychain calls).
    expect(oauth2.getToken()).toEqual(SAMPLE_TOKEN);
  });

  it('logout() clears BOTH legacy and encrypted keys', async () => {
    const { store, data } = makeStore();
    data.token = { ...SAMPLE_TOKEN };
    data.tokenEnc = 'old-ciphertext';

    const oauth = new OAuthCoordinator(store);
    await oauth.logout();

    expect(data.token).toBeUndefined();
    expect(data.tokenEnc).toBeUndefined();
    expect(oauth.getToken()).toBeUndefined();
  });

  it('falls back to plain `token` storage when encryption is unavailable', () => {
    fakeSafeStorage.isEncryptionAvailable.mockReturnValue(false);

    const { store, data } = makeStore();
    const oauth = new OAuthCoordinator(store);
    (oauth as any).persistToken(SAMPLE_TOKEN);

    // Without encryption we keep the plain key so the user can still sign in.
    expect(data.token).toEqual(SAMPLE_TOKEN);
    expect(data.tokenEnc).toBeUndefined();
    expect(fakeSafeStorage.encryptString).not.toHaveBeenCalled();

    // And getToken() still returns the value on next read (plain path is
    // sync-safe).
    const oauth2 = new OAuthCoordinator(store);
    expect(oauth2.getToken()).toEqual(SAMPLE_TOKEN);
  });

  it('isAuthenticated() honours the access-token expiry window from the decrypted blob', async () => {
    const { store } = makeStore();
    const oauth = new OAuthCoordinator(store);
    (oauth as any).persistToken({
      ...SAMPLE_TOKEN,
      expiresAt: Date.now() - 1000, // expired
    });
    expect(oauth.isAuthenticated()).toBe(false);
    expect(await oauth.isAuthenticatedAsync()).toBe(false);

    (oauth as any).persistToken({
      ...SAMPLE_TOKEN,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h fresh
    });
    expect(oauth.isAuthenticated()).toBe(true);
    expect(await oauth.isAuthenticatedAsync()).toBe(true);
  });

  it('returns undefined cleanly when decryption fails (e.g. Keychain rotated)', async () => {
    const { store, data } = makeStore();
    // Plant a ciphertext that will fail to decrypt.
    data.tokenEnc = Buffer.from('not-our-format', 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    // v0.1.38: async path is the one that actually attempts decrypt.
    expect(await oauth.getTokenAsync()).toBeUndefined();
    expect(oauth.isAuthenticated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v0.1.38 — boot-path-safe decrypt behaviour
// ---------------------------------------------------------------------------
//
// These tests cover the fundamental fix for the "fresh install over existing
// install blocks indefinitely on Allow Safe Storage prompt" bug. Three
// guarantees the new design must hold:
//
//   1. The sync `getToken()` never touches Keychain (no decrypt call) when
//      only an encrypted blob is on disk. The boot path therefore can't
//      hang on a SecurityAgent prompt.
//   2. `getTokenAsync()` enforces a 2-second timeout on decrypt. When a
//      pathological binary-signature mismatch keeps the syscall pending
//      past 2s we treat it as ACL drift, wipe the blob, and resolve
//      undefined.
//   3. After ACL-drift wipe the user can re-authenticate and the NEW
//      ciphertext is bound to the current binary's ACL — no infinite
//      prompt loop across launches.
// ---------------------------------------------------------------------------

describe('OAuthCoordinator boot-path safety (v0.1.38)', () => {
  beforeEach(() => {
    fakeSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    fakeSafeStorage.encryptString.mockClear();
    fakeSafeStorage.decryptString.mockClear();
    fakeSafeStorage.decryptString.mockImplementation((buf: Buffer) => {
      const raw = buf.toString('utf8');
      if (!raw.startsWith('CIPHER:')) throw new Error('bad ciphertext');
      return raw.slice('CIPHER:'.length);
    });
  });

  it('sync getToken() does NOT call safeStorage.decryptString when only an encrypted blob is on disk', () => {
    const { store, data } = makeStore();
    // Plant a valid encrypted blob — sync getter must still refuse to
    // touch Keychain so a SecurityAgent prompt cannot block boot.
    data.tokenEnc = Buffer.from('CIPHER:' + JSON.stringify(SAMPLE_TOKEN), 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    expect(oauth.getToken()).toBeUndefined();
    expect(fakeSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('sync isAuthenticated() does NOT call safeStorage.decryptString on a cold launch', () => {
    const { store, data } = makeStore();
    data.tokenEnc = Buffer.from('CIPHER:' + JSON.stringify(SAMPLE_TOKEN), 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    expect(oauth.isAuthenticated()).toBe(false);
    expect(fakeSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('getTokenAsync() resolves the encrypted token via the deferred decrypt and populates the cache', async () => {
    const { store, data } = makeStore();
    data.tokenEnc = Buffer.from('CIPHER:' + JSON.stringify(SAMPLE_TOKEN), 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    const got = await oauth.getTokenAsync();
    expect(got).toEqual(SAMPLE_TOKEN);
    expect(fakeSafeStorage.decryptString).toHaveBeenCalledTimes(1);

    // Subsequent sync calls now hit the cache — no further Keychain touch.
    fakeSafeStorage.decryptString.mockClear();
    expect(oauth.getToken()).toEqual(SAMPLE_TOKEN);
    expect(oauth.isAuthenticated()).toBe(true);
    expect(fakeSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('coalesces concurrent getTokenAsync() callers onto a single decrypt', async () => {
    const { store, data } = makeStore();
    data.tokenEnc = Buffer.from('CIPHER:' + JSON.stringify(SAMPLE_TOKEN), 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    const [a, b, c] = await Promise.all([
      oauth.getTokenAsync(),
      oauth.getTokenAsync(),
      oauth.getTokenAsync(),
    ]);
    expect(a).toEqual(SAMPLE_TOKEN);
    expect(b).toEqual(SAMPLE_TOKEN);
    expect(c).toEqual(SAMPLE_TOKEN);
    // Three concurrent boot-path callers must NOT trigger three Keychain
    // prompts — exactly one decrypt should fire.
    expect(fakeSafeStorage.decryptString).toHaveBeenCalledTimes(1);
  });

  it('decrypt failure wipes tokenEnc and disables further decrypt attempts for this launch (ACL-drift recovery)', async () => {
    const { store, data } = makeStore();
    // Plant a ciphertext that decryptString will throw on — simulates the
    // ACL-mismatch case after the user clicks Deny on the SecurityAgent
    // prompt (Electron surfaces it as a thrown error).
    fakeSafeStorage.decryptString.mockImplementation(() => {
      throw new Error('User denied access to Keychain');
    });
    data.tokenEnc = 'whatever';

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.getTokenAsync()).toBeUndefined();
    // The stale encrypted blob must be wiped — keeping it means EVERY
    // future launch hits the same broken Keychain ACL.
    expect(data.tokenEnc).toBeUndefined();

    // A second call within the same launch must NOT re-attempt decrypt
    // (and therefore must NOT bug the user with a second prompt).
    fakeSafeStorage.decryptString.mockClear();
    expect(await oauth.getTokenAsync()).toBeUndefined();
    expect(fakeSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('decrypt timeout (Keychain prompt hangs >2s) is treated as ACL drift and wipes tokenEnc', async () => {
    vi.useFakeTimers();
    try {
      const { store, data } = makeStore();
      // Make decryptString return a never-resolving promise to simulate
      // the SecurityAgent prompt hanging the syscall indefinitely.
      let resolveStuck: (v: string) => void = () => undefined;
      fakeSafeStorage.decryptString.mockImplementation(() => {
        // Block the syscall by returning a sync value AFTER a deferred
        // resolution — but the production path wraps with Promise.race
        // so this still exercises the timeout branch.
        return new Promise<string>((resolve) => {
          resolveStuck = resolve;
        }) as unknown as string;
      });
      data.tokenEnc = 'whatever';

      const oauth = new OAuthCoordinator(store);
      const decryptPromise = oauth.getTokenAsync();

      // Advance the clock past the 2s decrypt timeout. Need a couple of
      // ticks for the two setImmediate yields in `runDeferredDecrypt`
      // to settle first.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2100);

      const got = await decryptPromise;
      expect(got).toBeUndefined();
      expect(data.tokenEnc).toBeUndefined();

      // Unblock the now-orphaned decryptString so vitest doesn't warn
      // about a hanging promise.
      resolveStuck('CIPHER:' + JSON.stringify(SAMPLE_TOKEN));
    } finally {
      vi.useRealTimers();
    }
  });

  it('after ACL drift, a fresh authenticate() persists a new tokenEnc and re-enables decrypt', async () => {
    const { store, data } = makeStore();
    fakeSafeStorage.decryptString.mockImplementation(() => {
      throw new Error('User denied access to Keychain');
    });
    data.tokenEnc = 'whatever';

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.getTokenAsync()).toBeUndefined();
    expect(data.tokenEnc).toBeUndefined();

    // Simulate the user completing the OAuth flow after the wipe — the
    // production path calls persistToken with the fresh TokenSet.
    (oauth as any).persistToken(SAMPLE_TOKEN);
    expect(typeof data.tokenEnc).toBe('string');
    // Sync getToken now returns the cached value (no decrypt attempt).
    expect(oauth.getToken()).toEqual(SAMPLE_TOKEN);
    expect(oauth.isAuthenticated()).toBe(true);
  });

  it('yields to the event loop before touching Keychain so the renderer can paint first', async () => {
    const { store, data } = makeStore();
    data.tokenEnc = Buffer.from('CIPHER:' + JSON.stringify(SAMPLE_TOKEN), 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);

    let paintTick: 'before-decrypt' | 'after-decrypt' = 'after-decrypt';
    // The production path uses two setImmediate yields before calling
    // decryptString. Schedule a setImmediate callback BEFORE awaiting
    // the decrypt — if the production code yields properly, our marker
    // runs first.
    setImmediate(() => {
      if (!fakeSafeStorage.decryptString.mock.calls.length) {
        paintTick = 'before-decrypt';
      }
    });

    await oauth.getTokenAsync();
    expect(paintTick).toBe('before-decrypt');
  });
});
