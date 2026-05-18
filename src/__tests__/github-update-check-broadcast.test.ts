import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UpdateInfo } from '../shared/types';

/**
 * v0.1.35 regression test — the "Checking for updates…" spinner used to get
 * stuck forever when two consecutive polls both resolved to the same
 * terminal `up-to-date` state.
 *
 * Pre-v0.1.35 mechanism in `src/main/github-update-check.ts`:
 *   1. `performGithubUpdateCheck()` raw-pushes a `checking` payload to the
 *      renderer (bypassing `broadcast()` so it doesn't poison the
 *      `lastInfo` cache used by the on-mount pull-fetch).
 *   2. `fetch()` resolves. `broadcast()` is called with the terminal
 *      payload (`up-to-date` / `available` / `error`).
 *   3. `broadcast()` compares the new payload against `lastBroadcast`. If
 *      `kind === lastBroadcast.kind && latestVersion === ... && error === ...`
 *      it SILENTLY SKIPS the send (so an hourly poll that keeps resolving
 *      to `up-to-date` doesn't spam the renderer with identical
 *      "no-banner" payloads).
 *   4. Bug: on the first poll, `lastBroadcast` is undefined, so the first
 *      terminal payload is sent. `lastBroadcast` is now `up-to-date`. On
 *      the SECOND poll (or the user's "Check for Updates Now" menu click),
 *      the raw `checking` push reaches the renderer, then the fetch
 *      resolves to `up-to-date` AGAIN — but the equality check kills the
 *      send. Renderer is now stuck on the `checking` payload it received
 *      in step 1 and never learns the check resolved. Banner spinner
 *      spins forever.
 *
 * Fix: at the same point we raw-push `checking` to the renderer, we also
 * mutate `lastBroadcast = checkingInfo`. The post-fetch `broadcast()` call
 * sees `lastBroadcast.kind === 'checking'`, the new payload's `kind` is
 * always a terminal value (`up-to-date` / `available` / `error`), so the
 * "skip unchanged" guard never fires after a check. `lastInfo` is left
 * alone — the on-mount pull-fetch still returns the last TERMINAL state.
 *
 * This test exercises the bug end-to-end by stubbing Electron's
 * `BrowserWindow.getAllWindows()` and `app.getVersion()`, and stubbing
 * the global `fetch`. We assert: across TWO consecutive
 * `performGithubUpdateCheck()` calls that both resolve `up-to-date`, the
 * renderer receives `checking → up-to-date` BOTH times — not
 * `checking → up-to-date → checking → (silence)`.
 */

interface CapturedPayload {
  channel: string;
  payload: UpdateInfo;
}

const sentToRenderer: CapturedPayload[] = [];

vi.mock('electron', () => {
  // Single fake BrowserWindow whose webContents.send captures every IPC
  // payload pushed at the renderer.
  const fakeWindow = {
    webContents: {
      send(channel: string, payload: UpdateInfo): void {
        sentToRenderer.push({ channel, payload });
      },
    },
  };
  return {
    app: {
      getVersion: () => '0.1.34',
    },
    BrowserWindow: {
      getAllWindows: () => [fakeWindow],
    },
  };
});

// electron-log/main writes to disk + console — we don't care about output
// during tests, just that no method throws.
vi.mock('electron-log/main', () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

describe('github-update-check broadcast (v0.1.35 stuck-spinner fix)', () => {
  beforeEach(() => {
    sentToRenderer.length = 0;
    // The module under test caches state at module level (lastBroadcast /
    // lastInfo). resetModules() forces a fresh import per test so each
    // case starts with an empty cache.
    vi.resetModules();
  });

  it('sends checking → up-to-date on every consecutive identical poll', async () => {
    // Stub fetch to return a release whose tag equals the running version
    // so isNewerVersion() returns false and broadcast() resolves to
    // `up-to-date` each time. A fresh Response per call — the body stream
    // on `Response` can only be consumed once, so reusing a single
    // Response across multiple fetches throws on the second `.json()`.
    const fakeFetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v0.1.34',
            html_url: 'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.34',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fakeFetch);

    const { performGithubUpdateCheck } = await import('../main/github-update-check');

    // First poll — fresh module, lastBroadcast === undefined.
    await performGithubUpdateCheck(true);

    const firstRun = sentToRenderer.map((c) => c.payload.kind);
    // Expect: raw `checking` push, then `up-to-date` from broadcast().
    expect(firstRun).toEqual(['checking', 'up-to-date']);

    // Second poll — lastBroadcast === 'up-to-date' (well, the
    // mutate-to-checking happens first, then broadcast resolves to
    // up-to-date — which is what we're testing). Without the fix:
    // sequence would be ['checking'] only — the broadcast() skipped the
    // identical-payload up-to-date and the renderer stuck on `checking`.
    sentToRenderer.length = 0;
    await performGithubUpdateCheck(true);
    const secondRun = sentToRenderer.map((c) => c.payload.kind);
    expect(secondRun).toEqual(['checking', 'up-to-date']);
  });

  it('sends checking → error on a repeated non-2xx response', async () => {
    // Same shape, different terminal — verify the fix covers `error` too.
    const fakeFetch = vi.fn().mockImplementation(
      async () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    vi.stubGlobal('fetch', fakeFetch);

    const { performGithubUpdateCheck } = await import('../main/github-update-check');
    await performGithubUpdateCheck(true);
    expect(sentToRenderer.map((c) => c.payload.kind)).toEqual([
      'checking',
      'error',
    ]);

    sentToRenderer.length = 0;
    await performGithubUpdateCheck(true);
    expect(sentToRenderer.map((c) => c.payload.kind)).toEqual([
      'checking',
      'error',
    ]);
  });

  it('sends checking → available when a newer release appears', async () => {
    const fakeFetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.2.0',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fakeFetch);

    const { performGithubUpdateCheck } = await import('../main/github-update-check');
    await performGithubUpdateCheck(true);
    expect(sentToRenderer.map((c) => c.payload.kind)).toEqual([
      'checking',
      'available',
    ]);
  });
});
