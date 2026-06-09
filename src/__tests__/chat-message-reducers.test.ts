import { describe, it, expect } from 'vitest';
import {
  applyFailedSendStatus,
  applyRetryingSendStatus,
  dedupeOptimisticOnEcho,
  formatPendingError,
  pushOptimisticMessage,
  shouldTriggerSideEffects,
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

  // v0.1.90 (voice 4512) — the terminal `failed` reducer must STRIP the
  // transient retry counters so the row renders "tap to retry", not
  // "(retry N/5)".
  it('strips sendAttempt/sendMaxAttempts when flipping to terminal failed', () => {
    const retrying: ChatMessage = {
      ...placeholder('local-r', 'was retrying'),
      pendingSend: 'retrying',
      sendAttempt: 5,
      sendMaxAttempts: 5,
    };
    const status: ChatSendStatus = {
      clientId: 'local-r',
      status: 'failed',
      reason: 'send-failed',
      error: 'exhausted',
      attempt: 5,
      maxAttempts: 5,
    };
    const next = applyFailedSendStatus([retrying], status);
    expect(next[0].pendingSend).toBe('failed');
    expect(next[0].sendAttempt).toBeUndefined();
    expect(next[0].sendMaxAttempts).toBeUndefined();
    expect(next[0].pendingError).toBe('exhausted');
  });
});

describe('applyRetryingSendStatus (v0.1.90 — voice 4512)', () => {
  it('flips matching placeholder to pendingSend="retrying" with attempt counters', () => {
    const prev: ChatMessage[] = [placeholder('local-x', 'retry me')];
    const status: ChatSendStatus = {
      clientId: 'local-x',
      status: 'retrying',
      attempt: 3,
      maxAttempts: 5,
    };
    const next = applyRetryingSendStatus(prev, status);
    expect(next[0].pendingSend).toBe('retrying');
    expect(next[0].sendAttempt).toBe(3);
    expect(next[0].sendMaxAttempts).toBe(5);
    // Body preserved — the user's text stays visible the whole time.
    expect(next[0].text).toBe('retry me');
  });

  it('clears a stale pendingError from a previous failed attempt', () => {
    const failed: ChatMessage = {
      ...placeholder('local-x'),
      pendingSend: 'failed',
      pendingError: 'old error',
    };
    const status: ChatSendStatus = {
      clientId: 'local-x',
      status: 'retrying',
      attempt: 2,
      maxAttempts: 5,
    };
    const next = applyRetryingSendStatus([failed], status);
    expect(next[0].pendingSend).toBe('retrying');
    expect(next[0].pendingError).toBeUndefined();
  });

  it('is a no-op when status is not "retrying" or no placeholder matches', () => {
    const prev: ChatMessage[] = [placeholder('local-x')];
    expect(
      applyRetryingSendStatus(prev, { clientId: 'local-x', status: 'pending' }),
    ).toBe(prev);
    expect(
      applyRetryingSendStatus([wsEcho('local-x')], {
        clientId: 'local-x',
        status: 'retrying',
        attempt: 2,
        maxAttempts: 5,
      }),
    ).toEqual([wsEcho('local-x')]);
  });
});

describe('shouldTriggerSideEffects (v0.1.60 — double-send-sound fix)', () => {
  // The send-sound double-fire bug: every Enter played two sounds, one
  // on optimistic insert and one on server echo. The dedupe replaces
  // the placeholder in place, but BOTH state transitions change
  // `messages` array identity, so App.tsx's side-effect useEffect
  // re-fires for both. Without this gate, two TTS speak() calls per
  // sent message.

  it('returns false for an optimistic placeholder (pendingSend="sending")', () => {
    expect(
      shouldTriggerSideEffects(placeholder('local-x', 'spam test'), undefined),
    ).toBe(false);
  });

  it('returns false for a failed-send placeholder (pendingSend="failed")', () => {
    const failed: ChatMessage = {
      ...placeholder('local-x'),
      pendingSend: 'failed',
      pendingError: 'send failed',
    };
    expect(shouldTriggerSideEffects(failed, undefined)).toBe(false);
  });

  // v0.1.72 (voice 4352, 2026-05-28) — self-ignore became a hard default.
  // The previous v0.1.26-v0.1.71 behaviour ("read ALL messages including
  // self") was reverted. A confirmed self-echo (no pendingSend) is the
  // user's OWN reply_created bounced back by the WS, and the user does
  // NOT want to hear themselves or get notified about their own outgoing
  // post. See src/__tests__/self-ignore.test.ts for the dedicated coverage.
  it('returns FALSE for a confirmed self-echo (v0.1.72 self-ignore — was true pre-v0.1.72)', () => {
    expect(shouldTriggerSideEffects(wsEcho('local-x'), undefined)).toBe(false);
  });

  it('returns true for an incoming viewer message (no pendingSend, not self)', () => {
    expect(shouldTriggerSideEffects(incoming('m-1'), undefined)).toBe(true);
  });

  it('returns false when re-asked about the same id (no double-fire on dedupe-replace mid-array)', () => {
    const echo = wsEcho('local-x');
    expect(shouldTriggerSideEffects(echo, 'local-x')).toBe(false);
  });

  it('returns false for an empty feed', () => {
    expect(shouldTriggerSideEffects(undefined, undefined)).toBe(false);
  });

  it('regression: full optimistic-send lifecycle fires ZERO times under v0.1.72 self-ignore', () => {
    // App.tsx's useEffect re-runs every time the `messages` array
    // reference changes. We simulate the exact sequence:
    //
    //   1. User hits Enter        → push placeholder (pendingSend='sending')
    //   2. WS echo arrives        → dedupeOptimisticOnEcho replaces in place
    //                               (pendingSend=undefined, self=true)
    //
    // Pre-v0.1.60: BOTH steps fired the side effect (double send sound).
    // v0.1.60: Step 1 gated by pendingSend; only Step 2 fired (one sound).
    // v0.1.72: Step 2 ALSO gated by self===true; ZERO sounds for the
    // user's own outgoing message. This is what voice 4352 asks for —
    // "stop reading my own messages back to me."
    //
    // An incoming viewer message that arrives in between would still
    // fire — that's covered by the next regression test.
    let messages: ChatMessage[] = [];
    let lastProcessedId: string | undefined = undefined;
    let triggerCount = 0;

    const runSideEffect = (): void => {
      if (messages.length === 0) return;
      const m = messages[messages.length - 1];
      if (!shouldTriggerSideEffects(m, lastProcessedId)) return;
      lastProcessedId = m.id;
      triggerCount += 1;
    };

    // Step 1: optimistic insert (pendingSend gate keeps trigger off).
    messages = pushOptimisticMessage(messages, placeholder('local-x', 'hi'));
    runSideEffect();
    expect(triggerCount).toBe(0);

    // Step 2: WS echo arrives. Self===true keeps trigger off (v0.1.72).
    messages = dedupeOptimisticOnEcho(messages, wsEcho('local-x', 'hi'));
    runSideEffect();
    expect(triggerCount).toBe(0);

    // Step 3: re-fire of the same useEffect must NOT double-trigger.
    runSideEffect();
    expect(triggerCount).toBe(0);
  });

  it('regression: viewer-message-between-placeholder-and-echo does NOT re-fire on dedupe-replace', () => {
    // Edge case worth guarding: while the placeholder is pending, an
    // unrelated viewer message arrives and bumps past it as the new
    // last element. We trigger for the viewer. Then the echo arrives
    // and `dedupeOptimisticOnEcho` replaces the placeholder MID-ARRAY,
    // so the last element doesn't change. Without the same-id guard,
    // the useEffect would re-fire and re-speak the viewer message.
    let messages: ChatMessage[] = [];
    let lastProcessedId: string | undefined = undefined;
    const triggered: string[] = [];

    const runSideEffect = (): void => {
      if (messages.length === 0) return;
      const m = messages[messages.length - 1];
      if (!shouldTriggerSideEffects(m, lastProcessedId)) return;
      lastProcessedId = m.id;
      triggered.push(m.id);
    };

    messages = pushOptimisticMessage(messages, placeholder('local-x', 'mine'));
    runSideEffect();
    expect(triggered).toEqual([]); // gated

    messages = dedupeOptimisticOnEcho(messages, incoming('m-viewer', 'from a viewer'));
    runSideEffect();
    expect(triggered).toEqual(['m-viewer']);

    // Echo of OUR message replaces the placeholder mid-array. Last
    // element is still 'm-viewer' — the same-id guard prevents a
    // double-speak.
    messages = dedupeOptimisticOnEcho(messages, wsEcho('local-x', 'mine'));
    runSideEffect();
    expect(triggered).toEqual(['m-viewer']);
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
