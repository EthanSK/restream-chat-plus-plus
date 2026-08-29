import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  UpdateBanner,
  updateBannerState,
  type StartDownloadResult,
} from '../renderer/UpdateBanner';
import type { UpdateInfo } from '../shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const available: UpdateInfo = {
  kind: 'available',
  currentVersion: '0.1.107',
  latestVersion: '0.1.108',
  releaseUrl: 'https://example.invalid/v0.1.108',
  checkedAt: 1,
};

function text(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : text(child)))
    .join('');
}

function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('button')
    .find((candidate) => text(candidate) === label);
}

async function render(
  info: UpdateInfo,
  onStartDownload = vi.fn(async (): Promise<StartDownloadResult> => ({
    ok: true,
    reason: 'started',
    mode: 'squirrel',
  })),
  onRestart = vi.fn(async () => ({ ok: true })),
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <UpdateBanner
        info={info}
        dismissed={false}
        onDismiss={vi.fn()}
        onStartDownload={onStartDownload}
        onRestart={onRestart}
      />,
    );
  });
  return { renderer, onStartDownload, onRestart };
}

describe('UpdateBanner visible updater flow', () => {
  it('uses an honest Download Update action and never shows the obsolete blue toast', async () => {
    const { renderer, onStartDownload } = await render(available);
    const download = button(renderer, 'Download Update');
    expect(download).toBeDefined();

    await act(async () => {
      download!.props.onClick();
    });

    expect(onStartDownload).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ className: 'update-banner-toast' })).toHaveLength(0);
    expect(button(renderer, 'Download Update')).toBeDefined();
  });

  it('renders visible progress immediately after the controller enters downloading', async () => {
    const { renderer, onStartDownload, onRestart } = await render(available);
    const downloading: UpdateInfo = {
      ...available,
      kind: 'downloading',
      downloadStartedAt: Date.now(),
      downloadPercent: 37,
    };
    await act(async () => {
      renderer.update(
        <UpdateBanner
          info={downloading}
          dismissed={false}
          onDismiss={vi.fn()}
          onStartDownload={onStartDownload}
          onRestart={onRestart}
        />,
      );
    });

    expect(updateBannerState(downloading, false)).toBe('downloading');
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(37);
    expect(button(renderer, 'Download Update')).toBeUndefined();
  });

  it('offers one Restart & Install action only after staging', async () => {
    const ready: UpdateInfo = {
      ...available,
      kind: 'ready-to-install',
    };
    const onRestart = vi.fn(async () => ({ ok: true }));
    const { renderer } = await render(ready, undefined, onRestart);
    const restart = button(renderer, 'Restart & Install');
    expect(restart).toBeDefined();

    await act(async () => {
      restart!.props.onClick();
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('renders installation as a terminal busy state with no repeat button', async () => {
    const installing: UpdateInfo = {
      ...available,
      kind: 'installing',
    };
    const { renderer } = await render(installing);
    expect(updateBannerState(installing, false)).toBe('installing');
    expect(text(renderer.root)).toContain('Installing update');
    expect(renderer.root.findAllByType('button')).toHaveLength(0);
  });
});
