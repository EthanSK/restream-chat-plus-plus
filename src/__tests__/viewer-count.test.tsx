import { describe, it, expect } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ViewerCount } from '../renderer/ViewerCount';
import type {
  ViewerChannelStat,
  ViewerStatsSnapshot,
} from '../shared/viewer-stats-core';

/**
 * v0.1.94 — LIVE VIEWER COUNT toolbar chip render rules.
 *
 * Pins the quiet-degradation contract from ViewerCount.tsx:
 *   - not live / no data → render NOTHING (no permanent toolbar noise)
 *   - live but counts hidden → `—`
 *   - live with counts → localised total + per-platform tooltip
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
  const json = r.toJSON();
  const walk = (n: unknown): string => {
    if (n == null) return '';
    if (typeof n === 'string') return n;
    if (Array.isArray(n)) return n.map(walk).join('');
    const node = n as { children?: unknown[] };
    return (node.children ?? []).map(walk).join('');
  };
  return walk(json);
}

describe('ViewerCount', () => {
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

  it('tooltip carries the per-platform breakdown (online channels only)', () => {
    const r = render(
      <ViewerCount
        snapshot={snap({
          totalViewers: 12,
          channels: [
            chan({ viewers: 12 }),
            chan({
              channelId: 2,
              platformId: 71,
              platformName: 'X (Twitter)',
              channelIdentifier: 'REEEthan_YT',
              viewers: null,
            }),
            // Offline channel must be omitted from the tooltip.
            chan({ channelId: 3, platformName: 'Facebook', online: false }),
          ],
        })}
      />,
    );
    const root = r.toJSON() as unknown as { props: { title: string } };
    expect(root.props.title).toContain('Twitch (reeethan_yt): 12');
    expect(root.props.title).toContain('X (Twitter) (REEEthan_YT): —');
    expect(root.props.title).not.toContain('Facebook');
  });
});
