import { describe, it, expect } from 'vitest';
import { updateBannerState } from '../renderer/UpdateBanner';
import type { UpdateInfo } from '../shared/types';

/**
 * v0.1.25 expanded the update banner from a single `available` state to
 * four: `checking`, `available`, `downloading`, `ready-to-install`. The
 * pure `updateBannerState` reducer keeps the state machine testable
 * without a real DOM (vitest runs under `environment: node`). These
 * tests pin every transition so a regression in the kind→state mapping
 * — easy to introduce when adding a fifth state later — gets caught
 * before it ships.
 */

function info(patch: Partial<UpdateInfo> & { kind: UpdateInfo['kind'] }): UpdateInfo {
  return {
    currentVersion: '0.1.24',
    checkedAt: 1_700_000_000_000,
    ...patch,
  };
}

describe('updateBannerState — hidden cases', () => {
  it('hides when info is null', () => {
    expect(updateBannerState(null, false)).toBe('hidden');
    expect(updateBannerState(null, true)).toBe('hidden');
  });

  it('hides for up-to-date (silent happy path)', () => {
    expect(updateBannerState(info({ kind: 'up-to-date' }), false)).toBe('hidden');
  });

  it('hides for disabled (auto-check toggled off)', () => {
    expect(updateBannerState(info({ kind: 'disabled' }), false)).toBe('hidden');
  });

  it('hides for error (logged elsewhere, no banner)', () => {
    expect(
      updateBannerState(info({ kind: 'error', error: 'GH 404' }), false),
    ).toBe('hidden');
  });
});

describe('updateBannerState — checking', () => {
  it('shows the checking spinner regardless of dismissed flag', () => {
    expect(updateBannerState(info({ kind: 'checking' }), false)).toBe('checking');
    // `dismissed` only applies to `available` — checking always shows so
    // the user sees the manual "Check Now" round-trip in flight.
    expect(updateBannerState(info({ kind: 'checking' }), true)).toBe('checking');
  });
});

describe('updateBannerState — available', () => {
  it('shows when an update is available and not dismissed', () => {
    expect(
      updateBannerState(
        info({
          kind: 'available',
          latestVersion: '0.1.25',
          releaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.25',
        }),
        false,
      ),
    ).toBe('available');
  });

  it('hides when dismissed', () => {
    expect(
      updateBannerState(
        info({
          kind: 'available',
          latestVersion: '0.1.25',
          releaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases',
        }),
        true,
      ),
    ).toBe('hidden');
  });

  it('hides when payload is malformed (missing latestVersion)', () => {
    expect(
      updateBannerState(
        info({ kind: 'available', releaseUrl: 'https://example.com' }),
        false,
      ),
    ).toBe('hidden');
  });

  it('hides when payload is malformed (missing releaseUrl)', () => {
    expect(
      updateBannerState(info({ kind: 'available', latestVersion: '0.1.25' }), false),
    ).toBe('hidden');
  });
});

describe('updateBannerState — downloading', () => {
  it('shows downloading regardless of dismissed flag', () => {
    // Once Squirrel starts pulling the bundle, hiding the progress bar
    // would leave the user wondering whether something is happening.
    expect(
      updateBannerState(info({ kind: 'downloading', downloadPercent: 42 }), false),
    ).toBe('downloading');
    expect(
      updateBannerState(info({ kind: 'downloading', downloadPercent: 42 }), true),
    ).toBe('downloading');
  });

  it('shows downloading even when no percent has been reported yet', () => {
    // The very first event from Squirrel may not include `percent`.
    // The component renders an indeterminate bar in that case; the
    // state-machine doesn't need to know.
    expect(updateBannerState(info({ kind: 'downloading' }), false)).toBe(
      'downloading',
    );
  });
});

describe('updateBannerState — ready-to-install', () => {
  it('shows ready-to-install regardless of dismissed flag', () => {
    // Even if the user previously dismissed the `available` banner,
    // once the download has staged we want the Restart button visible.
    expect(
      updateBannerState(info({ kind: 'ready-to-install', latestVersion: '0.1.25' }), false),
    ).toBe('ready-to-install');
    expect(
      updateBannerState(info({ kind: 'ready-to-install', latestVersion: '0.1.25' }), true),
    ).toBe('ready-to-install');
  });

  it('shows ready-to-install even when latestVersion is missing', () => {
    // Squirrel.Mac sometimes omits `releaseName` from the
    // `update-downloaded` event — the UI falls back to "Update ready"
    // without a version suffix in that case, but the state itself is
    // still valid.
    expect(updateBannerState(info({ kind: 'ready-to-install' }), false)).toBe(
      'ready-to-install',
    );
  });
});

describe('updateBannerState — full transition sequence', () => {
  it('walks through the canonical Squirrel signed-build flow', () => {
    // 1. Initial check fires — spinner.
    const checking = info({ kind: 'checking' });
    expect(updateBannerState(checking, false)).toBe('checking');

    // 2. GH says "0.1.25 is out" — banner with Download button.
    const available = info({
      kind: 'available',
      latestVersion: '0.1.25',
      releaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.25',
    });
    expect(updateBannerState(available, false)).toBe('available');

    // 3. Squirrel starts pulling the bundle — progress bar.
    const dl0 = info({ kind: 'downloading' });
    expect(updateBannerState(dl0, false)).toBe('downloading');
    const dl50 = info({ kind: 'downloading', downloadPercent: 50 });
    expect(updateBannerState(dl50, false)).toBe('downloading');
    const dl99 = info({ kind: 'downloading', downloadPercent: 99.8 });
    expect(updateBannerState(dl99, false)).toBe('downloading');

    // 4. Download finishes — Restart button.
    const ready = info({ kind: 'ready-to-install', latestVersion: '0.1.25' });
    expect(updateBannerState(ready, false)).toBe('ready-to-install');
  });

  it('downloading state ignores a stale dismiss from the available state', () => {
    // User dismissed the `available` banner, then Squirrel's download
    // event arrives. The progress bar MUST appear regardless. Pairs
    // with App.tsx's auto-reset of `updateDismissed` on transition to
    // `downloading`/`ready-to-install`, but the reducer itself also
    // ignores `dismissed` for these states as belt-and-braces.
    const dl = info({ kind: 'downloading', downloadPercent: 10 });
    expect(updateBannerState(dl, true)).toBe('downloading');

    const ready = info({ kind: 'ready-to-install' });
    expect(updateBannerState(ready, true)).toBe('ready-to-install');
  });
});
