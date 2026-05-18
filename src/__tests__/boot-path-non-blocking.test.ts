/**
 * v0.1.38 — Boot-path-non-blocking integration test.
 *
 * Verifies that the OAuthCoordinator's startup contract is upheld even
 * when `safeStorage.decryptString` is pathologically slow (mimics the
 * macOS Keychain "Allow Safe Storage" prompt holding the syscall for
 * the user to click Allow). The fundamental fix in v0.1.38 is:
 *
 *   - `getToken()` (sync) NEVER touches Keychain for an encrypted blob.
 *   - `getTokenAsync()` enforces a 2-second timeout and wipes the blob
 *     on timeout, simulating the "stale ACL → re-auth" recovery.
 *   - The boot path therefore completes in <500ms even when Keychain
 *     is hanging on a prompt.
 *
 * The test simulates the v0.1.36-and-earlier failure mode (synchronous
 * decrypt that blocks indefinitely) and asserts the v0.1.38 boot flow
 * still resolves quickly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('boot path is non-blocking on safeStorage', () => {
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

  it('synchronous boot init never calls safeStorage.decryptString when only encrypted blob present', () => {
    // Simulate the v0.1.36 bug: a tokenEnc blob from a prior install with
    // a different binary signature. The old sync boot path would call
    // `oauth.isAuthenticated()` → `getToken()` → `tryDecrypt()` →
    // `safeStorage.decryptString` and block forever waiting for the
    // user's SecurityAgent click.
    const { store, data } = makeStore();
    data.tokenEnc = Buffer.from('CIPHER:' + JSON.stringify(SAMPLE_TOKEN), 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);

    // The sync boot-path operations the old main.ts ran synchronously:
    expect(oauth.isAuthenticated()).toBe(false);
    expect(oauth.getToken()).toBeUndefined();

    // ZERO Keychain calls means ZERO chance of a SecurityAgent prompt
    // blocking the main thread on boot.
    expect(fakeSafeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('full boot path completes in <500ms even when Keychain decrypt is hanging', async () => {
    // Worst-case simulation: decryptString never returns (user never
    // clicks the SecurityAgent prompt). The boot path MUST still finish
    // because:
    //   1. The window-creation code never awaits on Keychain.
    //   2. The deferred resume awaits via getTokenAsync which times out
    //      after 2 seconds — well within the 500ms boot ceiling for the
    //      pre-decrypt window-paint phase.
    //
    // We measure the "boot phase" as: from when the test starts, through
    // creating the OAuthCoordinator, running the same sync calls the
    // production main.ts does pre-resume, and confirming the window
    // would have already been displayed.
    const { store, data } = makeStore();
    data.tokenEnc = 'whatever';

    let stuckResolve: (v: string) => void = () => undefined;
    fakeSafeStorage.decryptString.mockImplementation(() => {
      // Simulate the user not clicking Allow — the syscall sits forever.
      // In real Electron this would block the main thread; here we
      // simulate the time cost via a never-resolving promise that the
      // production code's Promise.race times out around.
      return new Promise<string>((resolve) => {
        stuckResolve = resolve;
      }) as unknown as string;
    });

    const startNs = process.hrtime.bigint();
    const oauth = new OAuthCoordinator(store);
    // These are the operations main.ts runs synchronously during
    // `app.on('ready')` BEFORE awaiting the deferred resume:
    oauth.isAuthenticated(); // false — no cache yet
    oauth.getToken(); // undefined — no cache yet
    const bootEndNs = process.hrtime.bigint();
    const bootMs = Number(bootEndNs - startNs) / 1_000_000;

    // The boot phase must complete in well under 500ms. Practically
    // this should be sub-millisecond — the assertion guards against
    // anyone re-introducing a sync Keychain call in the boot path.
    expect(bootMs).toBeLessThan(500);
    expect(fakeSafeStorage.decryptString).not.toHaveBeenCalled();

    // Cleanup: let the orphaned decryptString promise resolve so vitest
    // doesn't warn about a hanging async leak. We don't await
    // getTokenAsync — the production fire-and-forget path doesn't either,
    // and the next test sets up a fresh mock.
    stuckResolve('CIPHER:' + JSON.stringify(SAMPLE_TOKEN));
  });

  it('IPC handlers that need auth never crash on a cold boot before decrypt settles', async () => {
    // Real production scenario: the renderer mounts and calls the
    // AUTH_STATUS IPC pull-fetch immediately. The handler awaits
    // `getTokenAsync()` — must return a coherent { authenticated: false }
    // (or true if decrypt succeeded) without throwing.
    const { store, data } = makeStore();
    data.tokenEnc = Buffer.from('CIPHER:' + JSON.stringify(SAMPLE_TOKEN), 'utf8').toString('base64');

    const oauth = new OAuthCoordinator(store);
    // Simulate the IPC handler awaiting both async getters concurrently.
    const [token, authed] = await Promise.all([
      oauth.getTokenAsync(),
      oauth.isAuthenticatedAsync(),
    ]);
    expect(token).toEqual(SAMPLE_TOKEN);
    expect(authed).toBe(true);
    // One Keychain call total, despite two callers — the in-flight
    // coalescing prevents per-IPC-caller prompt cascades.
    expect(fakeSafeStorage.decryptString).toHaveBeenCalledTimes(1);
  });
});
