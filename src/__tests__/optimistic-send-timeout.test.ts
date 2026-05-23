import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '../shared/types';
import {
  dedupeOptimisticOnEcho,
  pushOptimisticMessage,
} from '../renderer/chat-message-reducers';
import {
  applyOptimisticSendTimeout,
  OPTIMISTIC_SEND_TIMEOUT_MS,
} from '../renderer/optimistic-send-timeout';

/**
 * v0.1.63 — renderer-side stuck-send guard.
 *
 * These tests keep the timer flow pure instead of mounting the full App tree:
 * the production component schedules the same timeout after
 * `pushOptimisticMessage`, clears it on `dedupeOptimisticOnEcho`, and applies
 * `applyOptimisticSendTimeout` only if neither the echo nor an explicit
 * queue failure arrives in time.
 */

function optimistic(id: string): ChatMessage {
  return {
    id,
    platform: 'unknown',
    username: 'You',
    text: 'hello',
    ts: 1_700_000_000_000,
    self: true,
    pendingSend: 'sending',
  };
}

function echo(id: string): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username: 'You',
    text: 'hello',
    ts: 1_700_000_000_500,
    self: true,
  };
}

describe('optimistic-send timeout guard (v0.1.63)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions a still-sending placeholder to failed after 15 seconds', () => {
    let messages: ChatMessage[] = [];
    messages = pushOptimisticMessage(messages, optimistic('local-timeout'));

    setTimeout(() => {
      messages = applyOptimisticSendTimeout(messages, 'local-timeout');
    }, OPTIMISTIC_SEND_TIMEOUT_MS);

    expect(messages[0].pendingSend).toBe('sending');

    vi.advanceTimersByTime(OPTIMISTIC_SEND_TIMEOUT_MS - 1);
    expect(messages[0].pendingSend).toBe('sending');

    vi.advanceTimersByTime(1);
    expect(messages[0].pendingSend).toBe('failed');
    expect(messages[0].pendingError).toBe(
      'Send timed out — check your connection or sign in again.',
    );
  });

  it('clears the timeout when the WS echo replaces the placeholder first', () => {
    let messages: ChatMessage[] = [];
    let timeoutFired = false;
    messages = pushOptimisticMessage(messages, optimistic('local-echo'));

    const timeout = setTimeout(() => {
      timeoutFired = true;
      messages = applyOptimisticSendTimeout(messages, 'local-echo');
    }, OPTIMISTIC_SEND_TIMEOUT_MS);

    vi.advanceTimersByTime(1_000);
    messages = dedupeOptimisticOnEcho(messages, echo('local-echo'));
    clearTimeout(timeout);

    vi.advanceTimersByTime(OPTIMISTIC_SEND_TIMEOUT_MS);
    expect(timeoutFired).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('local-echo');
    expect(messages[0].pendingSend).toBeUndefined();
    expect(messages[0].pendingError).toBeUndefined();
  });
});
