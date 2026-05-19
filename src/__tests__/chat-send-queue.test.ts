import { describe, it, expect, vi } from 'vitest';
import { createChatSendQueue } from '../main/chat-send-queue';
import type { ChatSendStatus, SendTextResult } from '../shared/types';

/**
 * v0.1.43 — non-blocking chat send: the renderer fires enqueues
 * fire-and-forget and the main-process queue serialises POSTs to
 * Restream's `/client/reply` endpoint. These tests pin the queue's
 * contract from the renderer's perspective (every enqueue is accepted)
 * and from the network's perspective (sends run in order, errors don't
 * block subsequent sends).
 */

function makeOkResult(): SendTextResult {
  return { ok: true };
}
function makeFailResult(error = 'boom'): SendTextResult {
  return { ok: false, reason: 'send-failed', status: 500, error };
}

describe('chat-send-queue (v0.1.43)', () => {
  it('processes enqueued items in FIFO order', async () => {
    const sentTexts: string[] = [];
    const statuses: ChatSendStatus[] = [];
    const queue = createChatSendQueue({
      runSend: async (item) => {
        sentTexts.push(item.text);
        return makeOkResult();
      },
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
    });
    queue.enqueue({ clientId: 'a', text: 'one' });
    queue.enqueue({ clientId: 'b', text: 'two' });
    queue.enqueue({ clientId: 'c', text: 'three' });
    await queue.whenIdle();
    expect(sentTexts).toEqual(['one', 'two', 'three']);
    // Each enqueue emits `pending`, then each completed send emits `sent`.
    const pendings = statuses.filter((s) => s.status === 'pending').map((s) => s.clientId);
    const sents = statuses.filter((s) => s.status === 'sent').map((s) => s.clientId);
    expect(pendings).toEqual(['a', 'b', 'c']);
    expect(sents).toEqual(['a', 'b', 'c']);
  });

  it('accepts every enqueue WITHOUT blocking, even during an in-flight send', async () => {
    // Renderer-perspective: spamming Enter must never throw, drop, or
    // reject. The enqueue method is synchronous and side-effect-only.
    let releaseInFlight: (() => void) | undefined;
    const inFlightStarted = new Promise<void>((resolveStart) => {
      let resolved = false;
      const queue = createChatSendQueue({
        runSend: async () => {
          if (!resolved) {
            resolved = true;
            resolveStart();
          }
          await new Promise<void>((r) => {
            releaseInFlight = r;
          });
          return makeOkResult();
        },
        emitStatus: () => undefined,
        minSpacingMs: 0,
      });
      // Fire the first enqueue, then immediately fire 50 more BEFORE the
      // first POST resolves. The renderer must be able to do this without
      // any of them throwing.
      queue.enqueue({ clientId: 'first', text: 'first' });
      for (let i = 0; i < 50; i++) {
        expect(() => queue.enqueue({ clientId: `spam-${i}`, text: `m${i}` })).not.toThrow();
      }
      expect(queue.pending() + (queue.isRunning() ? 1 : 0)).toBe(51);
    });
    await inFlightStarted;
    releaseInFlight?.();
  });

  it('emits `failed` status when a send returns ok=false but does NOT block the next send', async () => {
    const calls: string[] = [];
    const statuses: ChatSendStatus[] = [];
    const queue = createChatSendQueue({
      runSend: async (item) => {
        calls.push(item.clientId);
        if (item.clientId === 'mid') return makeFailResult('mid-failed');
        return makeOkResult();
      },
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
    });
    queue.enqueue({ clientId: 'first', text: 'one' });
    queue.enqueue({ clientId: 'mid', text: 'fail-me' });
    queue.enqueue({ clientId: 'last', text: 'three' });
    await queue.whenIdle();
    // All three sends ran in order — the failure didn't poison the queue.
    expect(calls).toEqual(['first', 'mid', 'last']);
    const final = statuses.filter((s) => s.status !== 'pending');
    expect(final.map((s) => `${s.clientId}:${s.status}`)).toEqual([
      'first:sent',
      'mid:failed',
      'last:sent',
    ]);
    const failure = final.find((s) => s.clientId === 'mid');
    expect(failure).toBeDefined();
    expect(failure?.error).toBe('mid-failed');
    expect(failure?.httpStatus).toBe(500);
    expect(failure?.reason).toBe('send-failed');
  });

  it('catches runSend throwing and emits `failed` (queue keeps going)', async () => {
    const statuses: ChatSendStatus[] = [];
    const queue = createChatSendQueue({
      runSend: async (item) => {
        if (item.clientId === 'throws') throw new Error('network exploded');
        return makeOkResult();
      },
      emitStatus: (s) => statuses.push(s),
      minSpacingMs: 0,
    });
    queue.enqueue({ clientId: 'before', text: 'a' });
    queue.enqueue({ clientId: 'throws', text: 'b' });
    queue.enqueue({ clientId: 'after', text: 'c' });
    await queue.whenIdle();
    const failed = statuses.find(
      (s) => s.clientId === 'throws' && s.status === 'failed',
    );
    expect(failed).toBeDefined();
    expect(failed?.error).toBe('network exploded');
    const after = statuses.find(
      (s) => s.clientId === 'after' && s.status === 'sent',
    );
    expect(after).toBeDefined();
  });

  it('respects minSpacingMs between consecutive sends', async () => {
    const sleeps: number[] = [];
    const queue = createChatSendQueue({
      runSend: async () => makeOkResult(),
      emitStatus: () => undefined,
      minSpacingMs: 1000,
      // Capture sleep durations instead of actually sleeping so the test
      // stays fast. We resolve immediately and Date.now() doesn't move,
      // so the queue should request ~1000ms sleep before sends 2..N.
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    queue.enqueue({ clientId: 'a', text: 'one' });
    queue.enqueue({ clientId: 'b', text: 'two' });
    queue.enqueue({ clientId: 'c', text: 'three' });
    await queue.whenIdle();
    // First send has no preceding `lastSentAt` so wait=0 — gets skipped
    // because `wait > 0` is false. Sends 2 and 3 trigger a sleep call.
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBe(1000);
    expect(sleeps[1]).toBe(1000);
  });

  it('emits `pending` BEFORE the send starts (renderer can no-op-confirm)', async () => {
    const order: string[] = [];
    const queue = createChatSendQueue({
      runSend: async () => {
        order.push('run');
        return makeOkResult();
      },
      emitStatus: (s) => order.push(`emit:${s.status}`),
      minSpacingMs: 0,
    });
    queue.enqueue({ clientId: 'a', text: 'one' });
    // pending is emitted synchronously by `enqueue`, BEFORE the drain
    // loop kicks. (Drain runs the runSend microtask after enqueue
    // returns, so `order[0]` is reliably `emit:pending`.)
    expect(order[0]).toBe('emit:pending');
    await queue.whenIdle();
    expect(order).toEqual(['emit:pending', 'run', 'emit:sent']);
  });

  it('isolates emitStatus throws so they cannot break the queue', async () => {
    const sentTexts: string[] = [];
    let emitCalls = 0;
    const queue = createChatSendQueue({
      runSend: async (item) => {
        sentTexts.push(item.text);
        return makeOkResult();
      },
      emitStatus: () => {
        emitCalls += 1;
        throw new Error('renderer disconnected');
      },
      minSpacingMs: 0,
    });
    queue.enqueue({ clientId: 'a', text: 'one' });
    queue.enqueue({ clientId: 'b', text: 'two' });
    await queue.whenIdle();
    expect(sentTexts).toEqual(['one', 'two']);
    // pending + sent for each = 4 emits attempted.
    expect(emitCalls).toBe(4);
  });

  it('runSend receives the clientId as opaque (queue passes through verbatim)', async () => {
    const runSend = vi.fn(async () => makeOkResult());
    const queue = createChatSendQueue({
      runSend,
      emitStatus: () => undefined,
      minSpacingMs: 0,
    });
    queue.enqueue({ clientId: 'aabbcc-uuid', text: 'hi' });
    await queue.whenIdle();
    expect(runSend).toHaveBeenCalledTimes(1);
    expect(runSend).toHaveBeenCalledWith({ clientId: 'aabbcc-uuid', text: 'hi' });
  });
});
