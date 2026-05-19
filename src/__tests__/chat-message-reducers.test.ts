import { describe, it, expect } from 'vitest';
import {
  applyFailedSendStatus,
  dedupeOptimisticOnEcho,
  formatPendingError,
  pushOptimisticMessage,
} from '../renderer/chat-message-reducers';
import type { ChatMessage, ChatSendStatus } from '../shared/types';

/**
 * v0.1.43 — pure-reducer coverage for the optimistic-send chat flow.
 *
 * The reducers describe how App.tsx mutates `messages` state in
 * response to (a) the user hitting Enter, (b) Restream's WS echoing
 * the reply back, (c) the main-process queue reporting a failure. Each
 * code path is testable without mounting the full App tree.
 */

function placeholder(id: string, text = 'hello'): ChatMessage {
  return {
    id,
    platform: 'unknown',
    username: 'You',
    text,
    ts: 1_700_000_000_000,
    self: true,
    pendingSend: 'sending',
  };
}

function wsEcho(id: string, text = 'hello'): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username: 'You',
    text,
    ts: 1_700_000_001_000,
    self: true,
  };
}

function incoming(id: string, text = 'hi from viewer'): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username: 'viewer42',
    text,
    ts: 1_700_000_002_000,
  };
}

describe('pushOptimisticMessage', () => {
  it('appends the placeholder to the existing list', () => {
    const prev: ChatMessage[] = [incoming('m-1'), incoming('m-2')];
    const next = pushOptimisticMessage(prev, placeholder('local-x'));
    expect(next).toHaveLength(3);
    expect(next[2].id).toBe('local-x');
    expect(next[2].pendingSend).toBe('sending');
  });

  it('caps the buffer at MAX_MESSAGES, dropping oldest first', () => {
    const prev: ChatMessage[] = Array.from({ length: 1000 }, (_, i) =>
      incoming(`m-${i}`),
    );
    const next = pushOptimisticMessage(prev, placeholder('local-x'), 1000);
    expect(next).toHaveLength(1000);
    expect(next[0].id).toBe('m-1'); // m-0 dropped
    expect(next[999].id).toBe('local-x');
  });
});

describe('dedupeOptimisticOnEcho', () => {
  it('REPLACES the optimistic placeholder when WS echo with matching id arrives', () => {
    const prev: ChatMessage[] = [
      incoming('m-1'),
      placeholder('local-x', 'spam test'),
      incoming('m-2'),
    ];
    const echo = wsEcho('local-x', 'spam test');
    const next = dedupeOptimisticOnEcho(prev, echo);
    expect(next).toHaveLength(3);
    expect(next[1]).toEqual(echo);
    expect(next[1].pendingSend).toBeUndefined();
  });

  it('APPENDS the incoming message when no matching placeholder exists', () => {
    const prev: ChatMessage[] = [incoming('m-1')];
    const m = incoming('m-2');
    const next = dedupeOptimisticOnEcho(prev, m);
    expect(next).toEqual([prev[0], m]);
  });

  it('does NOT match a non-placeholder message with the same id (preserves prior echo)', () => {
    // Edge case: if Restream were to re-emit a reply_created with the
    // same uuid, we'd APPEND (duplicate visible) rather than silently
    // replace an already-echoed message. This guards against future
    // changes to Restream's resend semantics surprising the dedupe.
    const prev: ChatMessage[] = [wsEcho('local-x', 'first echo')];
    const second = wsEcho('local-x', 'second echo');
    const next = dedupeOptimisticOnEcho(prev, second);
    expect(next).toHaveLength(2);
  });

  it('caps the buffer at MAX_MESSAGES on append path', () => {
    const prev: ChatMessage[] = Array.from({ length: 1000 }, (_, i) =>
      incoming(`m-${i}`),
    );
    const next = dedupeOptimisticOnEcho(prev, incoming('m-1000'), 1000);
    expect(next).toHaveLength(1000);
    expect(next[999].id).toBe('m-1000');
    expect(next[0].id).toBe('m-1');
  });
});

describe('applyFailedSendStatus', () => {
  it('flips matching placeholder to pendingSend="failed" + stashes pendingError', () => {
    const prev: ChatMessage[] = [
      incoming('m-1'),
      placeholder('local-x', 'will fail'),
    ];
    const status: ChatSendStatus = {
      clientId: 'local-x',
      status: 'failed',
      reason: 'send-failed',
      error: 'Restream backend rejected the body',
      httpStatus: 400,
    };
    const next = applyFailedSendStatus(prev, status);
    expect(next).toHaveLength(2);
    expect(next[1].pendingSend).toBe('failed');
    expect(next[1].pendingError).toBe('Restream backend rejected the body');
    // Other fields preserved verbatim — only the status + error flip.
    expect(next[1].text).toBe('will fail');
    expect(next[1].id).toBe('local-x');
  });

  it('is a no-op when status.status is not "failed"', () => {
    const prev: ChatMessage[] = [placeholder('local-x')];
    const status: ChatSendStatus = { clientId: 'local-x', status: 'pending' };
    expect(applyFailedSendStatus(prev, status)).toBe(prev);
  });

  it('is a no-op when no matching placeholder is in the feed', () => {
    const prev: ChatMessage[] = [incoming('m-1'), wsEcho('local-x')];
    const status: ChatSendStatus = {
      clientId: 'local-x',
      status: 'failed',
      error: 'too late — echo already arrived',
    };
    // Echo replaced the placeholder before the status arrived. Don't
    // retroactively paint the echo as failed.
    expect(applyFailedSendStatus(prev, status)).toBe(prev);
  });

  it('does NOT block subsequent messages — failed entry stays in place', () => {
    const prev: ChatMessage[] = [
      placeholder('local-a', 'failed one'),
      placeholder('local-b', 'sent two'),
      incoming('m-1'),
    ];
    const failedA: ChatSendStatus = {
      clientId: 'local-a',
      status: 'failed',
      error: 'a-failed',
    };
    const after = applyFailedSendStatus(prev, failedA);
    expect(after).toHaveLength(3);
    expect(after[0].pendingSend).toBe('failed');
    // Other placeholder + the incoming message untouched.
    expect(after[1].pendingSend).toBe('sending');
    expect(after[2].id).toBe('m-1');
  });
});

describe('formatPendingError', () => {
  it('prefers status.error when present', () => {
    expect(
      formatPendingError({
        clientId: 'x',
        status: 'failed',
        error: 'explicit error',
        reason: 'send-failed',
      }),
    ).toBe('explicit error');
  });

  it('synthesises a reason+httpStatus message when only those are set', () => {
    expect(
      formatPendingError({
        clientId: 'x',
        status: 'failed',
        reason: 'send-failed',
        httpStatus: 500,
      }),
    ).toBe('Send failed (send-failed HTTP 500)');
  });

  it('drops the http suffix when httpStatus is missing', () => {
    expect(
      formatPendingError({
        clientId: 'x',
        status: 'failed',
        reason: 'no-active-connections',
      }),
    ).toBe('Send failed (no-active-connections)');
  });

  it('falls back to generic copy when nothing useful is set', () => {
    expect(
      formatPendingError({ clientId: 'x', status: 'failed' }),
    ).toBe('Send failed.');
  });
});
