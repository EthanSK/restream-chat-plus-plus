import { describe, it, expect, vi } from 'vitest';
import {
  createChatSendQueue,
  isRetryableSendFailure,
} from '../main/chat-send-queue';
import type { ChatSendStatus, SendTextResult } from '../shared/types';
import type { ChatSendLogRecord } from '../main/chat-send';

/**
 * v0.1.90 (voice 4512) — "make damn sure my message sends, and always show me
 * that it's sending."
 *
 * These tests pin the bounded exponential-backoff retry loop in
 * `chat-send-queue.ts`:
 *   (a) exponential retry fires up to N× with a reconnect ("refresh") between
 *       attempts;
 *   (b) a transient failure that recovers mid-retry ends in `sent`;
 *   (c) all attempts exhausted ends in a terminal `failed` (tap-to-retry);
 *   (d) a confirmed 2xx is NEVER re-POSTed (no double-send);
 *   (e) every attempt — including a gate-level bail — writes a structured
 *       `retry-attempt` chat-send.jsonl row (the 16:50 "zero trace" gap).
 *
 * `backoffBaseMs: 0` + a synchronous `sleep` stub keeps the tests fast while
 * still exercising the real loop / reconnect ordering.
 */

function ok(): SendTextResult {
  return { ok: true };
}
function fail(reason: SendTextResult['reason'], status?: number): SendTextResult {
  return { ok: false, reason, status, error: `fail:${reason}` };
}

describe('chat-send retry loop (v0.1.90)', () => {
  it('isRetryableSendFailure classifies transient reasons as retryable', () => {
    // Every current reason is transient/worth-one-more-try.
    expect(isRetryableSendFailure('no-session-cookies')).toBe(true);
    expect(isRetryableSendFailure('no-active-connections')).toBe(true);
    expect(isRetryableSendFailure('not-authenticated')).toBe(true);
    expect(isRetryableSendFailure('no-show-id')).toBe(true);
    expect(isRetryableSendFailure('send-failed')).toBe(true);
    expect(isRetryableSendFailure('error')).toBe(true);
    expect(isRetryableSendFailure(undefined)).toBe(true);
    // A hypothetical future hard-failure reason is NOT retryable.
    expect(isRetryableSendFailure('message-too-long')).toBe(false);
  });

  it('(a) retries up to 5× with a reconnect ("refresh") BETWEEN each attempt', async () => {
    const attempts: number[] = [];
    const reconnectCalls: string[] = [];
    const sleeps: number[] = [];
    const statuses: ChatSendStatus[] = [];
    let callCount = 0;
    const queue = createChatSendQueue({
      runSend: async () => {
        callCount += 1;
        attempts.push(callCount);
        // Always a transient failure → loop runs the full ladder.
        return fail('no-active-connections');
      },
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
      backoffBaseMs: 1000,
      backoffMaxMs: 16000,
      maxSendAttempts: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      reconnectBetweenRetries: async (reason) => {
        reconnectCalls.push(reason);
        return { ok: true };
      },
    });
    queue.enqueue({ clientId: 'x', text: 'hi' });
    await queue.whenIdle();

    // Exactly 5 POST attempts.
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    // A reconnect ran BETWEEN each of the 4 retries (not after the last).
    expect(reconnectCalls.length).toBe(4);
    expect(reconnectCalls[0]).toContain('no-active-connections');
    // Exponential backoff ladder: 1s, 2s, 4s, 8s (capped at 16s) before
    // attempts 2..5. Only 4 sleeps (none after the final attempt).
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    // Intermediate `retrying` statuses surfaced for attempts 2..5.
    const retrying = statuses.filter((s) => s.status === 'retrying');
    expect(retrying.map((s) => s.attempt)).toEqual([2, 3, 4, 5]);
    expect(retrying.every((s) => s.maxAttempts === 5)).toBe(true);
  });

  it('(b) a transient failure that recovers mid-retry ends in `sent` (no terminal failure)', async () => {
    const statuses: ChatSendStatus[] = [];
    let call = 0;
    const queue = createChatSendQueue({
      runSend: async () => {
        call += 1;
        // Fail twice (transient), succeed on the 3rd attempt.
        return call < 3 ? fail('no-session-cookies') : ok();
      },
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
      backoffBaseMs: 0,
      maxSendAttempts: 5,
      sleep: async () => undefined,
      reconnectBetweenRetries: async () => ({ ok: true }),
    });
    queue.enqueue({ clientId: 'recover', text: 'eventually works' });
    await queue.whenIdle();

    expect(call).toBe(3);
    // Two `retrying` (for attempts 2 and 3), then `sent`, never `failed`.
    expect(statuses.filter((s) => s.status === 'retrying').map((s) => s.attempt)).toEqual([
      2, 3,
    ]);
    expect(statuses.some((s) => s.status === 'sent')).toBe(true);
    expect(statuses.some((s) => s.status === 'failed')).toBe(false);
  });

  it('(c) all attempts exhausted ends in a single terminal `failed` carrying the last reason', async () => {
    const statuses: ChatSendStatus[] = [];
    const queue = createChatSendQueue({
      runSend: async () => fail('send-failed', 503),
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
      backoffBaseMs: 0,
      maxSendAttempts: 3,
      sleep: async () => undefined,
      reconnectBetweenRetries: async () => ({ ok: true }),
    });
    queue.enqueue({ clientId: 'doomed', text: 'never lands' });
    await queue.whenIdle();

    const failed = statuses.filter((s) => s.status === 'failed');
    // Exactly ONE terminal failed status (not one per attempt).
    expect(failed.length).toBe(1);
    expect(failed[0].reason).toBe('send-failed');
    expect(failed[0].httpStatus).toBe(503);
    // The terminal failed carries the final attempt number for the UI.
    expect(failed[0].attempt).toBe(3);
    expect(failed[0].maxAttempts).toBe(3);
  });

  it('(c2) a NON-retryable failure terminates immediately without burning attempts', async () => {
    const reconnectCalls: string[] = [];
    let call = 0;
    const statuses: ChatSendStatus[] = [];
    const queue = createChatSendQueue({
      runSend: async () => {
        call += 1;
        // A reason isRetryableSendFailure does NOT recognise → terminal.
        return fail('message-too-long' as SendTextResult['reason'], 400);
      },
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
      backoffBaseMs: 0,
      maxSendAttempts: 5,
      sleep: async () => undefined,
      reconnectBetweenRetries: async (r) => {
        reconnectCalls.push(r);
        return { ok: true };
      },
    });
    queue.enqueue({ clientId: 'hard', text: 'x'.repeat(99999) });
    await queue.whenIdle();

    expect(call).toBe(1); // tried once, did not retry
    expect(reconnectCalls.length).toBe(0); // no reconnect for a non-retryable
    expect(statuses.filter((s) => s.status === 'retrying').length).toBe(0);
    expect(statuses.filter((s) => s.status === 'failed').length).toBe(1);
  });

  it('(d) a confirmed 2xx is NEVER re-POSTed — no double-send', async () => {
    const runSend = vi.fn(async () => ok());
    const reconnect = vi.fn(async () => ({ ok: true }));
    const queue = createChatSendQueue({
      runSend,
      emitStatus: () => undefined,
      minSpacingMs: 0,
      backoffBaseMs: 0,
      maxSendAttempts: 5,
      sleep: async () => undefined,
      reconnectBetweenRetries: reconnect,
    });
    queue.enqueue({ clientId: 'once', text: 'landed first try' });
    await queue.whenIdle();
    // Exactly one POST, no reconnect, no retry — a success must not loop.
    expect(runSend).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('(d2) every retry re-POSTs with the SAME clientId (Restream dedupes on it)', async () => {
    const seenIds: string[] = [];
    let call = 0;
    const queue = createChatSendQueue({
      runSend: async (item) => {
        seenIds.push(item.clientId);
        call += 1;
        return call < 3 ? fail('error') : ok();
      },
      emitStatus: () => undefined,
      minSpacingMs: 0,
      backoffBaseMs: 0,
      maxSendAttempts: 5,
      sleep: async () => undefined,
      reconnectBetweenRetries: async () => ({ ok: true }),
    });
    queue.enqueue({ clientId: 'fixed-uuid', text: 'dedupe me' });
    await queue.whenIdle();
    // All 3 attempts used the identical clientReplyUuid → Restream dedupes.
    expect(seenIds).toEqual(['fixed-uuid', 'fixed-uuid', 'fixed-uuid']);
  });

  it('(e) writes a `retry-attempt` log row for EVERY attempt incl. the gate bail (closes the 16:50 zero-trace gap)', async () => {
    const rows: ChatSendLogRecord[] = [];
    let call = 0;
    const queue = createChatSendQueue({
      runSend: async () => {
        call += 1;
        // First two attempts bail at a preflight gate (no-session-cookies),
        // third succeeds. Pre-v0.1.90 the dropped gate-bails left zero trace.
        return call < 3 ? fail('no-session-cookies') : ok();
      },
      emitStatus: () => undefined,
      minSpacingMs: 0,
      backoffBaseMs: 0,
      maxSendAttempts: 5,
      sleep: async () => undefined,
      reconnectBetweenRetries: async () => ({ ok: true }),
      logChatSend: (r) => rows.push(r),
    });
    queue.enqueue({ clientId: 'traced', text: 'leave a trail' });
    await queue.whenIdle();

    const retryRows = rows.filter(
      (r): r is Extract<ChatSendLogRecord, { phase: 'retry-attempt' }> =>
        r.phase === 'retry-attempt',
    );
    // One row per attempt (3 total): two failed-with-retry, one ok-done.
    expect(retryRows.length).toBe(3);
    expect(retryRows[0]).toMatchObject({
      attempt: 1,
      outcome: 'failed',
      reason: 'no-session-cookies',
      decision: 'retry-after-reconnect',
      reconnectRequested: true,
    });
    expect(retryRows[1]).toMatchObject({ attempt: 2, decision: 'retry-after-reconnect' });
    expect(retryRows[2]).toMatchObject({ attempt: 3, outcome: 'ok', decision: 'done' });
    // The clientReplyUuid is on every row so forensics can correlate by id.
    expect(retryRows.every((r) => r.clientReplyUuid === 'traced')).toBe(true);
  });

  it('(e2) a reconnect that throws does NOT abort the loop — the send still retries', async () => {
    let call = 0;
    const statuses: ChatSendStatus[] = [];
    const queue = createChatSendQueue({
      runSend: async () => {
        call += 1;
        return call < 2 ? fail('no-active-connections') : ok();
      },
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
      backoffBaseMs: 0,
      maxSendAttempts: 5,
      sleep: async () => undefined,
      reconnectBetweenRetries: async () => {
        throw new Error('reconnect blew up');
      },
    });
    queue.enqueue({ clientId: 'resilient', text: 'survive a bad reconnect' });
    await queue.whenIdle();
    // Despite the reconnect throwing after attempt 1, attempt 2 still ran and
    // succeeded — the loop must never strand the send on a reconnect failure.
    expect(call).toBe(2);
    expect(statuses.some((s) => s.status === 'sent')).toBe(true);
  });
});
