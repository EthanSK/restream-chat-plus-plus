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
  });

  it('migrates a legacy plain `token` into encrypted `tokenEnc` on first read', () => {
    const { store, data } = makeStore();
    // Simulate a v0.1.14-and-earlier on-disk layout.
    data.token = { ...SAMPLE_TOKEN };

    const oauth = new OAuthCoordinator(store);
    const got = oauth.getToken();

    expect(got).toEqual(SAMPLE_TOKEN);
    // Legacy key must be wiped — secret only lives in one place.
    expect(data.token).toBeUndefined();
    // Encrypted ciphertext (base64) must now be present.
    expect(typeof data.tokenEnc).toBe('string');
    expect(data.tokenEnc!.length).toBeGreaterThan(0);
    expect(fakeSafeStorage.encryptString).toHaveBeenCalledTimes(1);
  });

  it('round-trips a freshly-stored token through getToken()', () => {
    const { store, data } = makeStore();
    const oauth = new OAuthCoordinator(store);
    // Use the private persistToken path via (oauth as any) — exercised in
    // production by exchangeCode / refresh.
    (oauth as any).persistToken(SAMPLE_TOKEN);

    expect(data.token).toBeUndefined();
    expect(typeof data.tokenEnc).toBe('string');

    // Fresh coordinator instance to prove getToken() decrypts independently.
    const oauth2 = new OAuthCoordinator(store);
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

    // And getToken() still returns the value on next read.
    const oauth2 = new OAuthCoordinator(store);
    expect(oauth2.getToken()).toEqual(SAMPLE_TOKEN);
  });

  it('isAuthenticated() honours the access-token expiry window from the decrypted blob', () => {
    const { store } = makeStore();
    const oauth = new OAuthCoordinator(store);
    (oauth as any).persistToken({
      ...SAMPLE_TOKEN,
      expiresAt: Date.now() - 1000, // expired
    });
    expect(oauth.isAuthenticated()).toBe(false);

    (oauth as any).persistToken({
      ...SAMPLE_TOKEN,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h fresh
    });
    expect(oauth.isAuthenticated()).toBe(true);
  });

  it('returns undefined cleanly when decryption fails (e.g. Keychain rotated)', () => {
    const { store, data } = makeStore();
    // Plant a ciphertext that will fail to decrypt.
    data.tokenEnc = Buffer.from('not-our-format', 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    expect(oauth.getToken()).toBeUndefined();
    expect(oauth.isAuthenticated()).toBe(false);
  });
});
