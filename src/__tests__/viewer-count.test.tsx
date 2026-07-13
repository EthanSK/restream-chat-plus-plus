import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ViewerCount } from '../renderer/ViewerCount';
import type {
  ViewerChannelStat,
  ViewerStatsSnapshot,
} from '../shared/viewer-stats-core';

/**
 * v0.1.94 — LIVE VIEWER COUNT toolbar chip render rules.
 * v0.1.95 — chip is clickable; per-platform breakdown popover (open /
 * close paths / contents), replacing the old hover-tooltip breakdown.
 *
 * Pins the contract from ViewerCount.tsx:
 *   - not live / no data → render NOTHING (no permanent toolbar noise)
 *   - live but counts hidden → chip shows `—`
 *   - live with counts → localised total on the chip
 *   - click chip → popover with Total row + one row per channel
 *     (platform + identifier + live/offline pill + count or "—")
 *   - close via chip re-click, scrim (click-outside), × button, Escape,
 *     and automatically when the stream stops being live
 */

function chan(over: Partial<ViewerChannelStat> = {}): ViewerChannelStat {
  return {
    channelId: 1,
    platformId: 1,
    platformName: 'Twitch',
    channelIdentifier: 'reeethan_yt',
    online: true,
    viewers: 7,
    seenAtMs: Date.now(),
    updatedAt: 0,
    title: null,
    ...over,
  };
}

function snap(over: Partial<ViewerStatsSnapshot> = {}): ViewerStatsSnapshot {
  return {
    totalViewers: 7,
    anyOnline: true,
    channels: [chan()],
    computedAtMs: Date.now(),
    ...over,
  };
}

/**
 * Create a renderer inside `act()` — required by the repo's React-19 act
 * environment (see vitest.config.ts setupFiles comment): without act the
 * created tree's toJSON() is null and nothing renders.
 */
function render(el: React.ReactElement): TestRenderer.ReactTestRenderer {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

/** Flatten the rendered tree to its visible text. */
function textOf(r: TestRenderer.ReactTestRenderer): string {
  const walk = (n: unknown): string => {
    if (n == null) return '';
    if (typeof n === 'string') return n;
    if (Array.isArray(n)) return n.map(walk).join('');
    const node = n as { children?: unknown[] };
    return (node.children ?? []).map(walk).join('');
  };
  return walk(r.toJSON());
}

/** Find the chip trigger button (className contains `viewer-count`). */
function chipOf(r: TestRenderer.ReactTestRenderer) {
  return r.root.find(
    (n) =>
      n.type === 'button' &&
      typeof n.props.className === 'string' &&
      n.props.className.includes('viewer-count'),
  );
}

/** True when the breakdown popover dialog is currently rendered. */
function popoverOpen(r: TestRenderer.ReactTestRenderer): boolean {
  return (
    r.root.findAll(
      (n) => n.type === 'div' && n.props.className === 'viewer-popover',
    ).length > 0
  );
}

/** Click the chip inside act(). */
function clickChip(r: TestRenderer.ReactTestRenderer): void {
  act(() => {
    chipOf(r).props.onClick();
  });
}

describe('ViewerCount chip', () => {
  it('renders nothing for a null snapshot (renderer not yet synced)', () => {
    const r = render(<ViewerCount snapshot={null} />);
    expect(r.toJSON()).toBeNull();
  });

  it('renders nothing when no channel is online (not streaming)', () => {
    const r = render(
      <ViewerCount
        snapshot={snap({ anyOnline: false, totalViewers: null, channels: [] })}
      />,
    );
    expect(r.toJSON()).toBeNull();
  });

  it('shows the summed total when live', () => {
    const r = render(
      <ViewerCount
        snapshot={snap({
          totalViewers: 1234,
          channels: [
            chan({ viewers: 1200 }),
            chan({ channelId: 2, platformId: 5, platformName: 'YouTube', viewers: 34 }),
          ],
        })}
      />,
    );
    // toLocaleString output varies by ICU build ("1,234" on CI/en) — assert
    // via the same call so the test is locale-stable.
    expect(textOf(r)).toBe((1234).toLocaleString());
  });

  it('shows an em-dash placeholder when live but every count is hidden', () => {
    const r = render(
      <ViewerCount
        snapshot={snap({
          totalViewers: null,
          channels: [chan({ platformName: 'X (Twitter)', viewers: null })],
        })}
      />,
    );
    expect(textOf(r)).toBe('—');
  });

  it('is a real button with the is-open affordance while expanded', () => {
    const r = render(<ViewerCount snapshot={snap()} />);
    expect(chipOf(r).props['aria-expanded']).toBe(false);
    clickChip(r);
    expect(chipOf(r).props['aria-expanded']).toBe(true);
    expect(chipOf(r).props.className).toContain('is-open');
  });
});

describe('ViewerCount breakdown popover', () => {
  it('opens on chip click and lists total + per-channel rows', () => {
    const r = render(
      <ViewerCount
        snapshot={snap({
          totalViewers: 46,
          channels: [
            chan({ viewers: 12 }),
            chan({
              channelId: 2,
              platformId: 5,
              platformName: 'YouTube',
              channelIdentifier: 'REEEthan',
              viewers: 34,
            }),
            // Count-hidden platform (viewers:null) must render "—".
            chan({
              channelId: 3,
              platformId: 71,
              platformName: 'X (Twitter)',
              channelIdentifier: 'REEEthan_YT',
              viewers: null,
            }),
            // Offline channel: listed, demoted, count forced to "—".
            chan({
              channelId: 4,
              platformName: 'Facebook',
              channelIdentifier: 'REEEthanPage',
              online: false,
              viewers: 99,
            }),
          ],
        })}
      />,
    );
    expect(popoverOpen(r)).toBe(false);
    clickChip(r);
    expect(popoverOpen(r)).toBe(true);

    const text = textOf(r);
    // Total pinned in the popover.
    expect(text).toContain('Total');
    expect(text).toContain((46).toLocaleString());
    // Per-channel rows: platform names + identifiers + counts.
    expect(text).toContain('Twitch');
    expect(text).toContain('reeethan_yt');
    expect(text).toContain('YouTube');
    expect(text).toContain((34).toLocaleString());
    expect(text).toContain('X (Twitter)');
    expect(text).toContain('Facebook');
    expect(text).toContain('offline');
    // Exactly one demoted offline row…
    const offlineRows = r.root.findAll(
      (n) =>
        n.type === 'li' &&
        typeof n.props.className === 'string' &&
        n.props.className.includes('is-offline'),
    );
    expect(offlineRows).toHaveLength(1);
    // …and its stale pre-offline count (99) must NOT leak anywhere.
    expect(text).not.toContain('99');
  });

  it('toggles closed on a second chip click', () => {
    const r = render(<ViewerCount snapshot={snap()} />);
    clickChip(r);
    expect(popoverOpen(r)).toBe(true);
    clickChip(r);
    expect(popoverOpen(r)).toBe(false);
  });

  it('closes on scrim click (click-outside)', () => {
    const r = render(<ViewerCount snapshot={snap()} />);
    clickChip(r);
    const scrim = r.root.find(
      (n) => n.type === 'div' && n.props.className === 'channels-scrim',
    );
    act(() => {
      scrim.props.onClick();
    });
    expect(popoverOpen(r)).toBe(false);
  });

  it('closes on the × button', () => {
    const r = render(<ViewerCount snapshot={snap()} />);
    clickChip(r);
    const closeBtn = r.root.find(
      (n) => n.type === 'button' && n.props['aria-label'] === 'Close',
    );
    act(() => {
      closeBtn.props.onClick();
    });
    expect(popoverOpen(r)).toBe(false);
  });

  it('force-closes when the stream stops being live (no surprise reopen)', () => {
    const r = render(<ViewerCount snapshot={snap()} />);
    clickChip(r);
    expect(popoverOpen(r)).toBe(true);
    // Stream ends → chip disappears entirely; open state must reset.
    act(() => {
      r.update(
        <ViewerCount
          snapshot={snap({ anyOnline: false, totalViewers: null, channels: [] })}
        />,
      );
    });
    expect(r.toJSON()).toBeNull();
    // Next stream starts → chip returns CLOSED (no surprise popover).
    act(() => {
      r.update(<ViewerCount snapshot={snap()} />);
    });
    expect(popoverOpen(r)).toBe(false);
    expect(chipOf(r).props['aria-expanded']).toBe(false);
  });
});

describe('ViewerCount Escape-to-close', () => {
  // The vitest environment is `node` (no DOM). The component guards its
  // document listener on `typeof document`, so to exercise the Escape path
  // we install a minimal document stub that just captures the keydown
  // handler. Removed after each test so other files see a clean global.
  type Handler = (e: KeyboardEvent) => void;
  const listeners = new Set<Handler>();
  const documentStub = {
    addEventListener: (_type: string, h: Handler) => listeners.add(h),
    removeEventListener: (_type: string, h: Handler) => listeners.delete(h),
  };

  afterEach(() => {
    listeners.clear();
    delete (globalThis as Record<string, unknown>).document;
  });

  it('closes the popover on Escape and detaches the listener after close', () => {
    (globalThis as Record<string, unknown>).document = documentStub;
    const r = render(<ViewerCount snapshot={snap()} />);
    // Listener only armed while open.
    expect(listeners.size).toBe(0);
    clickChip(r);
    expect(listeners.size).toBe(1);
    act(() => {
      for (const h of [...listeners]) h({ key: 'Escape' } as KeyboardEvent);
    });
    expect(popoverOpen(r)).toBe(false);
    // Effect cleanup must have removed the keydown listener.
    expect(listeners.size).toBe(0);
  });

  it('ignores non-Escape keys', () => {
    (globalThis as Record<string, unknown>).document = documentStub;
    const r = render(<ViewerCount snapshot={snap()} />);
    clickChip(r);
    act(() => {
      for (const h of [...listeners]) h({ key: 'Enter' } as KeyboardEvent);
    });
    expect(popoverOpen(r)).toBe(true);
  });
});
