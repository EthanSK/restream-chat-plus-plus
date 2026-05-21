import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ChannelsPanel } from '../renderer/ChannelsPanel';
import type { ChatConnection } from '../shared/types';

/**
 * v0.1.46 — channels-panel flicker fix (end-to-end render test).
 *
 * Mirrors the actual sequence captured in
 * `~/Library/Logs/Restream Chat++/raw-frames.jsonl` on 2026-05-21
 * 13:40:53–13:41:04: each platform connection cycles
 * `connected → connecting → connected` multiple times within ~1s at
 * boot. Pre-fix, the `N/M connected` trigger button (and per-channel
 * pills when the dropdown was open) flickered between values for
 * ~10s before settling. Post-fix, dips shorter than 750ms are
 * coalesced so the visible state is steady.
 */

function mkConn(
  id: string,
  status: ChatConnection['status'],
): ChatConnection {
  return {
    connectionIdentifier: id,
    connectionUuid: `${id}-${status}`,
    eventSourceId: 13,
    platform: 'youtube',
    status,
    reason: null,
    channelName: id,
    updatedAt: Date.now(),
  };
}

function triggerText(renderer: TestRenderer.ReactTestRenderer): string {
  // The button's className is dynamic (`btn ghost channels-trigger` ±
  // ` is-open`), so match by type+className-prefix.
  const button = renderer.root.findAll(
    (n) =>
      n.type === 'button' &&
      typeof n.props.className === 'string' &&
      n.props.className.includes('channels-trigger'),
  )[0];
  // Collect all string children depth-first.
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    if (node && typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(button.children);
  return out.join(' ');
}

describe('ChannelsPanel — boot-storm flicker coalescing (v0.1.46)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints a steady "2/2 connected" through a sub-750ms server flap', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    const connsConnected = [mkConn('yt', 'connected'), mkConn('tw', 'connected')];
    act(() => {
      renderer = TestRenderer.create(
        <ChannelsPanel connections={connsConnected} />,
      );
    });
    // Initial render: 2/2.
    expect(triggerText(renderer).replace(/\s+/g, '')).toContain('2/2');

    // Server flaps yt back to connecting.
    act(() => {
      renderer.update(
        <ChannelsPanel
          connections={[mkConn('yt', 'connecting'), mkConn('tw', 'connected')]}
        />,
      );
    });
    // Still 2/2 — the dip is suppressed.
    expect(triggerText(renderer).replace(/\s+/g, '')).toContain('2/2');

    // 300ms later, yt recovers to connected.
    act(() => {
      vi.advanceTimersByTime(300);
      renderer.update(
        <ChannelsPanel connections={connsConnected} />,
      );
    });
    expect(triggerText(renderer).replace(/\s+/g, '')).toContain('2/2');
    renderer.unmount();
  });

  it('reveals the dipped state honestly after the hold window expires', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChannelsPanel
          connections={[mkConn('yt', 'connected'), mkConn('tw', 'connected')]}
        />,
      );
    });
    expect(triggerText(renderer).replace(/\s+/g, '')).toContain('2/2');

    // yt flaps to connecting and STAYS there.
    act(() => {
      renderer.update(
        <ChannelsPanel
          connections={[mkConn('yt', 'connecting'), mkConn('tw', 'connected')]}
        />,
      );
    });
    expect(triggerText(renderer).replace(/\s+/g, '')).toContain('2/2');

    // After the hold window, the deferred flush should drop yt to 1/2.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(triggerText(renderer).replace(/\s+/g, '')).toContain('1/2');
    renderer.unmount();
  });
});
