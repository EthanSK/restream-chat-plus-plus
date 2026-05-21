import { describe, it, expect } from 'vitest';
import {
  reconcileStableConnections,
  TRANSIENT_CONNECTING_HOLD_MS,
  type PendingDipsMap,
} from '../renderer/connections-stable';
import type { ChatConnection } from '../shared/types';

/**
 * v0.1.46 — coalesce / debounce regression suite for the channels-panel
 * flicker fix. See `connections-stable.ts` docstring for the captured
 * raw-frame repro this is modeled on.
 */

function mkConn(
  id: string,
  status: ChatConnection['status'],
  overrides: Partial<ChatConnection> = {},
): ChatConnection {
  return {
    connectionIdentifier: id,
    connectionUuid: `${id}-uuid`,
    eventSourceId: 13,
    platform: 'youtube',
    status,
    reason: null,
    channelName: id,
    updatedAt: 0,
    ...overrides,
  };
}

describe('reconcileStableConnections', () => {
  it('paints upstream as-is when there is no prior state', () => {
    const upstream = [mkConn('a', 'connected'), mkConn('b', 'connecting')];
    const r = reconcileStableConnections(upstream, [], new Map(), 0);
    expect(r.view).toEqual(upstream);
    expect(r.pendingDips.size).toBe(0);
    expect(r.wakeAtMs).toBe(null);
  });

  it('paints upstream as-is when prior had the same statuses', () => {
    const prev = [mkConn('a', 'connected'), mkConn('b', 'connected')];
    const upstream = [mkConn('a', 'connected'), mkConn('b', 'connected')];
    const r = reconcileStableConnections(upstream, prev, new Map(), 0);
    expect(r.view).toEqual(upstream);
    expect(r.pendingDips.size).toBe(0);
  });

  it('opens a dip when a previously-connected channel goes to connecting', () => {
    const prev = [mkConn('a', 'connected', { channelName: 'old' })];
    const upstream = [mkConn('a', 'connecting', { channelName: 'new' })];
    const r = reconcileStableConnections(upstream, prev, new Map(), 1000);
    // View still shows the prior connected shape.
    expect(r.view).toHaveLength(1);
    expect(r.view[0].status).toBe('connected');
    expect(r.view[0].channelName).toBe('old');
    // A dip is now pending for `a`, scheduled to expire after HOLD_MS.
    expect(r.pendingDips.has('a')).toBe(true);
    expect(r.pendingDips.get('a')!.startedAt).toBe(1000);
    expect(r.wakeAtMs).toBe(1000 + TRANSIENT_CONNECTING_HOLD_MS);
  });

  it('SUPPRESSES the flicker when a dip recovers within the hold window', () => {
    // t=0: a is connected.
    const v0 = reconcileStableConnections(
      [mkConn('a', 'connected')],
      [],
      new Map(),
      0,
    );
    expect(v0.view[0].status).toBe('connected');

    // t=100: server flips a → connecting. We should still paint connected.
    const v1 = reconcileStableConnections(
      [mkConn('a', 'connecting')],
      v0.view,
      v0.pendingDips,
      100,
    );
    expect(v1.view[0].status).toBe('connected');
    expect(v1.pendingDips.has('a')).toBe(true);

    // t=300: server flips a back to connected. Within hold window —
    // suppress, paint connected, drop dip. Net result: UI never saw
    // the `connecting` flicker at all.
    const v2 = reconcileStableConnections(
      [mkConn('a', 'connected')],
      v1.view,
      v1.pendingDips,
      300,
    );
    expect(v2.view[0].status).toBe('connected');
    expect(v2.pendingDips.has('a')).toBe(false);
    expect(v2.wakeAtMs).toBe(null);
  });

  it('FLUSHES the dip honestly if the hold window expires while still connecting', () => {
    const t0 = 0;
    const v0 = reconcileStableConnections(
      [mkConn('a', 'connected')],
      [],
      new Map(),
      t0,
    );
    const dipStart = t0 + 100;
    const v1 = reconcileStableConnections(
      [mkConn('a', 'connecting')],
      v0.view,
      v0.pendingDips,
      dipStart,
    );
    expect(v1.view[0].status).toBe('connected'); // suppressed
    expect(v1.pendingDips.get('a')!.startedAt).toBe(dipStart);

    // Past the hold (relative to dip start) — the dip flushes.
    const v2 = reconcileStableConnections(
      [mkConn('a', 'connecting')],
      v1.view,
      v1.pendingDips,
      dipStart + TRANSIENT_CONNECTING_HOLD_MS + 1,
    );
    expect(v2.view[0].status).toBe('connecting');
    expect(v2.pendingDips.has('a')).toBe(false);
    expect(v2.wakeAtMs).toBe(null);
  });

  it('suppresses repeated dips during a single boot-storm (real-trace shape)', () => {
    // Mirrors the raw-frames.jsonl trace from 2026-05-21 13:40:53–13:41:04:
    // youtube cycles connected → connecting → connected → connecting →
    // connected over ~10s. With each individual dip <750ms, the UI
    // should paint a steady "connected" the whole time.
    let view: ChatConnection[] = [];
    let pending: PendingDipsMap = new Map();

    // t=0: arrive as connected.
    let r = reconcileStableConnections(
      [mkConn('yt', 'connected')],
      view,
      pending,
      0,
    );
    expect(r.view[0].status).toBe('connected');
    view = r.view;
    pending = r.pendingDips;

    // t=1400: server dips to connecting.
    r = reconcileStableConnections([mkConn('yt', 'connecting')], view, pending, 1400);
    expect(r.view[0].status).toBe('connected');
    view = r.view;
    pending = r.pendingDips;

    // t=1900: recovers within 750ms of the dip start.
    r = reconcileStableConnections([mkConn('yt', 'connected')], view, pending, 1900);
    expect(r.view[0].status).toBe('connected');
    view = r.view;
    pending = r.pendingDips;
    expect(pending.size).toBe(0); // dip cleared

    // t=9200: server dips again.
    r = reconcileStableConnections([mkConn('yt', 'connecting')], view, pending, 9200);
    expect(r.view[0].status).toBe('connected');
    view = r.view;
    pending = r.pendingDips;

    // t=9700: recovers again.
    r = reconcileStableConnections([mkConn('yt', 'connected')], view, pending, 9700);
    expect(r.view[0].status).toBe('connected');
    view = r.view;
    pending = r.pendingDips;
    expect(pending.size).toBe(0);
  });

  it('does NOT suppress connecting → connected (improvement is real signal)', () => {
    const prev = [mkConn('a', 'connecting')];
    const upstream = [mkConn('a', 'connected')];
    const r = reconcileStableConnections(upstream, prev, new Map(), 0);
    expect(r.view[0].status).toBe('connected');
    expect(r.pendingDips.size).toBe(0);
  });

  it('does NOT suppress connected → error (errors paint immediately)', () => {
    const prev = [mkConn('a', 'connected')];
    const upstream = [mkConn('a', 'error', { reason: 'BANNED' })];
    const r = reconcileStableConnections(upstream, prev, new Map(), 0);
    expect(r.view[0].status).toBe('error');
    expect(r.view[0].reason).toBe('BANNED');
    expect(r.pendingDips.size).toBe(0);
  });

  it('paints brand-new connections immediately even when in connecting state', () => {
    // Channels that appear for the first time as `connecting` are
    // NOT a flicker — they're a fresh subscription. Paint as-is.
    const upstream = [mkConn('a', 'connecting')];
    const r = reconcileStableConnections(upstream, [], new Map(), 0);
    expect(r.view[0].status).toBe('connecting');
    expect(r.pendingDips.size).toBe(0);
  });

  it('drops pending dips when their connection disappears from upstream', () => {
    const prev = [mkConn('a', 'connected'), mkConn('b', 'connected')];
    // First, open a dip on `a`.
    const v1 = reconcileStableConnections(
      [mkConn('a', 'connecting'), mkConn('b', 'connected')],
      prev,
      new Map(),
      0,
    );
    expect(v1.pendingDips.has('a')).toBe(true);
    // Next push: `a` is gone (connection_closed), `b` still connected.
    const v2 = reconcileStableConnections(
      [mkConn('b', 'connected')],
      v1.view,
      v1.pendingDips,
      100,
    );
    expect(v2.view).toHaveLength(1);
    expect(v2.view[0].connectionIdentifier).toBe('b');
    expect(v2.pendingDips.size).toBe(0);
  });

  it('refreshes the dipped `next` snapshot to the freshest upstream', () => {
    const v0 = reconcileStableConnections(
      [mkConn('a', 'connected')],
      [],
      new Map(),
      0,
    );
    const v1 = reconcileStableConnections(
      [mkConn('a', 'connecting', { reason: 'first' })],
      v0.view,
      v0.pendingDips,
      100,
    );
    expect(v1.pendingDips.get('a')!.next.reason).toBe('first');
    // Another push within the hold — still connecting but with new reason.
    const v2 = reconcileStableConnections(
      [mkConn('a', 'connecting', { reason: 'second' })],
      v1.view,
      v1.pendingDips,
      200,
    );
    expect(v2.pendingDips.get('a')!.next.reason).toBe('second');
    // When flushed (past hold relative to the dip's `startedAt`=100),
    // the freshest reason makes it out.
    const dipStart = v2.pendingDips.get('a')!.startedAt;
    const v3 = reconcileStableConnections(
      [mkConn('a', 'connecting', { reason: 'second' })],
      v2.view,
      v2.pendingDips,
      dipStart + TRANSIENT_CONNECTING_HOLD_MS + 1,
    );
    expect(v3.view[0].status).toBe('connecting');
    expect(v3.view[0].reason).toBe('second');
  });

  it('reports the earliest wake time across multiple pending dips', () => {
    const prev = [mkConn('a', 'connected'), mkConn('b', 'connected')];
    // Dip `a` at t=0.
    const v1 = reconcileStableConnections(
      [mkConn('a', 'connecting'), mkConn('b', 'connected')],
      prev,
      new Map(),
      0,
    );
    // Dip `b` at t=200.
    const v2 = reconcileStableConnections(
      [mkConn('a', 'connecting'), mkConn('b', 'connecting')],
      v1.view,
      v1.pendingDips,
      200,
    );
    expect(v2.pendingDips.size).toBe(2);
    // `a` started at 0 so its wake is at HOLD_MS — earlier.
    expect(v2.wakeAtMs).toBe(TRANSIENT_CONNECTING_HOLD_MS);
  });
});
