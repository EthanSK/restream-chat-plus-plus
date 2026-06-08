import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  UpdateBanner,
  decideToast,
  TOAST_AUTO_DISMISS_MS,
  INSTALL_BUTTON_LABEL_IDLE,
  INSTALL_BUTTON_LABEL_INSTALLING,
  type StartDownloadResult,
} from '../renderer/UpdateBanner';
import type { UpdateInfo } from '../shared/types';

/**
 * v0.1.39 — clicking "Install Update" now provides visible feedback:
 *
 *   1. The button immediately flips to a disabled spinner + "Installing…"
 *      so the user knows the IPC click registered (Voice 3369: "I clicked
 *      install update and I don't see anything happening").
 *   2. When the structured `StartDownloadResult` resolves, the button
 *      flips back to "Install Update" and a toast appears in the top-
 *      right of the banner explaining what happened:
 *         - `mode: 'squirrel'` → info toast (v0.1.89: "Update downloading in
 *                                the background — you'll be prompted to
 *                                restart…" — the consolidated flow no longer
 *                                shows a top-bar progress bar)
 *         - `mode: 'browser'`  → info toast, "Opening release page in browser…"
 *         - `ok: false`        → error toast with the underlying message
 *   3. The toast auto-dismisses after TOAST_AUTO_DISMISS_MS (3s).
 *
 * The pure `decideToast(result)` helper is tested directly so the
 * mapping contract is pinned at the cheapest possible layer. The
 * stateful behaviour is tested via `react-test-renderer` + `act()` so
 * we get real `useState`/`useEffect` semantics. The setup file
 * `_setup-react-act-env.ts` flips `globalThis.IS_REACT_ACT_ENVIRONMENT
 * = true` so React 19's act() actually batches.
 *
 * IMPORTANT: react-test-renderer's `toJSON()` strips function props
 * (onClick, etc.) — they aren't part of the snapshot format. To invoke
 * handlers we go through `renderer.root.findAllByType('button')`,
 * which returns `TestInstance` objects whose `.props` retains the
 * full prop object including functions.
 */

function availableInfo(): UpdateInfo {
  return {
    kind: 'available',
    currentVersion: '0.1.38',
    latestVersion: '0.1.39',
    releaseUrl:
      'https://github.com/EthanSK/restream-chat-plus-plus/releases/tag/v0.1.39',
    checkedAt: 1_700_000_000_000,
  };
}

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

function findButtonByText(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (text: string) => boolean,
): TestInstance | undefined {
  const buttons = renderer.root.findAllByType('button');
  return buttons.find((b) => predicate(instanceText(b)));
}

function findToastsByClassPrefix(
  renderer: TestRenderer.ReactTestRenderer,
  prefix: string,
): TestInstance[] {
  return renderer.root.findAll((node) => {
    if (node.type !== 'div') return false;
    const cls = node.props.className;
    if (typeof cls !== 'string') return false;
    return cls.split(/\s+/).some((c) => c.startsWith(prefix));
  });
}

describe('decideToast — pure result → toast mapping', () => {
  it('Squirrel success → info toast about background download + restart (v0.1.89)', () => {
    // v0.1.89 (voice 4507) — copy changed from "Downloading update…" (which
    // implied a visible top-bar progress bar) to a background-download +
    // restart message, because the consolidated flow suppresses the top-bar
    // bar and relies on the background Squirrel download → Restart snackbar.
    const spec = decideToast({ ok: true, reason: 'started', mode: 'squirrel' });
    expect(spec.kind).toBe('info');
    expect(spec.text).toContain('background');
    expect(spec.text).toContain('restart');
  });

  it('Browser fallback success → info toast "Opening release page in browser…"', () => {
    const spec = decideToast({
      ok: true,
      reason: 'opened-release-page',
      mode: 'browser',
      fallbackReason: 'not-packaged',
    });
    expect(spec).toEqual({
      kind: 'info',
      text: 'Opening release page in browser…',
    });
  });

  it('Failure with explicit error → error toast with the underlying message', () => {
    const spec = decideToast({
      ok: false,
      reason: 'error',
      error: 'autoUpdater.checkForUpdates() threw',
      releaseUrl: 'https://example.com/releases',
    });
    expect(spec.kind).toBe('error');
    expect(spec.text).toBe('autoUpdater.checkForUpdates() threw');
  });

  it('Failure without an error message → generic error fallback', () => {
    const spec = decideToast({
      ok: false,
      reason: 'feed-unavailable',
      releaseUrl: 'https://example.com/releases',
    });
    expect(spec.kind).toBe('error');
    expect(spec.text).toBe('Update could not start');
  });
});

describe('UpdateBanner — installing state + toast (v0.1.39)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderBanner(
    onStartDownload: () => Promise<StartDownloadResult>,
  ): Promise<TestRenderer.ReactTestRenderer> {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <UpdateBanner
          info={availableInfo()}
          dismissed={false}
          onDismiss={() => {}}
          onStartDownload={onStartDownload}
          onRestart={() => {}}
        />,
      );
    });
    return renderer;
  }

  it('clicking Install Update flips the button to disabled + "Installing…" until the IPC resolves', async () => {
    let resolveStart: (r: StartDownloadResult) => void;
    const onStartDownload = vi.fn().mockImplementation(
      () =>
        new Promise<StartDownloadResult>((resolve) => {
          resolveStart = resolve;
        }),
    );

    const renderer = await renderBanner(onStartDownload);

    // Pre-click — button shows "Install Update" and is enabled.
    const installBefore = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_IDLE),
    );
    expect(installBefore, 'Install Update button must be present pre-click').toBeDefined();
    expect(installBefore!.props.disabled).toBeFalsy();
    expect(typeof installBefore!.props.onClick).toBe('function');

    // Fire the click — IPC promise is still pending, so the button
    // should flip to disabled + "Installing…" immediately.
    await act(async () => {
      installBefore!.props.onClick();
    });

    const installInFlight = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_INSTALLING),
    );
    expect(
      installInFlight,
      'Button label must flip to "Installing…" while IPC is in flight',
    ).toBeDefined();
    expect(installInFlight!.props.disabled).toBe(true);
    expect(installInFlight!.props['aria-busy']).toBe(true);
    expect(onStartDownload).toHaveBeenCalledTimes(1);

    // No toast yet — the result hasn't resolved.
    expect(
      findToastsByClassPrefix(renderer, 'update-banner-toast-'),
      'No toast should be present while IPC is in flight',
    ).toHaveLength(0);

    // Resolve the IPC → button flips back, toast appears.
    await act(async () => {
      resolveStart!({ ok: true, reason: 'started', mode: 'squirrel' });
    });

    const installAfter = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_IDLE),
    );
    expect(installAfter, 'Button label must return to idle after IPC resolves').toBeDefined();
    expect(installAfter!.props.disabled).toBeFalsy();

    renderer.unmount();
  });

  it('squirrel success result renders the background-download info toast (v0.1.89)', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: true,
      reason: 'started',
      mode: 'squirrel',
    } as StartDownloadResult);

    const renderer = await renderBanner(onStartDownload);
    const installBtn = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_IDLE),
    );
    await act(async () => {
      installBtn!.props.onClick();
    });

    const toast = findToastsByClassPrefix(renderer, 'update-banner-toast-info')[0];
    expect(toast, 'Info toast must render after squirrel-success result').toBeDefined();
    // v0.1.89 — snackbar now reflects the background-download + restart flow.
    expect(instanceText(toast!)).toContain('background');

    renderer.unmount();
  });

  it('browser fallback result renders the "Opening release page in browser…" info toast', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: true,
      reason: 'opened-release-page',
      mode: 'browser',
      fallbackReason: 'not-packaged',
    } as StartDownloadResult);

    const renderer = await renderBanner(onStartDownload);
    const installBtn = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_IDLE),
    );
    await act(async () => {
      installBtn!.props.onClick();
    });

    const toast = findToastsByClassPrefix(renderer, 'update-banner-toast-info')[0];
    expect(toast, 'Info toast must render after browser-fallback result').toBeDefined();
    expect(instanceText(toast!)).toContain('Opening release page in browser');

    renderer.unmount();
  });

  it('failure result renders an error toast with the underlying message', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'error',
      error: 'feed URL not set',
      releaseUrl: 'https://example.com/releases',
    } as StartDownloadResult);

    const renderer = await renderBanner(onStartDownload);
    const installBtn = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_IDLE),
    );
    await act(async () => {
      installBtn!.props.onClick();
    });

    const errorToast = findToastsByClassPrefix(renderer, 'update-banner-toast-error')[0];
    expect(errorToast, 'Error toast must render after failure result').toBeDefined();
    expect(instanceText(errorToast!)).toContain('feed URL not set');

    renderer.unmount();
  });

  it('toast auto-dismisses after TOAST_AUTO_DISMISS_MS', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: true,
      reason: 'started',
      mode: 'squirrel',
    } as StartDownloadResult);

    const renderer = await renderBanner(onStartDownload);
    const installBtn = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_IDLE),
    );
    await act(async () => {
      installBtn!.props.onClick();
    });

    expect(
      findToastsByClassPrefix(renderer, 'update-banner-toast-info').length,
    ).toBeGreaterThanOrEqual(1);

    // Advance time past the auto-dismiss threshold.
    await act(async () => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 10);
    });

    expect(
      findToastsByClassPrefix(renderer, 'update-banner-toast-'),
      'Toast should auto-dismiss after TOAST_AUTO_DISMISS_MS',
    ).toHaveLength(0);

    renderer.unmount();
  });

  it('manual dismiss button removes the toast immediately', async () => {
    const onStartDownload = vi.fn().mockResolvedValue({
      ok: true,
      reason: 'started',
      mode: 'squirrel',
    } as StartDownloadResult);

    const renderer = await renderBanner(onStartDownload);
    const installBtn = findButtonByText(renderer, (t) =>
      t.includes(INSTALL_BUTTON_LABEL_IDLE),
    );
    await act(async () => {
      installBtn!.props.onClick();
    });

    const dismissBtn = findButtonByText(renderer, (t) => t === '×');
    expect(dismissBtn, 'Toast must include an × dismiss button').toBeDefined();

    await act(async () => {
      dismissBtn!.props.onClick();
    });

    expect(
      findToastsByClassPrefix(renderer, 'update-banner-toast-'),
      'Toast should be removed immediately when user clicks ×',
    ).toHaveLength(0);

    renderer.unmount();
  });
});
