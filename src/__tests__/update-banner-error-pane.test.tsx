/**
 * v0.1.61 — renderer-side coverage for the new banner states added
 * alongside the immediate-downloading + Squirrel-error broadcasts.
 *
 * Three layers exercised here:
 *
 *   1. The pure `decideErrorCopy(info)` helper — maps `errorCategory` +
 *      `error` + `latestVersion` to the headline / detail / button
 *      label the banner renders. Lets us pin the user-facing wording
 *      contract at the cheapest possible layer.
 *
 *   2. The `updateBannerState(info, dismissed)` reducer — now returns
 *      'error' when `info.kind === 'error'` AND `info.errorReleaseUrl`
 *      is populated. Other error payloads (GH-Releases-poller network
 *      blips) remain hidden.
 *
 *   3. The `<UpdateBanner>` render — drives a Squirrel signature-
 *      mismatch error UpdateInfo and asserts the persistent error
 *      pane renders with the right headline + manual-fallback button
 *      label. Uses `react-test-renderer` + `act()` matching the
 *      existing `update-banner-installing-state.test.tsx` setup.
 *
 *   4. The `<UpdateBanner>` downloading pane renders bytes + speed +
 *      elapsed time when those fields are populated. Pinned so the
 *      regression catches if someone reverts the DownloadingPane
 *      component back to the percent-only layout.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  UpdateBanner,
  updateBannerState,
  decideErrorCopy,
  formatBytes,
  formatSpeed,
} from '../renderer/UpdateBanner';
import type { UpdateInfo } from '../shared/types';

const noop = (): void => undefined;

function errorInfo(patch: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    kind: 'error',
    currentVersion: '0.1.59',
    latestVersion: '0.1.60',
    error: 'Code signature did not pass validation',
    errorCategory: 'signature-mismatch',
    errorReleaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases',
    checkedAt: 1_700_000_000_000,
    ...patch,
  };
}

function downloadingInfo(patch: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    kind: 'downloading',
    currentVersion: '0.1.59',
    latestVersion: '0.1.60',
    downloadPercent: 42,
    downloadBytesTransferred: 5_242_880, // 5 MB
    downloadBytesTotal: 12_582_912, // 12 MB
    downloadBytesPerSecond: 524_288, // 512 KB/s
    downloadStartedAt: Date.now() - 3000,
    checkedAt: 1_700_000_000_000,
    ...patch,
  };
}

describe('decideErrorCopy — user-facing wording per errorCategory', () => {
  it('signature-mismatch → "Couldn\'t auto-install" + manual reinstall guidance', () => {
    const copy = decideErrorCopy(errorInfo({ errorCategory: 'signature-mismatch' }));
    expect(copy.headline).toContain("Couldn't auto-install");
    expect(copy.headline).toContain('0.1.60');
    expect(copy.detail).toMatch(/signed differently|in-place swap|reinstall/i);
    expect(copy.buttonLabel).toBe('Open GitHub Releases');
  });

  it('network → mentions network + recovery', () => {
    const copy = decideErrorCopy(errorInfo({ errorCategory: 'network' }));
    expect(copy.headline).toContain('Update download failed');
    expect(copy.detail).toMatch(/network|connection/i);
  });

  it('staging → mentions disk / permissions', () => {
    const copy = decideErrorCopy(errorInfo({ errorCategory: 'staging' }));
    expect(copy.headline).toContain('staged');
    expect(copy.detail).toMatch(/disk|permissions|ShipIt/i);
  });

  it('unknown → falls back to the raw error string', () => {
    const copy = decideErrorCopy(
      errorInfo({ errorCategory: 'unknown', error: 'gizmo broke' }),
    );
    expect(copy.headline).toContain('Update failed');
    expect(copy.detail).toContain('gizmo broke');
  });

  it('missing errorCategory + missing error → generic fallback', () => {
    const copy = decideErrorCopy(
      errorInfo({ errorCategory: undefined, error: undefined }),
    );
    expect(copy.detail.length).toBeGreaterThan(0);
  });
});

describe('updateBannerState — error visibility', () => {
  it('shows error state for Squirrel-side errors with errorReleaseUrl', () => {
    expect(updateBannerState(errorInfo(), false)).toBe('error');
  });

  it('hides error pane when user has dismissed it', () => {
    expect(updateBannerState(errorInfo(), true)).toBe('hidden');
  });

  it('hides error pane when the payload lacks errorReleaseUrl (GH-poller network blip)', () => {
    // The GH-Releases poller broadcasts `kind: 'error'` on transient
    // network failures with no errorReleaseUrl. Those must stay
    // silent — a flaky wifi blip should not throw a red error pane.
    expect(
      updateBannerState(
        errorInfo({ errorReleaseUrl: undefined, errorCategory: undefined }),
        false,
      ),
    ).toBe('hidden');
  });
});

describe('formatBytes / formatSpeed pure helpers', () => {
  it('formats bytes in B / KB / MB / GB tiers', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1_048_576)).toBe('1.00 MB');
    expect(formatBytes(12_582_912)).toBe('12.0 MB');
    expect(formatBytes(1_073_741_824)).toBe('1.00 GB');
  });

  it('returns empty string for invalid input', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });

  it('formats speed as <bytes>/s', () => {
    expect(formatSpeed(1024)).toBe('1.0 KB/s');
    expect(formatSpeed(undefined)).toBe('');
  });
});

type TestInstance = TestRenderer.ReactTestInstance;

function instanceText(inst: TestInstance | undefined): string {
  if (!inst) return '';
  const acc: string[] = [];
  const visit = (node: unknown): void => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string') {
      acc.push(node);
      return;
    }
    if (typeof node === 'number') {
      acc.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      const ti = node as TestInstance;
      if (ti.children) ti.children.forEach(visit);
    }
  };
  inst.children?.forEach(visit);
  return acc.join('');
}

describe('<UpdateBanner> — error pane render', () => {
  it('renders headline + detail + Open GitHub Releases button for signature mismatch', () => {
    let root: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      root = TestRenderer.create(
        <UpdateBanner
          info={errorInfo()}
          dismissed={false}
          onDismiss={noop}
          onStartDownload={() =>
            Promise.resolve({
              ok: true as const,
              reason: 'started' as const,
              mode: 'squirrel' as const,
            })
          }
          onRestart={async () => ({ ok: true })}
        />,
      );
    });
    if (!root) throw new Error('renderer not created');

    const text = instanceText(root.root);
    expect(text).toContain("Couldn't auto-install update");
    expect(text).toContain('0.1.60');

    const buttons = root.root.findAllByType('button');
    const labels = buttons.map((b) => instanceText(b));
    expect(labels).toContain('Open GitHub Releases');
    expect(labels).toContain('Dismiss');

    act(() => {
      root!.unmount();
    });
  });

  it('Dismiss button calls onDismiss', () => {
    let dismissed = 0;
    let root: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      root = TestRenderer.create(
        <UpdateBanner
          info={errorInfo()}
          dismissed={false}
          onDismiss={() => {
            dismissed += 1;
          }}
          onStartDownload={() =>
            Promise.resolve({
              ok: true as const,
              reason: 'started' as const,
              mode: 'squirrel' as const,
            })
          }
          onRestart={async () => ({ ok: true })}
        />,
      );
    });
    if (!root) throw new Error('renderer not created');

    const buttons = root.root.findAllByType('button');
    const dismissBtn = buttons.find((b) => instanceText(b) === 'Dismiss');
    expect(dismissBtn).toBeTruthy();
    act(() => {
      (dismissBtn!.props as { onClick: () => void }).onClick();
    });
    expect(dismissed).toBe(1);

    act(() => {
      root!.unmount();
    });
  });
});

describe('<UpdateBanner> — downloading pane shows bytes + speed + elapsed', () => {
  it('renders bytes / speed / elapsed labels when those fields are populated', () => {
    let root: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      root = TestRenderer.create(
        <UpdateBanner
          info={downloadingInfo()}
          dismissed={false}
          onDismiss={noop}
          onStartDownload={() =>
            Promise.resolve({
              ok: true as const,
              reason: 'started' as const,
              mode: 'squirrel' as const,
            })
          }
          onRestart={async () => ({ ok: true })}
        />,
      );
    });
    if (!root) throw new Error('renderer not created');

    const text = instanceText(root.root);
    // Headline with version
    expect(text).toContain('Downloading Restream Chat++ v0.1.60');
    // Percent
    expect(text).toContain('42%');
    // Bytes downloaded / total (5.00 MB / 12.0 MB)
    expect(text).toMatch(/5\.\d+ MB/);
    expect(text).toMatch(/12\.\d+ MB/);
    // Speed (512 KB/s)
    expect(text).toMatch(/512.*KB\/s/);
    // Elapsed time label is present
    expect(text).toMatch(/elapsed/);

    act(() => {
      root!.unmount();
    });
  });

  it('falls back to indeterminate display when no progress fields populated', () => {
    let root: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      root = TestRenderer.create(
        <UpdateBanner
          info={downloadingInfo({
            downloadPercent: undefined,
            downloadBytesTransferred: undefined,
            downloadBytesTotal: undefined,
            downloadBytesPerSecond: undefined,
          })}
          dismissed={false}
          onDismiss={noop}
          onStartDownload={() =>
            Promise.resolve({
              ok: true as const,
              reason: 'started' as const,
              mode: 'squirrel' as const,
            })
          }
          onRestart={async () => ({ ok: true })}
        />,
      );
    });
    if (!root) throw new Error('renderer not created');

    const text = instanceText(root.root);
    expect(text).toContain('Downloading');
    // The indeterminate placeholder for percent.
    expect(text).toContain('…');
    // No KB/s when bytesPerSecond is undefined.
    expect(text).not.toMatch(/KB\/s|MB\/s/);

    act(() => {
      root!.unmount();
    });
  });
});
