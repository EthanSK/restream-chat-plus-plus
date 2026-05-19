import type { ChatSendStatus, SendTextResult } from '../shared/types';

/**
 * v0.1.43 — FIFO send queue for the non-blocking inline chat input.
 *
 * The renderer dispatches `CHAT_SEND_ENQUEUE` and IMMEDIATELY clears the
 * input — it never awaits the actual POST. The queue:
 *
 *   1. Accepts every enqueue (no rejection on backlog — Ethan needs to
 *      spam-send without ever hitting "wait 0.x s" errors).
 *   2. Runs the worker loop ONE send at a time so we never violate
 *      Restream's effective 1 msg/sec rate-limit. The minimum spacing
 *      between attempts is configurable via `minSpacingMs` (default
 *      1000ms — matches the old per-IPC gate).
 *   3. Broadcasts `ChatSendStatus` lifecycle events (`pending` on
 *      enqueue, `sent` on 2xx, `failed` on any error). Failure of one
 *      send NEVER blocks subsequent enqueues — the worker logs + moves on.
 *
 * The queue is intentionally agnostic of the actual send implementation:
 * inject it via `runSend` so unit tests can drive the queue with a fake
 * sender that flips between ok / failure / throws.
 */

export interface QueuedSend {
  clientId: string;
  text: string;
}

export interface ChatSendQueueOptions {
  /**
   * Async function that performs ONE POST and resolves with the result.
   * Wired to `sendChatText` from `chat-send.ts` in production; tests pass
   * a stub.
   */
  runSend: (item: QueuedSend) => Promise<SendTextResult>;
  /**
   * Push a status update to the renderer. Wired to
   * `mainWindow?.webContents.send(IPC.CHAT_SEND_STATUS, status)` in
   * production; tests pass a spy.
   */
  emitStatus: (status: ChatSendStatus) => void;
  /**
   * Minimum gap between consecutive sends, ms. Defaults to 1000 which
   * matches the v0.1.42 per-IPC rate-limit so we don't trip Restream's
   * own throttle on rapid spam. Set to 0 in tests for fast assertions.
   */
  minSpacingMs?: number;
  /**
   * Async sleep helper. Defaults to `setTimeout`; tests pass a
   * synchronous stub or a fake-timers-friendly variant.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional logger for queue-internal events (drain start/end, drops).
   * Defaults to a no-op.
   */
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface ChatSendQueue {
  enqueue: (item: QueuedSend) => void;
  /** Resolves once the queue is fully drained. Test-only convenience. */
  whenIdle: () => Promise<void>;
  /** Synchronous read of the current queue length, for tests. */
  pending: () => number;
  /** True while the worker is mid-send. */
  isRunning: () => boolean;
}

export function createChatSendQueue(opts: ChatSendQueueOptions): ChatSendQueue {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const noopLog: NonNullable<ChatSendQueueOptions['log']> = () => undefined;
  const log = opts.log ?? noopLog;
  const minSpacingMs = opts.minSpacingMs ?? 1000;

  const queue: QueuedSend[] = [];
  let running = false;
  let lastSentAt = 0;
  const idleResolvers: Array<() => void> = [];

  const resolveIdle = (): void => {
    while (idleResolvers.length > 0) {
      const r = idleResolvers.shift();
      try {
        r?.();
      } catch {
        // ignore
      }
    }
  };

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        // Pace: wait until at least `minSpacingMs` has elapsed since the
        // last completed send. Spam-typed messages get sent at the queue's
        // cadence, not the user's typing speed.
        const now = Date.now();
        const wait = Math.max(0, minSpacingMs - (now - lastSentAt));
        if (wait > 0) {
          await sleep(wait);
        }
        let result: SendTextResult;
        try {
          result = await opts.runSend(item);
        } catch (err) {
          result = {
            ok: false,
            reason: 'error',
            error: String((err as Error)?.message ?? err),
          };
          log('queue.send.threw', { clientId: item.clientId, error: result.error });
        }
        lastSentAt = Date.now();
        if (result.ok) {
          try {
            opts.emitStatus({ clientId: item.clientId, status: 'sent' });
          } catch (err) {
            log('queue.emit.threw', {
              clientId: item.clientId,
              phase: 'sent',
              error: String((err as Error)?.message ?? err),
            });
          }
        } else {
          try {
            opts.emitStatus({
              clientId: item.clientId,
              status: 'failed',
              reason: result.reason,
              error: result.error,
              httpStatus: result.status,
            });
          } catch (err) {
            log('queue.emit.threw', {
              clientId: item.clientId,
              phase: 'failed',
              error: String((err as Error)?.message ?? err),
            });
          }
        }
      }
    } finally {
      running = false;
      resolveIdle();
    }
  };

  return {
    enqueue(item: QueuedSend): void {
      queue.push(item);
      // Optimistic "pending" so listeners can confirm the enqueue landed.
      // Renderer already shows the placeholder from the click handler;
      // this is mostly useful for tests + future debug instrumentation.
      try {
        opts.emitStatus({ clientId: item.clientId, status: 'pending' });
      } catch (err) {
        log('queue.emit.threw', {
          clientId: item.clientId,
          phase: 'pending',
          error: String((err as Error)?.message ?? err),
        });
      }
      // Kick the drain loop. We don't await — enqueue is sync from the
      // caller's perspective (it's wired to `ipcMain.on`, not `.handle`).
      void drain();
    },
    whenIdle(): Promise<void> {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise((r) => idleResolvers.push(r));
    },
    pending(): number {
      return queue.length;
    },
    isRunning(): boolean {
      return running;
    },
  };
}
