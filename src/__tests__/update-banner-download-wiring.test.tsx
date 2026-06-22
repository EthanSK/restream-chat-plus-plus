import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { UpdateBanner } from '../renderer/UpdateBanner';
import type { UpdateInfo } from '../shared/types';

/**
 * v0.1.32 — the "Download" button in the `available` banner state used to
 * fire `onDownload(releaseUrl)` which navigated the user's default
 * browser to the GitHub release page (via the preload `rcpp.openExternal`
 * IPC). That side-stepped the entire Squirrel in-app pipeline (progress
 * bar → restart-to-install) we'd already wired in v0.1.25.
 *
 * The new prop is `onStartDownload()` — no URL parameter, no browser
 * bounce. It fires `IPC.UPDATE_DOWNLOAD_START` in main → Squirrel
 * `autoUpdater.checkForUpdates()` → the existing progress forwarders
 * carry the rest of the flow.
 *
 * v0.1.39: the banner now uses React state (`installing`, `toast`) so we
 * can't call the component as a plain function any more. We render via
 * `react-test-renderer` + `act()` so hooks work — same approach as
 * `update-banner-installing-state.test.tsx`.
 */

type TestInstance = TestRenderer.ReactTestInstance;

function instanceText(inst: TestInstance): string {
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
      if (ti.children) {
        ti.children.forEach(visit);
      }
    }
  };
  inst.children?.forEach(visit);
  return acc.join('');
}

function availableInfo(): UpdateInfo {
  return {
    kind: 'available',
    currentVersion: '0.1.31',
    latestVersion: '0.1.32',
    releaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.32',
    checkedAt: 1_700_000_000_000,
  };
}

describe('UpdateBanner — Install Update button wiring (v0.1.32, relabelled v0.1.37)', () => {
  it('clicking Install Update fires onStartDownload (in-app pipeline), NOT a URL opener', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: true,
      reason: 'started',
      mode: 'squirrel',
    });
    const onDismiss = vi.fn();
    const onRestart = vi.fn().mockResolvedValue({ ok: true });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <UpdateBanner
          info={availableInfo()}
          dismissed={false}
          onDismiss={onDismiss}
          onStartDownload={onStartDownload}
          onRestart={onRestart}
        />,
      );
    });

    const download = renderer.root
      .findAllByType('button')
      .find((b) => instanceText(b).includes('Install Update'));
    expect(
      download,
      'Install Update button must be present in `available` state',
    ).toBeDefined();

    await act(async () => {
      download!.props.onClick();
    });

    expect(onStartDownload).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();

    // No release URL is passed through to the renderer's handler — the
    // signature is parameter-less so a future refactor can't reintroduce
    // the URL-opening browser bounce.
    expect(onStartDownload).toHaveBeenCalledWith();

    renderer.unmount();
  });

  it('Later button fires onDismiss (unchanged from v0.1.25)', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: true,
      reason: 'started',
      mode: 'squirrel',
    });
    const onDismiss = vi.fn();
    const onRestart = vi.fn().mockResolvedValue({ ok: true });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <UpdateBanner
          info={availableInfo()}
          dismissed={false}
          onDismiss={onDismiss}
          onStartDownload={onStartDownload}
          onRestart={onRestart}
        />,
      );
    });

    const later = renderer.root
      .findAllByType('button')
      .find((b) => instanceText(b) === 'Later');
    expect(later).toBeDefined();

    await act(async () => {
      later!.props.onClick();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onStartDownload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('Restart button in ready-to-install fires onRestart (unchanged from v0.1.25)', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: true,
      reason: 'started',
      mode: 'squirrel',
    });
    const onDismiss = vi.fn();
    const onRestart = vi.fn().mockResolvedValue({ ok: true });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <UpdateBanner
          info={{
            kind: 'ready-to-install',
            currentVersion: '0.1.31',
            latestVersion: '0.1.32',
            checkedAt: 1_700_000_000_000,
          }}
          dismissed={false}
          onDismiss={onDismiss}
          onStartDownload={onStartDownload}
          onRestart={onRestart}
        />,
      );
    });

    const restart = renderer.root
      .findAllByType('button')
      .find((b) => instanceText(b) === 'Restart');
    expect(restart).toBeDefined();

    await act(async () => {
      restart!.props.onClick();
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onStartDownload).not.toHaveBeenCalled();

    renderer.unmount();
  });
});
