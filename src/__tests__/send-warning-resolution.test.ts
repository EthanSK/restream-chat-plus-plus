import { describe, it, expect } from 'vitest';
import {
  dedupeOptimisticOnEcho,
  isLateEchoForFailedSend,
  resolveLingeringFailedSendsOnReconnect,
} from '../renderer/chat-message-reducers';
import { applyOptimisticSendTimeout } from '../renderer/optimistic-send-timeout';
import type { ChatMessage } from '../shared/types';

/**
 * v0.1.88 (voice 4504, 2026-06-08) — "the ⚠ must resolve itself" coverage.
 *
 * Context: v0.1.87 made an unconfirmed send (POST 200 but no WS echo within the
 * renderer's 30s OPTIMISTIC_SEND_TIMEOUT_MS, so the placeholder flips to the red
 * ⚠ `'failed'` state) auto-trigger a managed reconnect that re-subscribes the WS
 * so FUTURE sends confirm. But the ALREADY-warned message kept its stuck ⚠ even
 * after the connection recovered and the message empirically delivered. v0.1.88
 * resolves that stuck ⚠ two ways, both covered here as PURE reducers (no React
 * mount, no IPC):
 *
 *   1. LATE ECHO clears the warning — a `reply_created` echo arriving AFTER the
 *      30s timeout still downgrades the `'failed'` placeholder back to a sent
 *      message (the ⚠ disappears). Cases (a) + (d).
 *   2. RECONNECT-SUCCESS SWEEP — on a managed-reconnect-success signal, any
 *      lingering ⚠ whose POST returned HTTP 200 is cleared; one whose POST never
 *      returned 200 (a genuine failure) is NOT. Cases (b) + (c).
 *
 * The four required cases from the spec map to the four top-level `describe`s.
 */

// `pendingSend` of 'none' produces a CONFIRMED (already-sent) message with no
// pendingSend flag — distinct from passing `undefined`, which JS would coerce to
// the 'sending' default. Default is 'sending'.
function placeholder(
  id: string,
  pendingSend: 'sending' | 'failed' | 'none' = 'sending',
): ChatMessage {
  const m: ChatMessage = {
    id,
    platform: 'unknown',
    username: 'You',
    text: 'hello world',
    ts: 1_700_000_000_000,
    self: true,
  };
  if (pendingSend === 'sending' || pendingSend === 'failed') {
    m.pendingSend = pendingSend;
  }
  if (pendingSend === 'failed') m.pendingError = 'No echo within 30s';
  return m;
}

// A WS `reply_created` echo: same id as the placeholder (id === clientReplyUuid),
// self: true, NO pendingSend — this is the "Restream confirmed the send" frame.
function wsEcho(id: string): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username: 'You',
    text: 'hello world',
    ts: 1_700_000_005_000,
    self: true,
  };
}

describe('(a) a LATE echo (after the 30s timeout) clears the ⚠ (failed → sent)', () => {
  it('downgrades a timed-out failed placeholder back to a confirmed sent message', () => {
    // Start with a fresh 'sending' placeholder, then fire the 30s timeout to
    // flip it to the red ⚠ 'failed' state (exactly what App.tsx does).
    let feed: ChatMessage[] = [placeholder('uuid-late', 'sending')];
    feed = applyOptimisticSendTimeout(feed, 'uuid-late');
    expect(feed[0].pendingSend).toBe('failed');
    expect(feed[0].pendingError).toBeTruthy();

    // The late echo arrives ~35s in. The dedupe must still match the FAILED
    // placeholder by id and REPLACE it with the echo (which has no pendingSend),
    // so the ⚠ is gone.
    const beforeEcho = feed;
    expect(isLateEchoForFailedSend(beforeEcho, wsEcho('uuid-late'))).toBe(true);
    feed = dedupeOptimisticOnEcho(feed, wsEcho('uuid-late'));

    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe('uuid-late');
    expect(feed[0].pendingSend).toBeUndefined(); // ⚠ resolved
    expect(feed[0].pendingError).toBeUndefined();
  });

  it('isLateEchoForFailedSend is FALSE for a still-sending placeholder (on-time echo)', () => {
    // An echo that beats the 30s guard hits a 'sending' (not 'failed')
    // placeholder — that is the NORMAL confirmation, not a late-echo resolution,
    // so the late-echo log row must NOT fire.
    const feed = [placeholder('uuid-ontime', 'sending')];
    expect(isLateEchoForFailedSend(feed, wsEcho('uuid-ontime'))).toBe(false);
    // ...but the dedupe still resolves it (sending → sent) either way.
    const next = dedupeOptimisticOnEcho(feed, wsEcho('uuid-ontime'));
    expect(next[0].pendingSend).toBeUndefined();
  });
});

describe('(b) on reconnect-success, a lingering ⚠ send that HAD HTTP 200 is cleared', () => {
  it('clears the ⚠ for the HTTP-200 failed send', () => {
    let feed: ChatMessage[] = [placeholder('uuid-200', 'sending')];
    feed = applyOptimisticSendTimeout(feed, 'uuid-200'); // → failed ⚠
    expect(feed[0].pendingSend).toBe('failed');

    // The send POSTed 200 (queue emitted 'sent'), so its id is in the set.
    const httpOk = new Set(['uuid-200']);
    const { next, clearedCount } = resolveLingeringFailedSendsOnReconnect(
      feed,
      httpOk,
    );

    expect(clearedCount).toBe(1);
    expect(next[0].pendingSend).toBeUndefined(); // ⚠ gone
    expect(next[0].pendingError).toBeUndefined();
    expect(next[0].self).toBe(true); // still renders as the user's own message
  });
});

describe('(c) on reconnect-success, a ⚠ send with NO HTTP 200 is NOT cleared', () => {
  it('leaves a genuine failure flagged (id not in the HTTP-200 set)', () => {
    let feed: ChatMessage[] = [placeholder('uuid-nohttp', 'sending')];
    feed = applyOptimisticSendTimeout(feed, 'uuid-nohttp'); // → failed ⚠
    expect(feed[0].pendingSend).toBe('failed');

    // This send NEVER POSTed 200 (e.g. no-session-cookies / HTTP error) so its
    // id is absent from the HTTP-200 set. The sweep must leave the ⚠ intact.
    const httpOk = new Set<string>(); // empty
    const { next, clearedCount } = resolveLingeringFailedSendsOnReconnect(
      feed,
      httpOk,
    );

    expect(clearedCount).toBe(0);
    expect(next).toBe(feed); // same reference — no churn, no re-render
    expect(next[0].pendingSend).toBe('failed'); // ⚠ kept
  });

  it('clears ONLY the HTTP-200 send in a mixed feed (200 cleared, non-200 kept)', () => {
    let feed: ChatMessage[] = [
      placeholder('ok-1', 'sending'),
      placeholder('bad-1', 'sending'),
    ];
    feed = applyOptimisticSendTimeout(feed, 'ok-1');
    feed = applyOptimisticSendTimeout(feed, 'bad-1');
    expect(feed.every((m) => m.pendingSend === 'failed')).toBe(true);

    const httpOk = new Set(['ok-1']); // only ok-1 got a 200
    const { next, clearedCount } = resolveLingeringFailedSendsOnReconnect(
      feed,
      httpOk,
    );

    expect(clearedCount).toBe(1);
    const ok = next.find((m) => m.id === 'ok-1')!;
    const bad = next.find((m) => m.id === 'bad-1')!;
    expect(ok.pendingSend).toBeUndefined(); // 200 → cleared
    expect(bad.pendingSend).toBe('failed'); // non-200 → kept
  });
});

describe('(d) a normally-confirmed send is unaffected by either path', () => {
  it('reconnect sweep does not touch a non-failed (already sent) message', () => {
    // A confirmed echo (no pendingSend) sitting in the feed, even though its id
    // is (defensively) still in the HTTP-200 set, must not be altered.
    const feed: ChatMessage[] = [placeholder('uuid-confirmed', 'none')];
    expect(feed[0].pendingSend).toBeUndefined();

    const httpOk = new Set(['uuid-confirmed']);
    const { next, clearedCount } = resolveLingeringFailedSendsOnReconnect(
      feed,
      httpOk,
    );

    expect(clearedCount).toBe(0);
    expect(next).toBe(feed); // untouched, same reference
    expect(next[0].pendingSend).toBeUndefined();
  });

  it('reconnect sweep is a no-op (same reference) when there are no failed sends at all', () => {
    const feed: ChatMessage[] = [
      placeholder('a', 'none'),
      placeholder('b', 'sending'), // still in-flight, NOT failed
    ];
    const { next, clearedCount } = resolveLingeringFailedSendsOnReconnect(
      feed,
      new Set(['a', 'b']),
    );
    expect(clearedCount).toBe(0);
    expect(next).toBe(feed);
  });
});
