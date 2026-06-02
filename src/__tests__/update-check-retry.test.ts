/**
 * v0.1.85 (voice 7280) — CHECK-RETRY resilience tests.
 *
 * Pins `checkWithQuickRetry()` in `src/main/github-update-check.ts`: the
 * AUTOMATIC poll re-attempts the GH-Releases check on a transient `error`
 * result with a bounded backoff (10s/30s, 2 retries) before settling, so a
 * single network blip at boot / hourly tick doesn't strand the user on an
 * error banner for a full hour.
 *
 * We drive the GH fetch via a mocked global `fetch` and inject a synchronous
 * `delay` so the backoff is deterministic (no real waits).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeApp = vi.hoisted(() => ({
  getVersion: vi.fn(() => '0.1.85'),
  isPackaged: true,
}));

const fakeBrowserWindow = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
}));

vi.mock('electron', () => ({
  app: fakeApp,
  BrowserWindow: fakeBrowserWindow,
}));

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../main/structured-log', () => ({
  appendErrorLog: vi.fn(),
  errorToString: (e: unknown) => String((e as Error)?.message ?? e),
}));

// updater.ts is imported transitively for rememberPendingDownloadVersion.
vi.mock('../main/updater', () => ({
  rememberPendingDownloadVersion: vi.fn(),
}));

async function loadModule() {
  vi.resetModules();
  return await import('../main/github-update-check');
}

// A no-wait delay so the backoff ladder runs instantly under test.
const instantDelay = () => Promise.resolve();

describe('v0.1.85 check-retry resilience', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries the GH check after a transient network failure and returns the recovered result', async () => {
    const { checkWithQuickRetry } = await loadModule();

    // First fetch throws (network blip); second succeeds with an up-to-date
    // release tag matching the running version.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.1.85', html_url: 'https://x/releases' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkWithQuickRetry(instantDelay);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('up-to-date');
  });

  it('returns available without spending retries when the first check succeeds', async () => {
    const { checkWithQuickRetry } = await loadModule();
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v0.2.0', html_url: 'https://x/releases' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkWithQuickRetry(instantDelay);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('available');
  });

  it('exhausts the bounded retry budget (initial + 2 retries = 3 fetches) then settles on error', async () => {
    const { checkWithQuickRetry } = await loadModule();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkWithQuickRetry(instantDelay);
    // initial attempt + CHECK_RETRY_DELAYS_MS.length (2) retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe('error');
  });
});
