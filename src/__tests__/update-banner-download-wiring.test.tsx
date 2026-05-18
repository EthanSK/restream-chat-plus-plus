import { describe, it, expect, vi } from 'vitest';
import React from 'react';
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
 * This test pins the wiring at the component-output level so an
 * accidental rename / signature regression (e.g. someone re-adds the
 * URL parameter or re-wires it to `openExternal`) is caught at CI time.
 *
 * Vitest runs under `environment: node` — no jsdom, no react-dom — so
 * we call `UpdateBanner` as a plain function and traverse the returned
 * React element tree. That's enough to read each child's `onClick`
 * handler and invoke it directly without rendering to a real DOM.
 */

/**
 * Recursively walk a React element tree and collect every <button>
 * element. We need `any` for the React.Children typing because the
 * tree here is hand-built JSX where the children prop is typed
 * `ReactNode` and the recursion needs `props.children` access.
 */
function collectButtons(
  node: React.ReactNode,
  out: React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }>[] = [],
): React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }>[] {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out);
    return out;
  }
  const el = node as React.ReactElement<{
    onClick?: () => void;
    children?: React.ReactNode;
  }>;
  if (el.type === 'button') {
    out.push(el);
  }
  if (el.props && 'children' in el.props) {
    collectButtons(el.props.children, out);
  }
  return out;
}

function flattenText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  const el = node as React.ReactElement<{ children?: React.ReactNode }>;
  return flattenText(el.props?.children);
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
  it('clicking Install Update fires onStartDownload (in-app pipeline), NOT a URL opener', () => {
    const onStartDownload = vi.fn();
    const onDismiss = vi.fn();
    const onRestart = vi.fn();

    const tree = UpdateBanner({
      info: availableInfo(),
      dismissed: false,
      onDismiss,
      onStartDownload,
      onRestart,
    });

    expect(tree).not.toBeNull();
    const buttons = collectButtons(tree);
    const download = buttons.find(
      (b) => flattenText(b.props.children) === 'Install Update',
    );
    expect(
      download,
      'Install Update button must be present in `available` state',
    ).toBeDefined();

    // Invoke the actual onClick — must call onStartDownload, must not
    // invoke any other callback (no auto-dismiss on click in v0.1.32:
    // the banner transitions to `downloading` once Squirrel emits its
    // first `download-progress` event, which flips info.kind for us).
    download!.props.onClick!();
    expect(onStartDownload).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();

    // No release URL is passed through to the renderer's handler — the
    // signature is parameter-less so a future refactor can't reintroduce
    // the URL-opening browser bounce.
    expect(onStartDownload).toHaveBeenCalledWith();
  });

  it('Later button fires onDismiss (unchanged from v0.1.25)', () => {
    const onStartDownload = vi.fn();
    const onDismiss = vi.fn();
    const onRestart = vi.fn();

    const tree = UpdateBanner({
      info: availableInfo(),
      dismissed: false,
      onDismiss,
      onStartDownload,
      onRestart,
    });

    const later = collectButtons(tree).find(
      (b) => flattenText(b.props.children) === 'Later',
    );
    expect(later).toBeDefined();
    later!.props.onClick!();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onStartDownload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('Restart button in ready-to-install fires onRestart (unchanged from v0.1.25)', () => {
    const onStartDownload = vi.fn();
    const onDismiss = vi.fn();
    const onRestart = vi.fn();

    const tree = UpdateBanner({
      info: {
        kind: 'ready-to-install',
        currentVersion: '0.1.31',
        latestVersion: '0.1.32',
        checkedAt: 1_700_000_000_000,
      },
      dismissed: false,
      onDismiss,
      onStartDownload,
      onRestart,
    });

    const restart = collectButtons(tree).find(
      (b) => flattenText(b.props.children) === 'Restart',
    );
    expect(restart).toBeDefined();
    restart!.props.onClick!();
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onStartDownload).not.toHaveBeenCalled();
  });
});
