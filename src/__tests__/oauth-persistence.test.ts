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
    // Plant a ciphertext that will throw on decrypt (our mock throws when
    // the input doesn't start with the CIPHER: prefix).
    data.tokenEnc = Buffer.from('not-our-format', 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    // v0.1.38: async path is the one that actually attempts decrypt.
    // v0.1.52: throw case PRESERVES the blob — assertion focuses on the
    // signed-out outcome of the call.
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
//   2. `getTokenAsync()` enforces a 30-second timeout on decrypt (raised
//      from 2s in v0.1.52). When a SecurityAgent prompt keeps the syscall
//      pending past the timeout we surface signed-out for THIS launch but
//      PRESERVE the blob — next launch's decrypt succeeds once the user
//      has clicked Allow.
//   3. Only an actual decrypt THROW (bad ciphertext, JSON parse error,
//      missing accessToken) wipes the blob — that's the genuine ACL-drift
//      case where the next launch wouldn't help either.
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

  it('v0.1.52: decrypt THROW preserves tokenEnc (no wipe) but disables further decrypt attempts for this launch', async () => {
    // v0.1.52 changes the wipe-on-throw behaviour: a Sparkle in-place
    // update can trigger a transient "User canceled / ACL mismatch"
    // throw from safeStorage.decryptString on the first decrypt of
    // the new binary, even though the user clicks Allow on the
    // SecurityAgent prompt. The pre-v0.1.52 code wiped the blob in
    // this case → user signed out every update. v0.1.52 preserves
    // the blob so a subsequent launch (with the user's "Always Allow"
    // grant now in place) decrypts successfully.
    const { store, data } = makeStore();
    fakeSafeStorage.decryptString.mockImplementation(() => {
      throw new Error('User denied access to Keychain');
    });
    data.tokenEnc = 'whatever';

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.getTokenAsync()).toBeUndefined();
    // KEY ASSERTION (v0.1.52): blob is PRESERVED.
    expect(data.tokenEnc).toBe('whatever');

    // A second call within the same launch must NOT re-attempt decrypt
    // (and therefore must NOT bug the user with a second prompt).
    fakeSafeStorage.decryptString.mockClear();
    expect(await oauth.getTokenAsync()).toBeUndefined();
    expect(fakeSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('v0.1.52: genuinely corrupt blob (unparseable plaintext) DOES wipe tokenEnc', async () => {
    // The one case where the v0.1.52 wipe still fires: the decrypt
    // succeeded but the plaintext is junk (bad JSON or missing
    // accessToken). Retrying would just fail the same way every launch,
    // so wiping unlocks a fresh OAuth attempt.
    const { store, data } = makeStore();
    fakeSafeStorage.decryptString.mockImplementation(() => 'not json at all');
    data.tokenEnc = 'whatever';

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.getTokenAsync()).toBeUndefined();
    expect(data.tokenEnc).toBeUndefined();
  });

  it('v0.1.52: SAFE_STORAGE_DECRYPT_TIMEOUT_MS is at least 10s (was 2s — too short for SecurityAgent prompt)', async () => {
    // Read the value via a fresh import so we're not coupled to the
    // internal export name; we just want to assert the timeout is large
    // enough for a real user to click Allow on the SecurityAgent prompt.
    // v0.1.52 raises it from 2s → 30s. Anything <10s would still
    // regression-trigger the "wiped before the user could react" bug.
    const sourceText = (
      await import('node:fs')
    ).readFileSync(
      new URL('../main/oauth.ts', import.meta.url),
      'utf8',
    );
    const match = sourceText.match(
      /SAFE_STORAGE_DECRYPT_TIMEOUT_MS\s*=\s*([0-9_]+)/,
    );
    expect(match).not.toBeNull();
    const ms = Number(match![1].replace(/_/g, ''));
    expect(ms).toBeGreaterThanOrEqual(10_000);
  });

  it('after decrypt throw, a fresh authenticate() OVERWRITES the stale tokenEnc and re-enables decrypt', async () => {
    // v0.1.52: throw path PRESERVES the blob (vs pre-v0.1.52 wipe), so
    // the stale blob is still present after the first failed decrypt.
    // A fresh OAuth round-trip simply overwrites it via persistToken.
    const { store, data } = makeStore();
    fakeSafeStorage.decryptString.mockImplementation(() => {
      throw new Error('User denied access to Keychain');
    });
    data.tokenEnc = 'whatever';

    const oauth = new OAuthCoordinator(store);
    expect(await oauth.getTokenAsync()).toBeUndefined();
    // v0.1.52: blob preserved on throw.
    expect(data.tokenEnc).toBe('whatever');

    // Simulate the user completing the OAuth flow — persistToken
    // overwrites the stale blob.
    (oauth as any).persistToken(SAMPLE_TOKEN);
    expect(typeof data.tokenEnc).toBe('string');
    // The new blob is the encrypted form of SAMPLE_TOKEN, not 'whatever'.
    expect(data.tokenEnc).not.toBe('whatever');
    // Sync getToken now returns the cached value (no decrypt attempt).
    expect(oauth.getToken()).toEqual(SAMPLE_TOKEN);
    expect(oauth.isAuthenticated()).toBe(true);
  });

  it('v0.1.52: token survives a "simulated Sparkle update" cycle — throw on first decrypt, success on retry', async () => {
    // Simulates the production scenario: post-update, the new binary's
    // first decrypt syscall fires SecurityAgent → the user clicks Allow
    // but Electron surfaces a transient "User canceled" throw anyway
    // (common partition_id-mismatch case). Pre-v0.1.52 we wiped the
    // blob on throw → user signed out next launch. v0.1.52 preserves
    // the blob so the next launch decrypts cleanly.
    const { store, data } = makeStore();
    data.tokenEnc = Buffer.from(
      'CIPHER:' + JSON.stringify(SAMPLE_TOKEN),
      'utf8',
    ).toString('base64');

    // First launch's decrypt throws — Sparkle ACL-mismatch case.
    fakeSafeStorage.decryptString.mockImplementationOnce(() => {
      throw new Error('User canceled the access prompt');
    });

    const launch1 = new OAuthCoordinator(store);
    expect(await launch1.getTokenAsync()).toBeUndefined();
    // KEY ASSERTION (v0.1.52): blob preserved across the launch1 throw.
    expect(data.tokenEnc).toBeTruthy();
    const blobBefore = data.tokenEnc;

    // Second launch: decrypt now succeeds (user has clicked Always
    // Allow during launch 1 so the partition_id ACL is in place).
    fakeSafeStorage.decryptString.mockImplementation((buf: Buffer) => {
      const raw = buf.toString('utf8');
      if (!raw.startsWith('CIPHER:')) throw new Error('bad ciphertext');
      return raw.slice('CIPHER:'.length);
    });
    const launch2 = new OAuthCoordinator(store);
    const launch2Token = await launch2.getTokenAsync();
    expect(launch2Token).toEqual(SAMPLE_TOKEN);
    expect(launch2.isAuthenticated()).toBe(true);
    // Same blob as before — no rewrites happened in between.
    expect(data.tokenEnc).toBe(blobBefore);
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
